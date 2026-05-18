// Coverage for scripts/status.js: the no-db short-circuit, the populated
// branch reading live store counts, and the dual stderr/stdout output
// shape that /mindwright:status downstream pipes parse.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, cpSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PLUGIN_ROOT = resolve(__dirname, '..', '..');
const SCRIPT = join(PLUGIN_ROOT, 'scripts', 'status.js');

function withFreshRoots(fn) {
  const projectDir = mkdtempSync(join(tmpdir(), 'mindwright-status-proj-'));
  const homeDir = mkdtempSync(join(tmpdir(), 'mindwright-status-home-'));
  const cacheDir = mkdtempSync(join(tmpdir(), 'mindwright-status-cache-'));
  const cleanup = () => {
    try { rmSync(projectDir, { recursive: true, force: true }); } catch { /* tmp */ }
    try { rmSync(homeDir, { recursive: true, force: true }); } catch { /* tmp */ }
    try { rmSync(cacheDir, { recursive: true, force: true }); } catch { /* tmp */ }
  };
  let result;
  try {
    result = fn({ projectDir, homeDir, cacheDir });
  } catch (err) {
    cleanup();
    throw err;
  }
  // Async-aware: if the inner body returned a Promise, defer cleanup until
  // it settles so we don't rm the tmp dirs while the test is still using
  // them. Sync bodies hit the immediate-cleanup branch.
  if (result && typeof result.then === 'function') {
    return result.then(
      (v) => { cleanup(); return v; },
      (err) => { cleanup(); throw err; },
    );
  }
  cleanup();
  return result;
}

function runStatus(projectDir, homeDir, cacheDir) {
  return spawnSync(process.execPath, [SCRIPT], {
    encoding: 'utf8',
    env: {
      ...process.env,
      MINDWRIGHT_PROJECT_ROOT: projectDir,
      // Redirect Node's homedir() in the child so the Claude transcript dirs
      // (and the POSIX model-daemon socket default, ~/.cache/mindwright) stay
      // under a tmp we control. HOME (POSIX) + USERPROFILE (Windows) covers
      // both. isSessionLive() reads tickets under MINDWRIGHT_PROJECT_ROOT, not
      // HOME, so the isolated empty projectDir already makes it false.
      HOME: homeDir,
      USERPROFILE: homeDir,
      // The Windows model-daemon socket is a MACHINE-GLOBAL named pipe — NOT
      // under HOME — so a HOME redirect alone wouldn't stop isModelDaemonAlive()
      // from probing (and connecting to) a real daemon a dev has running.
      // Override the socket wholesale to a bogus path with no listener so the
      // probe deterministically resolves false on every platform.
      MINDWRIGHT_MODEL_DAEMON_SOCK: join(homeDir, 'no-such-modeld.sock'),
      // The embedder/reranker probe (baseStatus → modelCacheDir) reads
      // MINDWRIGHT_MODEL_CACHE_DIR; point it at a tmp dir so the test — not
      // the populated real dev-tree model-cache — decides cached/not-cached.
      MINDWRIGHT_MODEL_CACHE_DIR: cacheDir,
    },
  });
}

// transformers.js lays each repo out as <cacheDir>/<org>/<name> — NOT the
// Python-hub models--org--name convention. Plant the exact dirs
// embedderCached() and the reranker check in scripts/status.js probe.
function plantModelCache(cacheDir, repos) {
  for (const [org, name] of repos) {
    mkdirSync(join(cacheDir, org, name), { recursive: true });
  }
}

