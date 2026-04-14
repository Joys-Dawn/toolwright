// Helper called from mcp/server.mjs to spawn (or respawn) the Phase 3 Discord
// bridge daemon under a single-owner lockfile.
//
// Three gates before spawn:
//   1. Circuit breaker — don't spawn if a recent failure put the bridge on
//      cooldown. Persistent across MCP restarts so a rapid auth-fail loop
//      across multiple sessions can't hammer Discord.
//   2. Lock acquisition — at most one bridge per repo. Losing the race means
//      another session already owns the bridge; we just observe it.
//   3. Child spawn — fork broker/bridge.mjs with CWD + env inherited. Wire
//      exit handling back through the circuit breaker.

import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import {
  acquireLock,
  releaseLock,
  updateChildPid,
  readLock,
  isProcessAlive,
  readCircuitBreaker,
  recordBridgeFailure,
  appendLog,
  SELF_RECORDED_FAILURE_EXIT_CODE
} from './lifecycle.mjs';

const require = createRequire(import.meta.url);
const { redactTokens } = require('../lib/discord-sanitize');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BRIDGE_ENTRY = path.resolve(__dirname, 'bridge.mjs');

// How long the child must stay alive before we consider the spawn itself
// successful (separate from Discord auth confirmation, which bridge.mjs
// handles via its own 30s grace period → recordBridgeSuccess).
const FAST_EXIT_THRESHOLD_MS = 5000;

/**
 * Attempts to acquire the bridge lock and spawn the bridge child. Safe to
 * call on every MCP startup — idempotent when another session already
 * owns the bridge.
 *
 * @param {string} collabDir
 * @param {object} opts
 * @param {string} opts.sessionId           - the current session's id (for lock owner attribution)
 * @param {string} opts.cwd                 - project root; passed as argv[2] to bridge
 * @param {boolean} opts.discordEnabled     - config.discord.ENABLED
 * @param {boolean} opts.busEnabled         - config.BUS_ENABLED
 * @param {string|null} opts.botToken       - DISCORD_BOT_TOKEN value (may be null/empty)
 * @returns {{ running: boolean, owned: boolean, reason: string, childPid: number|null }}
 */
