// Mirror render tests. Exercise each section by seeding the DB then asserting
// the produced markdown contains the expected fragments. We test fragments
// rather than exact bytes because timestamps in the render are non-deterministic.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, rmSync, readFileSync, existsSync,
  writeFileSync, symlinkSync, mkdirSync, lstatSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../lib/store.js';
import {
  renderAll,
  renderRecent,
  renderPreferences,
  renderProjectFacts,
  renderEpisodes,
  renderHeuristics,
} from '../lib/mirrors.js';
import { mirrorsDir } from '../lib/paths.js';

async function withStore(fn) {
  // Snapshot/restore MINDWRIGHT_PROJECT_ROOT so the env var doesn't leak
  // across tests (and doesn't end up pointing at a deleted tmp dir for the
  // remainder of the node --test run).
  const prevProjectRoot = process.env.MINDWRIGHT_PROJECT_ROOT;
  const dir = mkdtempSync(join(tmpdir(), 'mindwright-mir-'));
  process.env.MINDWRIGHT_PROJECT_ROOT = dir;
  const store = openStore();
  try {
    return await fn(store, dir);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
    if (prevProjectRoot === undefined) {
      delete process.env.MINDWRIGHT_PROJECT_ROOT;
    } else {
      process.env.MINDWRIGHT_PROJECT_ROOT = prevProjectRoot;
    }
  }
}

