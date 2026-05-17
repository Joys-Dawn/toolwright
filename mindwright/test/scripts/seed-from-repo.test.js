// Regression test for scripts/seed-from-repo.js. The script is the entrypoint
// for `/mindwright:seed-from-repo`; if it throws, the calling Claude session
// never sees the result and partial data lands.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, cpSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from '../../lib/store.js';
import { projectSlug } from '../../lib/paths.js';
import { describeNextStep } from '../../scripts/seed-from-repo.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PLUGIN_ROOT = resolve(__dirname, '..', '..');
const SCRIPT = join(PLUGIN_ROOT, 'scripts', 'seed-from-repo.js');

function withRepo(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'mindwright-seed-'));
  const prev = process.env.MINDWRIGHT_PROJECT_ROOT;
  process.env.MINDWRIGHT_PROJECT_ROOT = dir;
  try {
    // A git repo with a README. The script no longer shells out to git
    // (git-log seeding was removed) — README.md is the markdown seed source
    // exercised here; the repo is kept so the helper still mirrors a real
    // project layout for the ticket/session-binding tests.
    const gitInit = spawnSync('git', ['init', '-q'], { cwd: dir });
    if (gitInit.status !== 0) {
      throw new Error(`git init failed: ${gitInit.stderr?.toString() || ''}`);
    }
    // Identity in case the test env has none configured.
    spawnSync('git', ['config', 'user.email', 'test@test'], { cwd: dir });
    spawnSync('git', ['config', 'user.name', 'test'], { cwd: dir });
    spawnSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
    writeFileSync(join(dir, 'README.md'), '# Test\n\nA tiny README.\n');
    spawnSync('git', ['add', 'README.md'], { cwd: dir });
    const commit = spawnSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
    if (commit.status !== 0) {
      throw new Error(`git commit failed: ${commit.stderr?.toString() || ''}`);
    }
    return fn(dir);
  } finally {
    if (prev === undefined) delete process.env.MINDWRIGHT_PROJECT_ROOT;
    else process.env.MINDWRIGHT_PROJECT_ROOT = prev;
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* tmp */ }
  }
}

// withBareRepo plants an initialized but otherwise empty git repo: no README,
// no CLAUDE.md, no native memory — i.e. a project with zero seedable sources,
// so the "nothing to seed" branch is reachable.
function withBareRepo(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'mindwright-seed-bare-'));
  const prev = process.env.MINDWRIGHT_PROJECT_ROOT;
  process.env.MINDWRIGHT_PROJECT_ROOT = dir;
  try {
    const gitInit = spawnSync('git', ['init', '-q'], { cwd: dir });
    if (gitInit.status !== 0) {
      throw new Error(`git init failed: ${gitInit.stderr?.toString() || ''}`);
    }
    spawnSync('git', ['config', 'user.email', 'test@test'], { cwd: dir });
    spawnSync('git', ['config', 'user.name', 'test'], { cwd: dir });
    // No README, no commits.
    return fn(dir);
  } finally {
    if (prev === undefined) delete process.env.MINDWRIGHT_PROJECT_ROOT;
    else process.env.MINDWRIGHT_PROJECT_ROOT = prev;
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* tmp */ }
  }
}

test('seed-from-repo seeds README markdown and reports no git_log_collected key', () => {
  withRepo((dir) => {
    const res = spawnSync(process.execPath, [SCRIPT], {
      env: { ...process.env, MINDWRIGHT_PROJECT_ROOT: dir },
      encoding: 'utf8',
    });
    assert.equal(res.status, 0, `script exited non-zero. stderr:\n${res.stderr}`);
    // The script's job is to print a JSON result to stdout. If main() throws
    // (e.g. the historical SEED_SESSION_ID ReferenceError), no JSON lands.
    const parsed = JSON.parse(res.stdout.trim());
    assert.equal(parsed.ok, true);
    assert.ok(parsed.short_rows_inserted >= 1, 'expected at least one row inserted');
    assert.equal(parsed.readme_present, true);
    // git-log seeding was removed entirely — the key must be gone, not false.
    assert.equal(
      'git_log_collected' in parsed,
      false,
      'git_log_collected must no longer be reported',
    );
    // No native memory tree for this throwaway slug → zero native rows.
    assert.equal(parsed.native_memory_files, 0);

    const store = openStore();
    try {
      const rows = store.db.prepare(
        `SELECT source_ref, session_id FROM entries WHERE tier='short' AND active=1`
      ).all();
      // No git-log artifact row should ever exist now.
      assert.equal(
        rows.filter((r) => r.source_ref === 'git-log').length,
        0,
        'git-log row must not be inserted any more',
      );
      // Every row carries the same session id (session-binding regression
      // guard — the original bug was a typo using an undefined identifier).
      const sessionIds = new Set(rows.map((r) => r.session_id));
      assert.equal(sessionIds.size, 1, 'all seeded rows must share one session id');
      assert.equal([...sessionIds][0], parsed.session_id);
    } finally {
      store.close();
    }
  });
});

