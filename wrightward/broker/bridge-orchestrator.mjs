// Composes the per-MCP bridge lifecycle: initial spawn + 5s heartbeat +
// graceful shutdown. Factored out of mcp/server.mjs so the state machine
// is directly testable with stubbed tryAcquireAndSpawn / heartbeatLock /
// shutdownOwnedBridge.
//
// State machine (per tick):
//   1. If heartbeatLock says 'respawn' AND result.owned → adopt new state.
//   2. Else if we OWN a child that has exited (exitCode !== null) → respawn.
//      (The child's exit handler in bridge-spawn.mjs releases the lock
//      synchronously before this tick fires, so heartbeatLock sees no_lock
//      and returns idle — without this branch the bridge stays permanently
//      dead in single-MCP deployments.)
//   3. Else if reason ∈ {owned_by_other, circuit_open, not_attempted,
//      spawn_failed, spawn_no_pid} → try to take over.

import {
  tryAcquireAndSpawn as defaultTryAcquireAndSpawn,
  heartbeatLock as defaultHeartbeatLock,
  shutdownOwnedBridge as defaultShutdownOwnedBridge
} from './bridge-spawn.mjs';

export const DEFAULT_HEARTBEAT_MS = 5000;

const TAKEOVER_REASONS = new Set([
  'owned_by_other',
  'circuit_open',
  'not_attempted',
  'spawn_failed',
  'spawn_no_pid'
]);

/**
 * @param {string} collabDir
 * @param {() => object} spawnOptsFn - produces spawn/heartbeat opts per call
 *   (evaluated fresh so session id binds late)
 * @param {object} [deps] - injection points for tests
 * @param {function} [deps.tryAcquireAndSpawn]
 * @param {function} [deps.heartbeatLock]
 * @param {function} [deps.shutdownOwnedBridge]
 * @param {function} [deps.logger] - `(msg: string) => void`; defaults to stderr
 * @param {number}   [deps.heartbeatMs]
 * @param {function} [deps.setInterval] - injected to skip real timers in tests
 * @param {function} [deps.clearInterval]
 */
export function createBridgeOrchestrator(collabDir, spawnOptsFn, deps) {
  deps = deps || {};
  const tryAcquireAndSpawn = deps.tryAcquireAndSpawn || defaultTryAcquireAndSpawn;
  const heartbeatLock = deps.heartbeatLock || defaultHeartbeatLock;
  const shutdownOwnedBridge = deps.shutdownOwnedBridge || defaultShutdownOwnedBridge;
  const logger = deps.logger || ((msg) => process.stderr.write(msg));
  const heartbeatMs = typeof deps.heartbeatMs === 'number'
    ? deps.heartbeatMs : DEFAULT_HEARTBEAT_MS;
  const setIntervalFn = deps.setInterval || setInterval;
  const clearIntervalFn = deps.clearInterval || clearInterval;

  let state = { running: false, owned: false, reason: 'not_attempted', child: null };
  let timer = null;

  function spawn() {
    const result = tryAcquireAndSpawn(collabDir, spawnOptsFn());
    if (result.owned) {
      state = result;
      logger('[wrightward-mcp] bridge spawned (pid=' + result.childPid + ')\n');
    } else {
      // Keep bridgeState in sync with the returned reason so the next tick
      // routes through the correct branch (e.g., spawn_failed → takeover on
      // next decay).
      state = result;
      if (result.reason === 'owned_by_other') {
        logger('[wrightward-mcp] bridge already owned by another session\n');
      } else if (result.reason === 'circuit_open') {
        logger('[wrightward-mcp] bridge spawn skipped: circuit breaker open\n');
      }
    }
    return result;
  }

  function tick() {
    const hb = heartbeatLock(collabDir, spawnOptsFn());
    if (hb.action === 'respawn') {
      // Always adopt heartbeat's result — it performed the authoritative
      // lock release and spawn attempt. Falling through to spawn() again
      // on `owned: false` (e.g. circuit_open) would double-call
      // tryAcquireAndSpawn in the same tick: once from heartbeatLock,
      // once from the dead-child branch below. The takeover branch
      // naturally retries on the NEXT 5s tick via the adopted reason.
      if (hb.result) state = hb.result;
      if (hb.result && hb.result.owned) {
        logger('[wrightward-mcp] bridge respawned (pid=' + hb.result.childPid + ')\n');
      }
      return;
    }
    if (state.owned && state.child && state.child.exitCode !== null) {
      spawn();
      return;
    }
    if (TAKEOVER_REASONS.has(state.reason)) {
      spawn();
    }
  }

  function start() {
    spawn();
    timer = setIntervalFn(tick, heartbeatMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  function shutdown() {
    if (timer) {
      try { clearIntervalFn(timer); } catch (_) {}
      timer = null;
    }
    try { shutdownOwnedBridge(collabDir, state.child); } catch (_) {}
  }

  return {
    start,
    shutdown,
    tick, // exposed for test-driven single-step advancement
    getState: () => state
  };
}
