// Tests for lib/consolidator-spawn.js. The function fires a detached
// `claude --bg` subprocess for the consolidator role — we exercise it with
// a fake "claude" binary (a tiny node script that prints a fake session-id
// line and exits) via the MINDWRIGHT_SPAWN_FAKE env hook.
//
// Goals:
//   - Reject the disabled path (MINDWRIGHT_SPAWN_DISABLE=1) so callers can
//     fall back to nudge staging without leaking a process.
//   - Reject missing/invalid arguments without spawning anything.
//   - On a successful spawn: mint a record under meta:consolidator_for:<h>,
//     reuse it on the next call (deterministic session_id), and update
//     last_spawn on each call.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnConsolidator, CONSOLIDATOR_SPAWN_ENV_OVERRIDES } from '../lib/consolidator-spawn.js';
import { openStore } from '../lib/store.js';
import { deriveHandle } from '../lib/handles.js';

// Build a "claude" stand-in. The spawner only needs a real executable on
// disk — it reads the first stdout line best-effort and never awaits the
// child's exit code, so we don't have to emulate `claude --bg` semantics.
//
// POSIX: a tiny shell script that prints a stub line and exits 0.
// Windows: `process.execPath` (node.exe). The args spawn-consolidator hard-
// codes (`--bg --session-id ... /mindwright:dream`) are not valid node
// flags, so the child exits non-zero asynchronously — fine, the spawner
// already returned ok:true with a pid by then. The alternative (.cmd file)
// would require `shell:true` in spawn-consolidator, which we don't want to
// alter just for tests.
function makeFakeClaude(dir) {
  if (process.platform === 'win32') {
    return process.execPath;
  }
  const path = join(dir, 'fake-claude.sh');
  writeFileSync(path, '#!/bin/sh\necho fake-session-id-abc\nexit 0\n', 'utf8');
  chmodSync(path, 0o755);
  return path;
}

function withStore(fn) {
  const prevRoot = process.env.MINDWRIGHT_PROJECT_ROOT;
  const dir = mkdtempSync(join(tmpdir(), 'mindwright-spawn-'));
  process.env.MINDWRIGHT_PROJECT_ROOT = dir;
  const store = openStore();
  try {
    return fn(store, dir);
  } finally {
    try { store.close(); } catch { /* */ }
    if (prevRoot === undefined) delete process.env.MINDWRIGHT_PROJECT_ROOT;
    else process.env.MINDWRIGHT_PROJECT_ROOT = prevRoot;
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* tmp */ }
  }
}