test('seed-from-repo: bare repo (no README, no CLAUDE.md, no native memory) → nothing to seed', () => {
  withBareRepo((dir) => {
    const res = spawnSync(process.execPath, [SCRIPT], {
      env: { ...process.env, MINDWRIGHT_PROJECT_ROOT: dir },
      encoding: 'utf8',
    });
    assert.equal(res.status, 0, `script exited non-zero. stderr:\n${res.stderr}`);
    const parsed = JSON.parse(res.stdout.trim());
    assert.equal(parsed.ok, true);
    assert.equal('git_log_collected' in parsed, false);
    assert.equal(parsed.readme_present, false);
    assert.equal(parsed.native_memory_files, 0);
    assert.equal(parsed.short_rows_inserted, 0, 'no source material → no rows');
    assert.equal(parsed.skipped_already_seeded, 0);
    assert.equal(parsed.next_step, 'No seed material found.');

    const store = openStore();
    try {
      const seeded = store.db.prepare(
        `SELECT 1 FROM entries WHERE tier='short' AND kind='seed' AND active=1`
      ).all();
      assert.equal(seeded.length, 0, 'bare repo must insert no seed rows');
    } finally {
      store.close();
    }
  });
});

// Setup helper for the ancestor-flag tests: plants a CLAUDE.md in a parent
// directory and inits a git repo under <parent>/project. The MINDWRIGHT
// project root is set to the inner project dir so `collectClaudeMdAncestry`
// has to walk one level up to find the ancestor's CLAUDE.md.
function withAncestorClaudeMd(fn) {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'mindwright-seed-anc-'));
  const projectDir = join(tmpRoot, 'project');
  const prev = process.env.MINDWRIGHT_PROJECT_ROOT;
  process.env.MINDWRIGHT_PROJECT_ROOT = projectDir;
  try {
    // Ancestor CLAUDE.md — one level ABOVE the project root.
    writeFileSync(join(tmpRoot, 'CLAUDE.md'),
      '# Ancestor rule\n\nA personal preference from the global config.\n');
    // Inner project dir with its own git repo + README. Importantly, NO
    // CLAUDE.md inside the project — so any CLAUDE.md rows that appear
    // necessarily came from the ancestor walk.
    spawnSync('git', ['init', '-q', projectDir], { cwd: tmpRoot });
    spawnSync('git', ['config', 'user.email', 'test@test'], { cwd: projectDir });
    spawnSync('git', ['config', 'user.name', 'test'], { cwd: projectDir });
    spawnSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: projectDir });
    writeFileSync(join(projectDir, 'README.md'), '# Inner\n\nA project README.\n');
    spawnSync('git', ['add', 'README.md'], { cwd: projectDir });
    spawnSync('git', ['commit', '-q', '-m', 'init'], { cwd: projectDir });
    return fn({ projectDir, ancestorClaudeMd: join(tmpRoot, 'CLAUDE.md') });
  } finally {
    if (prev === undefined) delete process.env.MINDWRIGHT_PROJECT_ROOT;
    else process.env.MINDWRIGHT_PROJECT_ROOT = prev;
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* tmp */ }
  }
}

