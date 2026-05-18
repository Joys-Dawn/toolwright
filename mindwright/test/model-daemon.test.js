// Machine-wide model daemon: path derivation + client-side lazy-spawn guard.
//
// The daemon *process* itself (idle-exit, RSS-recycle, ONNX load) is an
// integration concern needing native deps + a real socket; its singleton
// lock election is unit-tested separately in core/model-daemon-singleton.
// This file pins the deps-free client surface without ever forking a real
// ONNX process:
//   (a) machine-global path derivation + the SOCK override seam;
//   (b) ensureModelDaemon's guard contracts via injected seams — DISABLE
//       short-circuits (zero spawns even in a burst); the in-process throttle
//       collapses a burst into one spawn then re-arms past the window; a
//       failed log-open degrades stdio[2] to 'ignore' without blocking the
//       spawn; an inherited numeric log fd is closed exactly once and an
//       'ignore' sentinel is never closed.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { MODEL_DAEMON_PROTOCOL } from '../lib/constants.js';

const ENV_KEYS = ['MINDWRIGHT_MODEL_DAEMON_SOCK', 'MINDWRIGHT_MODEL_DAEMON_DISABLE'];
let snap;
beforeEach(() => {
  snap = {};
  for (const k of ENV_KEYS) { snap[k] = process.env[k]; delete process.env[k]; }
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (snap[k] === undefined) delete process.env[k];
    else process.env[k] = snap[k];
  }
});

async function freshPaths() {
  const m = await import(`../lib/paths.js?t=${Date.now()}-${Math.random()}`);
  return m;
}

// Each test needs its own module instance: the throttle's `lastSpawnAt` is
// module-level state, so a cache-busted import gives every test a clean clock.
async function freshSpawnMod() {
  return import(`../lib/model-daemon-spawn.js?t=${Date.now()}-${Math.random()}`);
}

// A spawn double that records the (file,args,opts) it was called with and
// returns a child whose unref() is counted — so "detached, then unref'd" is
// asserted without a real process.
function spawnRecorder() {
  const calls = [];
  let unrefs = 0;
  const spawn = (file, args, opts) => {
    calls.push({ file, args, opts });
    return { unref() { unrefs += 1; } };
  };
  return { spawn, calls, unrefs: () => unrefs };
}

test('socket/lock/log are machine-global and protocol-tagged by default', async () => {
  const { modelDaemonSocketPath, modelDaemonLockPath, modelDaemonLogPath } = await freshPaths();
  const sock = modelDaemonSocketPath();
  // Not under any project .claude/mindwright dir — it is machine-wide.
  assert.ok(!sock.includes(join('.claude', 'mindwright')), `socket must be machine-global, got ${sock}`);
  assert.match(sock, new RegExp(`modeld-v${MODEL_DAEMON_PROTOCOL}`));
  assert.ok(
    modelDaemonLockPath().includes(`modeld-v${MODEL_DAEMON_PROTOCOL}`)
      && modelDaemonLockPath().endsWith('.lock'),
    `lock must be protocol-tagged, got ${modelDaemonLockPath()}`,
  );
  assert.ok(modelDaemonLogPath().endsWith('modeld.log'));
});

test('MINDWRIGHT_MODEL_DAEMON_SOCK overrides socket and co-locates lock/log', async () => {
  process.env.MINDWRIGHT_MODEL_DAEMON_SOCK = '/tmp/mw-test-modeld.sock';
  const { modelDaemonSocketPath, modelDaemonLockPath, modelDaemonLogPath } = await freshPaths();
  assert.equal(modelDaemonSocketPath(), '/tmp/mw-test-modeld.sock');
  assert.equal(modelDaemonLockPath(), '/tmp/mw-test-modeld.sock.lock');
  assert.equal(modelDaemonLogPath(), '/tmp/mw-test-modeld.sock.log');
});

test('DISABLE seam short-circuits — zero spawns even across a burst, never throws', async () => {
  process.env.MINDWRIGHT_MODEL_DAEMON_DISABLE = '1';
  const { ensureModelDaemon } = await freshSpawnMod();
  const rec = spawnRecorder();
  // The seam is what every test in the suite relies on to assert "degrades
  // to null" without forking a real ONNX daemon — a burst must stay a clean
  // no-op: no throw AND, provably, no spawn.
  for (let i = 0; i < 5; i++) {
    assert.doesNotThrow(() => ensureModelDaemon({ spawn: rec.spawn, openLog: () => 'ignore' }));
  }
  assert.equal(rec.calls.length, 0, 'DISABLE must short-circuit before the spawn');
});

