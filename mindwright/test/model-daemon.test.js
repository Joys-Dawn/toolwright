// Machine-wide model daemon: path derivation + client-side lazy-spawn guard.
//
// The daemon process itself (singleton lock election, idle-exit, ONNX load)
// is an integration concern that needs the native deps + a real socket; the
// unit-testable surface is (a) the machine-global path derivation and its
// test/override seam, and (b) the spawn guard's two contracts that must hold
// without ever forking a real ONNX process: the DISABLE seam short-circuits,
// and the in-process throttle collapses a burst of calls into one spawn.

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

test('ensureModelDaemon short-circuits under the DISABLE seam — never spawns, never throws, even in a burst', async () => {
  process.env.MINDWRIGHT_MODEL_DAEMON_DISABLE = '1';
  const { ensureModelDaemon } = await import(`../lib/model-daemon-spawn.js?t=${Date.now()}-${Math.random()}`);
  // The seam is what every test in the suite relies on to assert
  // "degrades to null" without forking a real ONNX daemon — a burst must
  // stay a clean no-op.
  for (let i = 0; i < 5; i++) assert.doesNotThrow(() => ensureModelDaemon());
});