test('seed-from-repo WITHOUT --include-ancestors does NOT ingest an ancestor CLAUDE.md (privacy gate)', () => {
  // Default mode is project-root-only because ancestor walking would pull in
  // the user's global ~/.claude/CLAUDE.md (personal preferences, account
  // handles, machine details). A regression in argv handling that silently
  // flipped the default would be a privacy leak — pin both the JSON-reported
  // mode and the row absence in the DB.
  withAncestorClaudeMd(({ projectDir, ancestorClaudeMd }) => {
    const res = spawnSync(process.execPath, [SCRIPT], {
      env: { ...process.env, MINDWRIGHT_PROJECT_ROOT: projectDir },
      encoding: 'utf8',
    });
    assert.equal(res.status, 0, `script exited non-zero. stderr:\n${res.stderr}`);
    const parsed = JSON.parse(res.stdout.trim());
    assert.equal(parsed.ok, true);
    assert.equal(parsed.claude_md_mode, 'project-root',
      'JSON must report project-root mode when --include-ancestors is absent');
    assert.equal(parsed.claude_md_files, 0,
      'no CLAUDE.md inside the project → claude_md_files=0 (ancestor must NOT be counted)');

    const store = openStore();
    try {
      const ancestorRows = store.db.prepare(
        `SELECT 1 FROM entries WHERE source_ref LIKE ? AND active=1`,
      ).all(`${ancestorClaudeMd}%`);
      assert.equal(ancestorRows.length, 0,
        'ancestor CLAUDE.md content must NOT land in entries without --include-ancestors');
    } finally {
      store.close();
    }
  });
});

test('seed-from-repo binds rows to the live ticket session_id when a fresh ticket is present', () => {
  // The script reads the most recent ticket via daemon-ticket.mjs#readActiveTicket
  // and, if one is fresh, stamps that session_id on every seeded row so the
  // calling Claude session's default `/mindwright:dream` (scope=session)
  // drains them. Without this test, a regression in the bind (wrong field
  // plumbed into insertEntry, or argv parsing eating the session id) would
  // leave rows under the synthetic FALLBACK_SEED_SESSION_ID and they'd be
  // invisible to scope=session — silent and only catchable by reading the
  // dream-empty result.
  withRepo((dir) => {
    const liveSessionId = `live-test-session-${process.pid}-${Date.now()}`;
    // Plant a ticket file directly. Format mirrors daemon-ticket.mjs#writeTicket:
    // filename "<claudePid>-<hookPid>.json" under <projectRoot>/.claude/mindwright/tickets/.
    // The ticket reader uses file mtime (not created_at) for freshness, so a
    // sync write here is automatically fresh.
    const ticketsDir = join(dir, '.claude', 'mindwright', 'tickets');
    mkdirSync(ticketsDir, { recursive: true });
    const ticketPath = join(ticketsDir, `${process.ppid}-${process.pid}.json`);
    writeFileSync(ticketPath, JSON.stringify({
      session_id: liveSessionId,
      pipe_path: process.platform === 'win32'
        ? `\\\\.\\pipe\\mindwright-${liveSessionId}`
        : `/tmp/mindwright-${liveSessionId}.sock`,
      claude_pid: process.ppid,
      hook_pid: process.pid,
      created_at: Date.now(),
    }));

    const res = spawnSync(process.execPath, [SCRIPT], {
      env: { ...process.env, MINDWRIGHT_PROJECT_ROOT: dir },
      encoding: 'utf8',
    });
    assert.equal(res.status, 0, `script exited non-zero. stderr:\n${res.stderr}`);
    const parsed = JSON.parse(res.stdout.trim());
    assert.equal(parsed.ok, true);
    assert.equal(parsed.session_id, liveSessionId,
      'script must bind seeded rows to the live ticket session_id, not the fallback');
    // The "live session present" branch picks the session-scoped dream guidance.
    assert.match(parsed.next_step, /\/mindwright:dream/);
    assert.ok(!/scope="all"/.test(parsed.next_step),
      `live-session next_step must NOT mention scope="all"; got: ${parsed.next_step}`);

    const store = openStore();
    try {
      const rows = store.db.prepare(
        `SELECT DISTINCT session_id FROM entries WHERE tier='short' AND active=1`,
      ).all();
      assert.equal(rows.length, 1, 'all seeded rows must share one session id');
      assert.equal(rows[0].session_id, liveSessionId,
        'seeded rows must land under the live ticket session id, not "seed-from-repo"');
    } finally {
      store.close();
    }
  });
});