// Snapshot + restore the env vars this module reads. Each test that touches
// these wraps its body with restoreEnv() to keep the harness deterministic.
function withEnv(overrides, fn) {
  const keys = Object.keys(overrides);
  const prev = {};
  for (const k of keys) prev[k] = process.env[k];
  for (const [k, v] of Object.entries(overrides)) {
    if (v === null || v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const k of keys) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
}

// ----- disabled path -----------------------------------------------------

test('spawnConsolidator returns ok:false when MINDWRIGHT_SPAWN_DISABLE=1', () => {
  withStore((store) => {
    withEnv({ MINDWRIGHT_SPAWN_DISABLE: '1' }, () => {
      const r = spawnConsolidator({
        requesterHandle: 'planner-1',
        reason: 'role_assigned',
        store,
      });
      assert.equal(r.ok, false);
      assert.match(r.error, /spawn disabled/);
      // No spawn happened → no consolidator record minted.
      assert.equal(store.getConsolidatorFor('planner-1'), null);
    });
  });
});

// ----- argument validation -----------------------------------------------

test('spawnConsolidator returns ok:false when requesterHandle is missing', () => {
  withStore((store) => {
    withEnv({ MINDWRIGHT_SPAWN_DISABLE: null }, () => {
      const r = spawnConsolidator({
        requesterHandle: '',
        reason: 'role_assigned',
        store,
      });
      assert.equal(r.ok, false);
      assert.match(r.error, /requesterHandle required/);
    });
  });
});

test('spawnConsolidator returns ok:false when store lacks the required helpers', () => {
  withEnv({ MINDWRIGHT_SPAWN_DISABLE: null }, () => {
    const r = spawnConsolidator({
      requesterHandle: 'planner-1',
      reason: 'role_assigned',
      store: {}, // no getConsolidatorFor
    });
    assert.equal(r.ok, false);
    assert.match(r.error, /getConsolidatorFor.*setConsolidatorFor required/);
  });
});

// ----- spawn success path ------------------------------------------------

test('spawnConsolidator mints a record on first call and reuses it on second', () => {
  withStore((store, root) => {
    const fakeBin = makeFakeClaude(root);
    withEnv({ MINDWRIGHT_SPAWN_DISABLE: null, MINDWRIGHT_SPAWN_FAKE: fakeBin }, () => {
      const first = spawnConsolidator({
        requesterHandle: 'planner-1',
        reason: 'role_assigned',
        store,
      });
      assert.equal(first.ok, true, `first spawn must succeed: ${first.error || ''}`);
      assert.equal(typeof first.sessionId, 'string');
      assert.equal(typeof first.handle, 'string');
      assert.equal(typeof first.pid, 'number');
      assert.equal(first.reason, 'role_assigned');

      const stored = store.getConsolidatorFor('planner-1');
      assert.ok(stored, 'record must be persisted under requester handle');
      assert.equal(stored.session_id, first.sessionId);
      assert.equal(typeof stored.first_seen, 'string');
      assert.equal(typeof stored.last_spawn, 'string');

      // Second call reuses the same session_id (deterministic identity per
      // requester+project) and refreshes last_spawn. Backdate last_spawn to
      // a known fixed timestamp so the deltacheck is deterministic; the
      // previous spin loop tied the test to Date.now() millisecond
      // granularity (15.6ms on legacy Windows) and burned CPU for no
      // signal. Comparing ISO 8601 strings is lexicographic — anything
      // after 2020-01-01 sorts greater.
      const SENTINEL_OLD = '2020-01-01T00:00:00.000Z';
      store.setConsolidatorFor('planner-1', { ...stored, last_spawn: SENTINEL_OLD });

      const second = spawnConsolidator({
        requesterHandle: 'planner-1',
        reason: 'stop_hint',
        store,
      });
      assert.equal(second.ok, true);
      assert.equal(second.sessionId, first.sessionId, 'session_id must be stable across spawns');

      const stored2 = store.getConsolidatorFor('planner-1');
      assert.equal(stored2.session_id, first.sessionId);
      assert.ok(stored2.last_spawn > SENTINEL_OLD,
        `last_spawn must be refreshed to a newer ISO string than the sentinel; got '${stored2.last_spawn}'`);
    });
  });
});

test('spawnConsolidator returns a handle that matches deriveHandle(sessionId)', () => {
  withStore((store, root) => {
    const fakeBin = makeFakeClaude(root);
    withEnv({ MINDWRIGHT_SPAWN_DISABLE: null, MINDWRIGHT_SPAWN_FAKE: fakeBin }, () => {
      const r = spawnConsolidator({
        requesterHandle: 'tester-2',
        reason: 'role_assigned',
        store,
      });
      assert.equal(r.ok, true);
      // Re-derive from the same session_id and confirm the returned handle
      // matches — the spawner exposes the wrightward-handle convention so
      // peers in the bus can reference the consolidator by its handle
      // without round-tripping through the roster.
      assert.equal(r.handle, deriveHandle(r.sessionId),
        `r.handle must equal deriveHandle(r.sessionId); got handle='${r.handle}' sessionId='${r.sessionId}'`);
    });
  });
});

test('spawnConsolidator keeps the per-requester record distinct from another requester', () => {
  withStore((store, root) => {
    const fakeBin = makeFakeClaude(root);
    withEnv({ MINDWRIGHT_SPAWN_DISABLE: null, MINDWRIGHT_SPAWN_FAKE: fakeBin }, () => {
      const a = spawnConsolidator({
        requesterHandle: 'planner-1',
        reason: 'role_assigned',
        store,
      });
      const b = spawnConsolidator({
        requesterHandle: 'planner-2',
        reason: 'role_assigned',
        store,
      });
      assert.equal(a.ok, true);
      assert.equal(b.ok, true);
      assert.notEqual(a.sessionId, b.sessionId,
        'two different requester handles must mint independent consolidators');
      assert.equal(store.getConsolidatorFor('planner-1').session_id, a.sessionId);
      assert.equal(store.getConsolidatorFor('planner-2').session_id, b.sessionId);
    });
  });
});

// Note: a Windows-portable sync-ENOENT test isn't feasible — node's
// child_process.spawn surfaces missing-binary as an async 'error' event on
// Windows (not a sync throw), and spawn-consolidator returns synchronously
// before that event fires. The validation-error paths above already cover
// the sync ok:false branches the production code actually exercises.

// ----- self-spawn sentinel env --------------------------------------------

test('CONSOLIDATOR_SPAWN_ENV_OVERRIDES sets MINDWRIGHT_IS_CONSOLIDATOR=1', () => {
  // Regression: every spawned consolidator MUST inherit this sentinel so
  // its Stop hook can detect "I am a consolidator" and skip the self-
  // spawn path. Without it, each Stop spawns a fresh consolidator with a
  // different deriveHandle → meta:consolidator_for dedupe misses →
  // unbounded chain of orphan `claude --bg` supervisors. We assert on
  // the exported overrides object rather than on the spawned process's
  // env because Node does not expose ChildProcess.env after spawn.
  assert.equal(CONSOLIDATOR_SPAWN_ENV_OVERRIDES.MINDWRIGHT_IS_CONSOLIDATOR, '1',
    'sentinel value must be the literal string "1" — Stop hook checks ===');
  assert.ok(Object.isFrozen(CONSOLIDATOR_SPAWN_ENV_OVERRIDES),
    'overrides object must be frozen to prevent runtime mutation');
});