export function tryAcquireAndSpawn(collabDir, opts) {
  opts = opts || {};
  if (!opts.discordEnabled) {
    return { running: false, owned: false, reason: 'discord_disabled', childPid: null };
  }
  if (!opts.busEnabled) {
    return { running: false, owned: false, reason: 'bus_disabled', childPid: null };
  }
  if (!opts.botToken) {
    return { running: false, owned: false, reason: 'no_token', childPid: null };
  }

  const cb = readCircuitBreaker(collabDir);
  if (cb.disabled_until_ts > Date.now()) {
    return {
      running: false,
      owned: false,
      reason: 'circuit_open',
      childPid: null,
      circuit_breaker: cb
    };
  }

  const acq = acquireLock(collabDir, { sessionId: opts.sessionId });
  if (!acq.acquired) {
    // Another session owns the bridge — observe, don't steal.
    const existing = acq.lock || readLock(collabDir);
    return {
      running: Boolean(existing && existing.bridge_child_pid &&
        isProcessAlive(existing.bridge_child_pid)),
      owned: false,
      reason: 'owned_by_other',
      childPid: existing && existing.bridge_child_pid ? existing.bridge_child_pid : null
    };
  }

  let child;
  const entry = opts.entryOverride || BRIDGE_ENTRY;
  try {
    child = spawn(process.execPath, [entry, opts.cwd || process.cwd()], {
      cwd: opts.cwd || process.cwd(),
      env: {
        ...process.env,
        DISCORD_BOT_TOKEN: opts.botToken
      },
      // Pipe stderr so pre-appendLog failures (missing token, missing
      // collab dir, uncaught exceptions) land in bridge.log with token
      // redaction applied — otherwise they go to /dev/null and a user
      // sees a silently dead bridge.
      stdio: ['ignore', 'ignore', 'pipe'],
      detached: false
    });
  } catch (err) {
    appendLog(collabDir, '[spawn] child spawn threw: ' + (err.message || String(err)));
    releaseLock(collabDir);
    recordBridgeFailure(collabDir, { error: err });
    // owned:false — we released the lock, so the next heartbeat's
    // takeover branch is the right path to retry (gated by circuit breaker).
    return { running: false, owned: false, reason: 'spawn_failed', childPid: null };
  }

  if (!child || !child.pid) {
    appendLog(collabDir, '[spawn] child spawn returned no pid');
    releaseLock(collabDir);
    recordBridgeFailure(collabDir, { error: 'spawn returned no pid' });
    return { running: false, owned: false, reason: 'spawn_no_pid', childPid: null };
  }

  updateChildPid(collabDir, child.pid);
  const childStartedAt = Date.now();

  if (child.stderr) {
    child.stderr.on('data', (chunk) => {
      const line = chunk.toString();
      if (line.trim().length === 0) return;
      appendLog(collabDir, redactTokens(line.replace(/\n+$/, '')));
    });
  }

  // Wire exit handling — child exits normally on SIGTERM (code 0) during
  // shutdown; non-zero or a crash signal is a failure that feeds the
  // circuit breaker. Fast-exits (<5s) also count as failures since they
  // prevented the in-bridge 30s success timer from firing.
  //
  // Exception: code === SELF_RECORDED_FAILURE_EXIT_CODE means the bridge
  // has already written its own circuit-breaker entry (e.g. 1h auth
  // ceiling on 401). A second recordBridgeFailure here would increment n
  // and pick a shorter bucket, clobbering the bridge's longer cooldown.
  child.on('exit', (code, signal) => {
    const alive = Date.now() - childStartedAt;
    const graceful = code === 0 && !signal;
    const selfRecorded = code === SELF_RECORDED_FAILURE_EXIT_CODE;
    appendLog(collabDir, '[spawn] child exit code=' + code + ' signal=' + signal +
      ' alive_ms=' + alive);
    if ((!graceful || alive < FAST_EXIT_THRESHOLD_MS) && !selfRecorded) {
      try {
        const errMsg = signal
          ? 'child exited with signal ' + signal
          : 'child exited with code ' + code + (alive < FAST_EXIT_THRESHOLD_MS
            ? ' (fast exit < ' + FAST_EXIT_THRESHOLD_MS + 'ms)' : '');
        recordBridgeFailure(collabDir, { error: errMsg });
      } catch (_) {}
    }
    // Only release the lock if we still own it AND it still points to this
    // specific child. A heartbeat can race this handler (timers fire before
    // poll-phase exit events) and re-spawn a replacement child with a fresh
    // lock; without the bridge_child_pid check we'd unlink that new lock
    // and orphan its child, letting another MCP spawn a duplicate bridge.
    releaseLock(collabDir, child.pid);
  });

  child.on('error', (err) => {
    appendLog(collabDir, '[spawn] child error: ' + (err.message || String(err)));
  });

  // Detach stdio listeners so the MCP parent can exit cleanly even if the
  // child is slow to tear down. Node keeps the reference alive via the
  // child process itself — no need for child.unref() unless we want the
  // parent to exit while the bridge is still running, which is wrong here
  // (SIGTERM on parent triggers SIGTERM on child).
  return {
    running: true,
    owned: true,
    reason: 'spawned',
    childPid: child.pid,
    child
  };
}

/**
 * Lock-heartbeat: re-verifies bridge ownership and respawns the child if
 * it has died while we still hold the lock. Called from the MCP file-watcher
 * tick at a low frequency (~5s).
 *
 * - If we don't own the lock (another MCP took over, or we never acquired):
 *   no-op.
 * - If our child is still alive: no-op.
 * - If our child is dead: release the lock, then re-run tryAcquireAndSpawn
 *   with the circuit breaker consulted. On race with another MCP acquiring
 *   first, we simply observe.
 */
export function heartbeatLock(collabDir, opts) {
  const lock = readLock(collabDir);
  if (!lock) return { action: 'idle', reason: 'no_lock' };
  if (lock.owner_pid !== process.pid) return { action: 'idle', reason: 'not_owner' };
  if (lock.bridge_child_pid && isProcessAlive(lock.bridge_child_pid)) {
    return { action: 'idle', reason: 'child_alive' };
  }

  // Child died while we held the lock — release and retry under the circuit
  // breaker. The child's own exit handler will have already fired
  // recordBridgeFailure; this path is for the case where the parent noticed
  // first (e.g., SIGKILL on the child).
  releaseLock(collabDir);

  // Sequential only: return so the caller decides whether to retry this
  // tick or wait for the next heartbeat. Respawning inline inside the
  // heartbeat timer is fine because spawn is non-blocking.
  const result = tryAcquireAndSpawn(collabDir, opts);
  return { action: 'respawn', result };
}

/**
 * Releases the bridge lock and terminates the child if we own it. Safe to
 * call from SIGTERM/SIGINT handlers.
 */
export function shutdownOwnedBridge(collabDir, child) {
  const lock = readLock(collabDir);
  if (!lock || lock.owner_pid !== process.pid) return;
  if (child && !child.killed) {
    try { child.kill('SIGTERM'); } catch (_) {}
  }
  try { releaseLock(collabDir); } catch (_) {}
}