test('seed-from-repo WITH --include-ancestors ingests the ancestor CLAUDE.md', () => {
  // Positive pair: the flag is honored end-to-end through the script's
  // argv parsing into the helper and the inserted row's source_ref points
  // at the ancestor path.
  withAncestorClaudeMd(({ projectDir, ancestorClaudeMd }) => {
    const res = spawnSync(process.execPath, [SCRIPT, '--include-ancestors'], {
      env: { ...process.env, MINDWRIGHT_PROJECT_ROOT: projectDir },
      encoding: 'utf8',
    });
    assert.equal(res.status, 0, `script exited non-zero. stderr:\n${res.stderr}`);
    const parsed = JSON.parse(res.stdout.trim());
    assert.equal(parsed.ok, true);
    assert.equal(parsed.claude_md_mode, 'ancestors',
      'JSON must report ancestors mode when --include-ancestors is passed');
    assert.ok(parsed.claude_md_files >= 1,
      `expected at least one CLAUDE.md collected; got ${parsed.claude_md_files}`);

    const store = openStore();
    try {
      const ancestorRows = store.db.prepare(
        `SELECT content FROM entries WHERE source_ref LIKE ? AND active=1`,
      ).all(`${ancestorClaudeMd}%`);
      assert.ok(ancestorRows.length >= 1,
        'ancestor CLAUDE.md must land in entries when --include-ancestors is set');
      assert.match(ancestorRows[0].content, /Ancestor rule/);
    } finally {
      store.close();
    }
  });
});

// Plants a native-memory tree at the exact path the spawned script will
// resolve: <MINDWRIGHT_CLAUDE_PROJECTS_DIR>/<encoded-cwd>/memory. The slug is
// derived via the SAME paths.js helper the script uses, so parent and child
// agree without duplicating the encoding regex here.
function withNativeMemory(dir, files) {
  const projectsTmp = mkdtempSync(join(tmpdir(), 'mindwright-seed-proj-'));
  const memDir = join(projectsTmp, projectSlug(dir), 'memory');
  mkdirSync(memDir, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(memDir, name), body);
  }
  return { projectsTmp, memDir };
}

test('seed-from-repo ingests native memory rows with event_ts and memory: source_ref', () => {
  withRepo((dir) => {
    const { projectsTmp } = withNativeMemory(dir, {
      'MEMORY.md': '- [a fact](a.md) — hook\n',
      'a_fact.md':
        '---\nname: a-fact\ndescription: A seeded native fact\n' +
        'date: 2022-07-08T09:10:11.000Z\nmetadata:\n  type: project\n---\n\n' +
        'The build uses esbuild, not webpack.\n',
    });
    try {
      const res = spawnSync(process.execPath, [SCRIPT], {
        env: {
          ...process.env,
          MINDWRIGHT_PROJECT_ROOT: dir,
          MINDWRIGHT_CLAUDE_PROJECTS_DIR: projectsTmp,
        },
        encoding: 'utf8',
      });
      assert.equal(res.status, 0, `script exited non-zero. stderr:\n${res.stderr}`);
      const parsed = JSON.parse(res.stdout.trim());
      assert.equal(parsed.ok, true);
      assert.equal(parsed.native_memory_files, 1,
        'MEMORY.md must be skipped; exactly one native row collected');

      const store = openStore();
      try {
        const rows = store.db.prepare(
          `SELECT content, source_ref, event_ts FROM entries
             WHERE tier='short' AND kind='seed' AND active=1
               AND source_ref LIKE 'memory:%'`,
        ).all();
        assert.equal(rows.length, 1, 'exactly one memory: row');
        assert.equal(rows[0].source_ref, 'memory:a_fact.md');
        assert.match(rows[0].content, /A seeded native fact/);
        assert.match(rows[0].content, /esbuild, not webpack/);
        assert.equal(rows[0].event_ts, '2022-07-08T09:10:11.000Z',
          'native memory row must carry the frontmatter date as event_ts');
        // No MEMORY.md row leaked in.
        const idxRow = store.db.prepare(
          `SELECT 1 FROM entries WHERE source_ref = 'memory:MEMORY.md'`,
        ).all();
        assert.equal(idxRow.length, 0, 'MEMORY.md index must never be seeded');
      } finally {
        store.close();
      }
    } finally {
      rmSync(projectsTmp, { recursive: true, force: true });
    }
  });
});