test('renderRecent shows newest short-term entries first', async () => {
  await withStore((store) => {
    // Two tight inserts may share a millisecond. The query orders by
    // (created_at DESC, id DESC) so the second insert (higher id) wins the
    // tie deterministically — pinning that behavior here without spinning.
    store.insertEntry({ tier: 'short', kind: 'thinking', content: 'older', sessionId: 's' });
    store.insertEntry({ tier: 'short', kind: 'thinking', content: 'newer', sessionId: 's' });

    const md = renderRecent(store, { limit: 10 });
    assert.match(md, /# Recent observations/);
    const newerIdx = md.indexOf('newer');
    const olderIdx = md.indexOf('older');
    assert.ok(newerIdx >= 0 && olderIdx >= 0);
    assert.ok(newerIdx < olderIdx, 'newer should appear before older');
  });
});

test('renderRecent handles empty store gracefully', async () => {
  await withStore((store) => {
    const md = renderRecent(store);
    assert.match(md, /\(none\)/);
  });
});

test('renderPreferences only includes long-term fact/user active rows', async () => {
  await withStore((store) => {
    store.insertEntry({
      tier: 'long', category: 'fact', scope: 'user', kind: 'fact',
      content: 'the user prefers tabs', sessionId: 's', confidence: 0.85,
    });
    store.insertEntry({
      tier: 'long', category: 'fact', scope: 'project', kind: 'fact',
      content: 'project uses TypeScript', sessionId: 's',
    });
    const md = renderPreferences(store);
    assert.match(md, /prefers tabs/);
    assert.match(md, /confidence 0\.85/);
    assert.ok(!md.includes('TypeScript'));
  });
});

test('renderPreferences shows null confidence as em-dash', async () => {
  await withStore((store) => {
    store.insertEntry({
      tier: 'long', category: 'fact', scope: 'user', kind: 'fact',
      content: 'unknown-confidence pref', sessionId: 's',
    });
    const md = renderPreferences(store);
    assert.match(md, /confidence —/);
  });
});

test('renderProjectFacts only includes long-term fact/project active rows', async () => {
  await withStore((store) => {
    store.insertEntry({
      tier: 'long', category: 'fact', scope: 'project', kind: 'fact',
      content: 'auth uses Supabase', sessionId: 's',
    });
    const archived = store.insertEntry({
      tier: 'long', category: 'fact', scope: 'project', kind: 'fact',
      content: 'deprecated note', sessionId: 's',
    });
    store.softArchive(archived);
    const md = renderProjectFacts(store);
    assert.match(md, /Supabase/);
    assert.ok(!md.includes('deprecated note'));
  });
});

test('renderEpisodes only includes long-term episodic active rows (any scope)', async () => {
  await withStore((store) => {
    store.insertEntry({
      tier: 'long', category: 'episodic', scope: 'project', kind: 'fact',
      content: 'the 2026-04-12 cache outage taught us to invalidate aggressively',
      sessionId: 's',
    });
    store.insertEntry({
      tier: 'long', category: 'fact', scope: 'project', kind: 'fact',
      content: 'unrelated project fact', sessionId: 's',
    });
    const md = renderEpisodes(store);
    assert.match(md, /# Episodes/);
    assert.match(md, /cache outage/);
    assert.ok(!md.includes('unrelated project fact'));
  });
});

test('renderHeuristics scopes to one role via scope=role:<role>', async () => {
  await withStore((store) => {
    store.insertEntry({
      tier: 'long', category: 'procedural', scope: 'role:planner', kind: 'fact',
      content: 'planner: read SPEC before plan', sessionId: 's',
    });
    store.insertEntry({
      tier: 'long', category: 'procedural', scope: 'role:consolidator', kind: 'fact',
      content: 'consolidator: prefer terseness', sessionId: 's',
    });
    const md = renderHeuristics(store, 'planner');
    assert.match(md, /SPEC/);
    assert.ok(!md.includes('terseness'));
  });
});

test('renderAll writes every mirror file kind', async () => {
  await withStore((store) => {
    store.insertEntry({ tier: 'short', kind: 'thinking', content: 'obs', sessionId: 's' });
    store.insertEntry({
      tier: 'long', category: 'fact', scope: 'user', kind: 'fact',
      content: 'pref a', sessionId: 's', confidence: 0.5,
    });
    store.insertEntry({
      tier: 'long', category: 'fact', scope: 'project', kind: 'fact',
      content: 'fact a', sessionId: 's',
    });
    store.insertEntry({
      tier: 'long', category: 'episodic', scope: 'project', kind: 'fact',
      content: 'lesson a', sessionId: 's',
    });
    store.insertEntry({
      tier: 'long', category: 'procedural', scope: 'role:consolidator', kind: 'fact',
      content: 'heuristic a', sessionId: 's',
    });
    renderAll(store);
    const base = mirrorsDir();
    assert.ok(existsSync(join(base, 'recent.md')));
    assert.ok(existsSync(join(base, 'preferences.md')));
    assert.ok(existsSync(join(base, 'project.md')));
    assert.ok(existsSync(join(base, 'episodes.md')));
    assert.ok(existsSync(join(base, 'agents', 'consolidator', 'heuristics.md')));

    const heuristicsBody = readFileSync(join(base, 'agents', 'consolidator', 'heuristics.md'), 'utf8');
    assert.match(heuristicsBody, /heuristic a/);
  });
});

test('renderAll is a no-op on unchanged content (writeIfChanged)', async () => {
  await withStore((store) => {
    store.insertEntry({
      tier: 'long', category: 'fact', scope: 'project', kind: 'fact',
      content: 'stable', sessionId: 's',
    });
    renderAll(store);
    const factsPath = join(mirrorsDir(), 'project.md');
    const before = readFileSync(factsPath, 'utf8');
    renderAll(store);
    const after = readFileSync(factsPath, 'utf8');
    assert.equal(before, after);
  });
});

test('hook fallback resync path — render reflects post-sweeper state', async () => {
  await withStore((store) => {
    // Simulate hook fallback path: row inserted without embedding (NULL-embed),
    // then the sweeper-equivalent insert+embed later. Renders should reflect
    // the long-term row regardless of how the embedding arrived.
    const id = store.insertEntry({
      tier: 'long', category: 'fact', scope: 'project', kind: 'fact',
      content: 'eventually-embedded fact', sessionId: 's',
    });
    // "sweeper" attaches the embedding after the row already exists
    const e = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) e[i] = Math.sin(i);
    let n = 0;
    for (let i = 0; i < 1024; i++) n += e[i] * e[i];
    n = Math.sqrt(n);
    for (let i = 0; i < 1024; i++) e[i] /= n;
    store.writeEmbedding(id, e);

    renderAll(store);
    const md = readFileSync(join(mirrorsDir(), 'project.md'), 'utf8');
    assert.match(md, /eventually-embedded fact/);
  });
});

test('renderAll refuses to follow a symlink planted at a mirror path', async (t) => {
  // Defense-in-depth: a co-located attacker (or a stray prior run) could plant
  // a symlink at mirrors/recent.md pointing at a file outside the project.
  // Mirror content includes partially-controllable text (retained fact bodies),
  // so the write would otherwise become a write-where primitive.
  let skipped = false;
  await withStore((store, dir) => {
    // Symlinks on Windows require admin / dev mode in some environments. If
    // the platform refuses to create the symlink at all, mark the test as
    // skipped (not silently-passed) so the runner reports it visibly — the
    // protection is only reachable on POSIX / dev-mode Windows.
    let target;
    try {
      const mdir = join(dir, '.claude', 'mindwright', 'mirrors');
      mkdirSync(mdir, { recursive: true });
      target = join(dir, 'sensitive.txt');
      writeFileSync(target, 'original contents — should not be overwritten');
      symlinkSync(target, join(mdir, 'recent.md'));
    } catch (err) {
      if (err && (err.code === 'EPERM' || err.code === 'EACCES')) {
        skipped = true;
        return;
      }
      throw err;
    }
    // Make sure renderAll actually has content to render so it tries to write.
    store.insertEntry({ tier: 'short', kind: 'thinking', content: 'x', sessionId: 's' });
    assert.throws(() => renderAll(store), /refusing to write through symlink/i);
    // The sensitive file is unchanged.
    const after = readFileSync(target, 'utf8');
    assert.equal(after, 'original contents — should not be overwritten');
    // And the planted symlink is still a symlink, not replaced with a regular file.
    const st = lstatSync(join(dir, '.claude', 'mindwright', 'mirrors', 'recent.md'));
    assert.ok(st.isSymbolicLink());
  });
  // Skip from the outer scope so node:test's reporter sees the "skipped"
  // result — t.skip() inside withStore can't propagate cleanly because the
  // helper resolves before the test body returns.
  if (skipped) {
    t.skip('symlink creation requires elevated permissions on this platform');
  }
});

test('renderAll refuses to write outside the mirrors dir for a malicious role scope', async () => {
  // Defense-in-depth: the MCP write boundary already validates role against
  // ROLE_PATTERN, but if a row somehow lands in the DB with a traversal payload
  // (direct SQL, legacy row, future bug), renderAll must skip it without
  // touching the filesystem outside mirrorsDir.
  await withStore((store, dir) => {
    // Bypass insertEntry (which would scope-validate) via raw SQL so we can
    // simulate a corrupted row.
    store.db.prepare(`
      INSERT INTO entries (tier, category, scope, kind, content, session_id, created_at)
      VALUES ('long', 'procedural', 'role:../../../escapee', 'fact', 'malicious heuristic', 's', ?)
    `).run(new Date().toISOString());
    // Also insert a benign row so renderAll has something to render successfully.
    store.insertEntry({
      tier: 'long', category: 'procedural', scope: 'role:planner', kind: 'fact',
      content: 'benign heuristic', sessionId: 's',
    });
    renderAll(store);
    const base = mirrorsDir();
    // Benign role rendered as expected.
    assert.ok(existsSync(join(base, 'agents', 'planner', 'heuristics.md')));
    // Malicious role did NOT produce a file. The traversal target would have
    // been <base>/agents/../../../escapee/heuristics.md → escapee/heuristics.md
    // somewhere above the mirrors dir. Check both the literal subdir under
    // agents and any sibling-of-dir target.
    assert.ok(!existsSync(join(base, 'agents', '..', '..', '..', 'escapee')));
    assert.ok(!existsSync(join(dir, '..', 'escapee')));
    // Nothing outside the mindwright project root was created.
    assert.ok(!existsSync(join(dir, '..', '..', '..', 'escapee')));
  });
});

test('writeIfChanged uses temp-file + rename so concurrent cross-process writes never tear the file', async () => {
  // Regression: a direct writeFileSync is not atomic. Two writers calling
  // renderAll concurrently could produce a torn file with fragments of
  // both. With the temp-file + rename pattern each writer's bytes land
  // intact and one of them wins the rename last-writer-wins — the file
  // on disk is always one writer's complete content, never an interleave.
  //
  // The previous version of this test wrapped synchronous renderAll() calls
  // in Promise.resolve and ran them through Promise.all, which is NOT
  // concurrent — the calls completed serially inside Array.from before any
  // promise was ever awaited. Genuine concurrency requires separate OS
  // processes whose renameSync syscalls actually race in the kernel. We
  // achieve that by spawning N child Node processes that each open their
  // own better-sqlite3 connection and invoke renderAll on the same DB and
  // mirrors dir.
  await withStore(async (store, dir) => {
    store.insertEntry({
      tier: 'long', category: 'fact', scope: 'project', kind: 'fact',
      content: 'A'.repeat(2000), sessionId: 's',
    });
    // Keep the parent's store open — withStore's finally closes it. WAL mode
    // lets each child open its own connection and contend at the OS level.
    const { spawn } = await import('node:child_process');
    const { pathToFileURL } = await import('node:url');
    // Node 24+ rejects bare absolute paths in dynamic ESM import; convert
    // to file:// URLs.
    const storeUrl = pathToFileURL(join(process.cwd(), 'lib/store.js')).href;
    const mirrorsUrl = pathToFileURL(join(process.cwd(), 'lib/mirrors.js')).href;
    const workerScript = `
      import { openStore } from '${storeUrl}';
      import { renderAll } from '${mirrorsUrl}';
      const s = openStore();
      try { renderAll(s); } finally { s.close(); }
    `;
    // 3 children is enough to demonstrate cross-process atomicity (two
    // racers prove the property; a third writer reduces the chance of a
    // false-pass when timing happens to serialize the renames). 8 was a
    // brittle-and-slow choice — each child cold-starts Node + loads
    // better-sqlite3 + runs migrations, so the cost scales linearly while
    // the additional confidence past N=3 is marginal.
    const N = 3;
    const procs = Array.from({ length: N }, () =>
      new Promise((resolve, reject) => {
        const child = spawn(
          process.execPath,
          ['--input-type=module', '-e', workerScript],
          {
            env: { ...process.env, MINDWRIGHT_PROJECT_ROOT: dir },
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );
        let stderr = '';
        child.stderr.on('data', (c) => { stderr += c.toString('utf8'); });
        child.on('close', (code) => code === 0
          ? resolve()
          : reject(new Error(`child exited ${code}: ${stderr}`)));
        child.on('error', reject);
      })
    );
    await Promise.all(procs);

    const md = readFileSync(join(mirrorsDir(), 'project.md'), 'utf8');
    // Must contain the FULL run of A's, never half + half garbage from a
    // torn write that interleaved two writers' bytes.
    assert.ok(md.includes('A'.repeat(2000)),
      `expected full A-run in mirror; got first 200 chars: ${md.slice(0, 200)}`);
    // And no .tmp.<pid> orphan should remain — every successful rename moved
    // the temp file out of existence, and a failed rename should clean up.
    const { readdirSync } = await import('node:fs');
    const leftovers = readdirSync(mirrorsDir()).filter((f) => f.includes('.tmp.'));
    assert.deepEqual(leftovers, [], `unexpected tmp orphans: ${leftovers.join(', ')}`);
  });
});