test('no-db short-circuit emits db_exists=false, zero counts, and a note', () => {
  withFreshRoots(({ projectDir, homeDir, cacheDir }) => {
    const res = runStatus(projectDir, homeDir, cacheDir);
    assert.equal(res.status, 0, `expected exit 0; got ${res.status}. stderr=${res.stderr}`);
    const out = JSON.parse(res.stdout.trim().split('\n').pop());
    assert.equal(out.db_exists, false, 'db_exists should be false on a fresh project');
    assert.equal(out.short_count, 0);
    assert.equal(out.long_count, 0);
    assert.deepEqual(out.by_category, {});
    assert.equal(out.last_consolidation, null);
    assert.equal(out.pending_embeds, 0);
    assert.equal(out.oldest_preference_at, null, 'no preferences yet on a fresh project');
    assert.deepEqual(out.consolidators, [], 'no spawned consolidators on a fresh project');
    assert.equal(typeof out.note, 'string', 'note should be set explaining DB absence');
    assert.notEqual(out.note, '', 'note should be set explaining DB absence');
    // Sanity: the openStore() call must NOT have been made — if it had, the
    // db would now exist on disk because openStore runs migrations.
    assert.equal(
      existsSync(join(projectDir, '.claude', 'mindwright', 'mindwright.db')),
      false,
      'no-db branch must not call openStore (which would create the file)',
    );
  });
});

test('populated branch reads short/long counts and by_category from live store', async () => {
  await withFreshRoots(async ({ projectDir, homeDir, cacheDir }) => {
    // Plant a real DB so the script takes the populated path. We hit
    // openStore from the test process (it's pure Node + better-sqlite3),
    // insert a few rows, then close — leaving a DB on disk for the
    // script's spawn to read.
    const { openStore } = await import('../../lib/store.js');
    process.env.MINDWRIGHT_PROJECT_ROOT = projectDir;
    const store = openStore();
    try {
      store.insertEntry({
        tier: 'short', kind: 'cli_prompt',
        content: 'observation A', sessionId: 'sess-a', sourceRef: null,
      });
      store.insertEntry({
        tier: 'short', kind: 'thinking',
        content: 'observation B', sessionId: 'sess-a', sourceRef: null,
      });
      store.insertEntry({
        tier: 'long', category: 'fact', scope: 'project', kind: 'fact',
        content: 'fact one', sessionId: 'sess-a', sourceRef: null,
      });
      store.insertEntry({
        tier: 'long', category: 'fact', scope: 'user', kind: 'fact',
        content: 'fact two', sessionId: 'sess-a', sourceRef: null,
        confidence: 0.8,
      });
    } finally {
      store.close();
      delete process.env.MINDWRIGHT_PROJECT_ROOT;
    }

    const res = runStatus(projectDir, homeDir, cacheDir);
    assert.equal(res.status, 0, `expected exit 0; got ${res.status}. stderr=${res.stderr}`);
    const out = JSON.parse(res.stdout.trim().split('\n').pop());
    assert.equal(out.db_exists, true);
    assert.equal(out.short_count, 2, 'short_count must reflect live store contents');
    assert.equal(out.long_count, 2, 'long_count must reflect live store contents');
    assert.equal(out.by_category['fact'], 2);
    assert.equal(out.by_category_scope['fact/project'], 1);
    assert.equal(out.by_category_scope['fact/user'], 1);
    assert.equal(out.last_consolidation, null, 'no consolidation ran');
    assert.equal(out.pending_embeds, 4, '4 rows were inserted without embeddings');
    assert.ok(out.oldest_preference_at,
      'a user-scope fact was planted — oldest_preference_at must be set');
    assert.deepEqual(out.consolidators, [], 'no consolidator records planted');
    assert.equal(out.note, undefined, 'populated branch should not set note');
  });
});