test('seed-from-repo is idempotent: a second run inserts nothing and does not duplicate', () => {
  withRepo((dir) => {
    const { projectsTmp } = withNativeMemory(dir, {
      'note.md': '---\ndescription: native note\n---\n\noriginal native body\n',
    });
    const env = {
      ...process.env,
      MINDWRIGHT_PROJECT_ROOT: dir,
      MINDWRIGHT_CLAUDE_PROJECTS_DIR: projectsTmp,
    };
    try {
      const run = () =>
        JSON.parse(
          spawnSync(process.execPath, [SCRIPT], { env, encoding: 'utf8' })
            .stdout.trim(),
        );

      const first = run();
      assert.ok(first.short_rows_inserted >= 2,
        'first run seeds README markdown + the native note');
      assert.equal(first.skipped_already_seeded, 0);

      const store = openStore();
      let countAfterFirst;
      try {
        countAfterFirst = store.db.prepare(
          `SELECT COUNT(*) c FROM entries WHERE tier='short' AND kind='seed' AND active=1`,
        ).get().c;
      } finally {
        store.close();
      }

      // Edit BOTH a markdown source and the native file before the 2nd run.
      // The guard accepts staleness (skip-whole-file if any active short seed
      // row already exists for that prefix) rather than re-chunking on edits.
      writeFileSync(join(dir, 'README.md'), '# Test\n\nEDITED readme body.\n');
      writeFileSync(
        join(projectsTmp, projectSlug(dir), 'memory', 'note.md'),
        '---\ndescription: native note\n---\n\nEDITED native body\n',
      );

      const second = run();
      assert.equal(second.short_rows_inserted, 0,
        'second run must insert nothing (every source already seeded)');
      assert.ok(second.skipped_already_seeded >= 2,
        'README + native note both skipped');
      assert.match(second.next_step, /\/mindwright:dream/,
        'all-skipped next_step still points at consolidation');
      // Honesty guard (behavior-4): both sources were EDITED before this
      // run. The message must NOT assert the (edited) content is "already
      // present" — that masked silent non-capture of the user's edits — and
      // must explicitly convey the edits are not captured yet.
      assert.ok(!/already present/i.test(second.next_step),
        `skipped-file next_step must not falsely claim edited content is "already present"; got: ${second.next_step}`);
      assert.match(second.next_step, /not captured yet/i,
        `skipped-file next_step must state edits are not captured yet; got: ${second.next_step}`);

      const store2 = openStore();
      try {
        const countAfterSecond = store2.db.prepare(
          `SELECT COUNT(*) c FROM entries WHERE tier='short' AND kind='seed' AND active=1`,
        ).get().c;
        assert.equal(countAfterSecond, countAfterFirst,
          'no duplicate seed rows after the idempotent re-run');
        // The edited bodies must NOT have been re-chunked in (staleness accepted).
        const edited = store2.db.prepare(
          `SELECT 1 FROM entries WHERE content LIKE '%EDITED%' AND tier='short' AND kind='seed'`,
        ).all();
        assert.equal(edited.length, 0,
          'edited content must not double-seed before the prior rows drain');
      } finally {
        store2.close();
      }
    } finally {
      rmSync(projectsTmp, { recursive: true, force: true });
    }
  });
});

// best-practices-4: the next-step message was a 3-level nested ternary with a
// 7-line comment wedged into the expression — its user-facing contract was
// not independently testable. describeNextStep is now a pure exported helper;
// these pin each of the four cases and the guard-clause precedence.
test('describeNextStep: rows seeded under a live session → plain consolidate hint', () => {
  assert.equal(
    describeNextStep({ total: 3, droppedUnderCallingSession: true, skippedFiles: 0 }),
    'Run /mindwright:dream to consolidate the seeded rows into long-term facts.',
  );
});

test('describeNextStep: rows seeded with NO live session → scope="all" guidance + fallback id', () => {
  const msg = describeNextStep({ total: 5, droppedUnderCallingSession: false, skippedFiles: 0 });
  assert.match(msg, /No live Claude session detected/);
  assert.match(msg, /scope="all"/);
  // The fallback session id is part of the user-facing contract — pin it.
  assert.match(msg, /rows landed under "seed-from-repo"/);
});