test('first call spawns detached + unref\'d; an immediate burst collapses to one spawn', async () => {
  const { ensureModelDaemon } = await freshSpawnMod();
  const rec = spawnRecorder();
  const FIXED = 1_000_000;
  for (let i = 0; i < 5; i++) {
    ensureModelDaemon({ spawn: rec.spawn, openLog: () => 'ignore', clock: () => FIXED });
  }
  assert.equal(rec.calls.length, 1, 'a same-instant burst must throttle to a single spawn');
  assert.equal(rec.unrefs(), 1, 'the detached child must be unref\'d so it never pins the parent');
  const { args, opts } = rec.calls[0];
  assert.ok(args[0].endsWith(join('scripts', 'model-daemon.mjs')), `must spawn the daemon script, got ${args[0]}`);
  assert.equal(opts.detached, true);
  assert.equal(opts.windowsHide, true);
});

test('throttle re-arms once the window has elapsed (second spawn allowed)', async () => {
  const { ensureModelDaemon } = await freshSpawnMod();
  const rec = spawnRecorder();
  let t = 5_000_000;
  const clock = () => t;
  ensureModelDaemon({ spawn: rec.spawn, openLog: () => 'ignore', clock }); // #1
  assert.equal(rec.calls.length, 1);
  // Still inside the window (same instant) → throttled, no new spawn.
  ensureModelDaemon({ spawn: rec.spawn, openLog: () => 'ignore', clock });
  assert.equal(rec.calls.length, 1, 'a call inside the throttle window must not spawn');
  // Well past any sane throttle window (advance an hour — avoids hardcoding
  // the private SPAWN_THROTTLE_MS constant) → re-armed, spawns again.
  t += 3_600_000;
  ensureModelDaemon({ spawn: rec.spawn, openLog: () => 'ignore', clock });
  assert.equal(rec.calls.length, 2, 'past the window the guard must re-arm and spawn');
});

test('a failed log-open degrades stdio[2] to "ignore" and still spawns, without throwing', async () => {
  const { ensureModelDaemon } = await freshSpawnMod();
  const rec = spawnRecorder();
  assert.doesNotThrow(() =>
    ensureModelDaemon({
      spawn: rec.spawn,
      openLog: () => { throw new Error('EACCES opening modeld.log'); },
      clock: () => 2_000_000,
    }),
  );
  assert.equal(rec.calls.length, 1, 'a log-open failure must NOT prevent the spawn');
  assert.deepEqual(rec.calls[0].opts.stdio, ['ignore', 'ignore', 'ignore'],
    'stderr must fall back to "ignore" when the log fd cannot be opened');
});

test('an inherited numeric log fd is closed exactly once; an "ignore" sentinel is never closed', async () => {
  // Numeric fd → closed once (no descriptor leak into the parent).
  {
    const { ensureModelDaemon } = await freshSpawnMod();
    const rec = spawnRecorder();
    const closed = [];
    ensureModelDaemon({
      spawn: rec.spawn,
      openLog: () => 4242,                 // a fake fd — never a real syscall
      closeFd: (fd) => closed.push(fd),
      clock: () => 3_000_000,
    });
    assert.equal(rec.calls.length, 1);
    assert.deepEqual(rec.calls[0].opts.stdio, ['ignore', 'ignore', 4242]);
    assert.deepEqual(closed, [4242], 'the inherited numeric fd must be closed exactly once');
  }
  // 'ignore' sentinel → closeFd must never be invoked (typeof !== 'number').
  {
    const { ensureModelDaemon } = await freshSpawnMod();
    const rec = spawnRecorder();
    let closeCalls = 0;
    ensureModelDaemon({
      spawn: rec.spawn,
      openLog: () => 'ignore',
      closeFd: () => { closeCalls += 1; },
      clock: () => 4_000_000,
    });
    assert.equal(rec.calls.length, 1);
    assert.equal(closeCalls, 0, '"ignore" is not a descriptor — closeFd must not run');
  }
});