test('consolidators array surfaces every consolidator_for:* meta record', async () => {
  await withFreshRoots(async ({ projectDir, homeDir, cacheDir }) => {
    const { openStore } = await import('../../lib/store.js');
    process.env.MINDWRIGHT_PROJECT_ROOT = projectDir;
    const store = openStore();
    try {
      store.setConsolidatorFor('handle-a', {
        session_id: '00000000-0000-0000-0000-000000000001',
        first_seen: '2026-05-01T00:00:00.000Z',
        last_spawn: '2026-05-10T00:00:00.000Z',
      });
      store.setConsolidatorFor('handle-b', {
        session_id: '00000000-0000-0000-0000-000000000002',
        first_seen: '2026-05-02T00:00:00.000Z',
      });
    } finally {
      store.close();
      delete process.env.MINDWRIGHT_PROJECT_ROOT;
    }

    const res = runStatus(projectDir, homeDir, cacheDir);
    assert.equal(res.status, 0, `expected exit 0; got ${res.status}. stderr=${res.stderr}`);
    const out = JSON.parse(res.stdout.trim().split('\n').pop());
    assert.equal(out.consolidators.length, 2, 'both planted records must surface');
    const handles = out.consolidators.map((c) => c.requester_handle).sort();
    assert.deepEqual(handles, ['handle-a', 'handle-b']);
    const a = out.consolidators.find((c) => c.requester_handle === 'handle-a');
    assert.equal(a.session_id, '00000000-0000-0000-0000-000000000001');
    assert.equal(a.last_spawn, '2026-05-10T00:00:00.000Z');
    // The stderr line should also surface the consolidator handles so a
    // user scanning the terminal output can spot them.
    assert.match(res.stderr, /consolidators:/);
    assert.match(res.stderr, /handle-a/);
    assert.match(res.stderr, /handle-b/);
  });
});

test('stdout JSON parses and matches the stderr-rendered values', () => {
  withFreshRoots(({ projectDir, homeDir, cacheDir }) => {
    const res = runStatus(projectDir, homeDir, cacheDir);
    assert.equal(res.status, 0);
    const out = JSON.parse(res.stdout.trim().split('\n').pop());
    // stderr is the human-readable form — assert that every keyed value the
    // user reads in the terminal corresponds to the JSON, so a downstream
    // pipe consumer that JSON-parses stdout sees identical state.
    assert.match(res.stderr, new RegExp(`db exists:\\s+${out.db_exists}`));
    assert.match(res.stderr, new RegExp(`short_count:\\s+${out.short_count}`));
    assert.match(res.stderr, new RegExp(`long_count:\\s+${out.long_count}`));
    assert.match(res.stderr, new RegExp(`session bound:\\s+${out.session_alive}`));
    assert.match(res.stderr, new RegExp(`model daemon:\\s+${out.model_daemon_alive}`));
    assert.match(res.stderr, new RegExp(`embedder cached:\\s+${out.model_cached}`));
    assert.match(res.stderr, new RegExp(`reranker cached:\\s+${out.reranker_cached}`));
  });
});

test('model_cached / reranker_cached reflect the model-cache dir contents', () => {
  withFreshRoots(({ projectDir, homeDir, cacheDir }) => {
    // First: no model dirs → both false.
    let res = runStatus(projectDir, homeDir, cacheDir);
    let out = JSON.parse(res.stdout.trim().split('\n').pop());
    assert.equal(out.model_cached, false, 'no embedder dir → model_cached=false');
    assert.equal(out.reranker_cached, false, 'no reranker dir → reranker_cached=false');

    // Plant only the embedder repo (transformers.js <org>/<name> layout).
    plantModelCache(cacheDir, [['Xenova', 'bge-m3']]);
    res = runStatus(projectDir, homeDir, cacheDir);
    out = JSON.parse(res.stdout.trim().split('\n').pop());
    assert.equal(out.model_cached, true, 'embedder dir present → model_cached=true');
    assert.equal(out.reranker_cached, false, 'reranker still missing → reranker_cached=false');

    // Plant the reranker too.
    plantModelCache(cacheDir, [['onnx-community', 'bge-reranker-v2-m3-ONNX']]);
    res = runStatus(projectDir, homeDir, cacheDir);
    out = JSON.parse(res.stdout.trim().split('\n').pop());
    assert.equal(out.model_cached, true);
    assert.equal(out.reranker_cached, true, 'reranker dir present → reranker_cached=true');
  });
});