test('describeNextStep: nothing new but files skipped → idempotency/staleness explainer', () => {
  const msg = describeNextStep({ total: 0, droppedUnderCallingSession: false, skippedFiles: 4 });
  assert.match(msg, /^4 source file\(s\) already have un-consolidated/);
  assert.match(msg, /edits made to them since they were first seeded are NOT captured/);
  assert.match(msg, /re-run \/mindwright:seed-from-repo to pick up edited files/);
});

test('describeNextStep: nothing seeded and nothing skipped → "No seed material found."', () => {
  assert.equal(
    describeNextStep({ total: 0, droppedUnderCallingSession: false, skippedFiles: 0 }),
    'No seed material found.',
  );
});

test('describeNextStep: total>0 takes precedence over skippedFiles>0 (guard-clause order)', () => {
  // The original ternary tested `total > 0` first; the extracted guard order
  // must preserve that — a run that inserted rows AND skipped some files
  // still reports the consolidate hint, never the skipped-files explainer.
  const msg = describeNextStep({ total: 2, droppedUnderCallingSession: true, skippedFiles: 9 });
  assert.equal(msg, 'Run /mindwright:dream to consolidate the seeded rows into long-term facts.');
});

test('deps-absent: emits the deps_not_installed structured result and never calls openStore', () => {
  // A caller parses this stdout JSON to decide whether to retry, so the exact
  // error code + shape is a contract. Every other test here spawns the real
  // SCRIPT in the deps-present dev tree, so the deps-absent branch was never
  // run. Reproduce a faithful marketplace copy: scripts/ + lib/ NO
  // node_modules → the copy's depsInstalled() is false (paths.js derives
  // PLUGIN_ROOT from its own location → the sandbox). store.js is copied but
  // never imported (the branch returns before `await import('../lib/store.js')`).
  // MINDWRIGHT_AUTO_INSTALL=false keeps maybeAutoInstall() from spawning a
  // real npm install; the result contract is independent of that call.
  const pluginCopy = mkdtempSync(join(tmpdir(), 'mindwright-seed-plugin-'));
  const projectDir = mkdtempSync(join(tmpdir(), 'mindwright-seed-da-proj-'));
  try {
    // lib/ + scripts/ only (no node_modules): seed-from-repo.js's static
    // import graph (incl. lib/daemon-ticket.mjs) is dep-free, so the copy's
    // depsInstalled() is false and it hits the deps-absent branch rather
    // than an ESM-resolution crash.
    cpSync(join(PLUGIN_ROOT, 'lib'), join(pluginCopy, 'lib'), { recursive: true });
    cpSync(join(PLUGIN_ROOT, 'scripts'), join(pluginCopy, 'scripts'), { recursive: true });

    const res = spawnSync(process.execPath, [join(pluginCopy, 'scripts', 'seed-from-repo.js')], {
      encoding: 'utf8',
      timeout: 20000,
      env: {
        ...process.env,
        MINDWRIGHT_PROJECT_ROOT: projectDir,
        MINDWRIGHT_AUTO_INSTALL: 'false',
        MINDWRIGHT_INSTALL_LOCK_DIR: pluginCopy,
      },
    });

    assert.equal(res.status, 0, `branch returns cleanly (no process.exit); got status=${res.status} stderr=${res.stderr}`);
    const parsed = JSON.parse(res.stdout.trim());
    assert.equal(parsed.ok, false);
    assert.equal(parsed.error, 'deps_not_installed');
    assert.equal(parsed.short_rows_inserted, 0);
    assert.equal(typeof parsed.detail, 'string');
    assert.match(parsed.detail, /mindwright-install-.*\.log/, 'detail must reference installLogPath()');
    assert.match(res.stderr, /native dependencies not installed yet/, 'the human message goes to stderr');
    assert.equal(
      existsSync(join(projectDir, '.claude', 'mindwright', 'mindwright.db')),
      false,
      'deps-absent branch must return before openStore (no DB file created)',
    );
  } finally {
    for (const d of [pluginCopy, projectDir]) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* tmp */ }
    }
  }
});