test('deps-absent branch emits the degraded baseStatus()+zeroCounts() payload and never calls openStore', () => {
  // /mindwright:status is the user's primary diagnostic precisely WHEN the
  // plugin is dormant (a marketplace copy, or a plugin update that wiped
  // node_modules). Every other test here runs in the deps-present dev tree,
  // so the deps-absent payload shape was never exercised. Reproduce a
  // faithful marketplace copy: scripts/ + lib/ with NO node_modules, so the
  // copy's depsInstalled() is false (paths.js derives PLUGIN_ROOT from its
  // own location → the sandbox). store.js is copied but never imported (the
  // branch returns before `await import('../lib/store.js')`).
  // MINDWRIGHT_AUTO_INSTALL=false keeps maybeAutoInstall() from spawning a
  // real npm install; the payload contract is independent of that call.
  const pluginCopy = mkdtempSync(join(tmpdir(), 'mindwright-status-plugin-'));
  const projectDir = mkdtempSync(join(tmpdir(), 'mindwright-status-proj-'));
  const homeDir = mkdtempSync(join(tmpdir(), 'mindwright-status-home-'));
  try {
    cpSync(join(PLUGIN_ROOT, 'lib'), join(pluginCopy, 'lib'), { recursive: true });
    cpSync(join(PLUGIN_ROOT, 'scripts'), join(pluginCopy, 'scripts'), { recursive: true });

    const res = spawnSync(process.execPath, [join(pluginCopy, 'scripts', 'status.js')], {
      encoding: 'utf8',
      timeout: 20000,
      env: {
        ...process.env,
        MINDWRIGHT_PROJECT_ROOT: projectDir,
        MINDWRIGHT_AUTO_INSTALL: 'false',
        MINDWRIGHT_INSTALL_LOCK_DIR: pluginCopy,
        HOME: homeDir,
        USERPROFILE: homeDir,
        // baseStatus() is async now and awaits isModelDaemonAlive(); pin the
        // socket to a no-listener path so the probe fails fast and can't
        // connect to a real machine daemon (the field is unasserted here, but
        // determinism + no 1s hang on the machine-global Windows pipe).
        MINDWRIGHT_MODEL_DAEMON_SOCK: join(homeDir, 'no-such-modeld.sock'),
      },
    });

    assert.equal(res.status, 0, `expected exit 0; got ${res.status}. stderr=${res.stderr}`);
    const out = JSON.parse(res.stdout.trim().split('\n').pop());

    // baseStatus() field (dep-free) present and false on a fresh project.
    assert.equal(out.db_exists, false, 'fresh project → db_exists=false');
    // Every zeroCounts() field at its zero value.
    assert.equal(out.short_count, 0);
    assert.equal(out.long_count, 0);
    assert.deepEqual(out.by_category, {});
    assert.deepEqual(out.by_category_scope, {});
    assert.equal(out.last_consolidation, null);
    assert.equal(out.pending_embeds, 0);
    assert.equal(out.oldest_preference_at, null);
    assert.deepEqual(out.consolidators, []);
    // The deps-absent note must explain the background install + name the log.
    assert.equal(typeof out.note, 'string', 'deps-absent note must be set');
    assert.notEqual(out.note, '', 'deps-absent note must be set');
    assert.match(out.note, /native dependencies not installed/);
    assert.match(out.note, /mindwright-install-.*\.log/, 'note must reference installLogPath()');
    // openStore() must NOT have run (it creates the DB via migrations).
    assert.equal(
      existsSync(join(projectDir, '.claude', 'mindwright', 'mindwright.db')),
      false,
      'deps-absent branch must return before openStore (no DB file)',
    );
  } finally {
    for (const d of [pluginCopy, projectDir, homeDir]) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* tmp */ }
    }
  }
});
