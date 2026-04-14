// Lifecycle helpers for the Phase 3 bridge daemon:
//   - Single-owner lockfile election (fs.openSync with 'wx')
//   - Cross-platform liveness probe via process.kill(pid, 0)
//   - Append-only log with 1 MB rotation (keep 3 rotations)
//   - Persistent circuit breaker across MCP restarts

import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { atomicWriteJson } = require('../lib/atomic-write');

const BRIDGE_DIR = 'bridge';
const LOCK_FILE = 'bridge.lock';
const LOG_FILE = 'bridge.log';
const CIRCUIT_FILE = 'circuit-breaker.json';

export const LOG_ROTATE_BYTES = 1 * 1024 * 1024; // 1 MB
export const LOG_KEEP_COUNT = 3;

// Backoff schedule — consecutive_failures=N selects index N-1.
// Matches the plan's "10s → 30s → 60s → 1 hour cap" ladder.
export const BACKOFF_SCHEDULE_MS = [10_000, 30_000, 60_000];
export const AUTH_FAIL_BACKOFF_MS = 60 * 60 * 1000; // 1 hour ceiling
export const MAX_BACKOFF_MS = 60 * 60 * 1000;

// Exit code the bridge uses when it has already recorded its own circuit
// breaker entry (e.g. 401 → 1h ceiling). Parent's child.on('exit') handler
// must NOT write a second recordBridgeFailure for this code: that second
// write would increment n and pick a shorter BACKOFF_SCHEDULE_MS bucket,
// silently overwriting the 1h disabled_until_ts with ~30s.
export const SELF_RECORDED_FAILURE_EXIT_CODE = 2;

export function bridgeDir(collabDir) {
  return path.join(collabDir, BRIDGE_DIR);
}
export function lockPath(collabDir) {
  return path.join(bridgeDir(collabDir), LOCK_FILE);
}
export function logPath(collabDir) {
  return path.join(bridgeDir(collabDir), LOG_FILE);
}
export function circuitPath(collabDir) {
  return path.join(bridgeDir(collabDir), CIRCUIT_FILE);
}

/**
 * Liveness probe. process.kill(pid, 0) does not kill the process — it just
 * checks that we can signal it.
 *
 * Cross-platform behavior:
 *   - ESRCH: process is not running (dead).
 *   - EPERM on Windows: process exists but we can't signal it (owned by
 *     another user, protected process, or Node v21.6.2 regression per
 *     nodejs/node#51766). CRITICAL: must be treated as ALIVE — returning
 *     false here would let a non-admin process false-dead a legit owner
 *     and spawn a duplicate bridge.
 *   - Any other error defaults to ALIVE (fail-safe: do not steal locks
 *     we aren't confident are stale).
 */
export function isProcessAlive(pid) {
  if (!pid || pid <= 0 || !Number.isFinite(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err.code === 'ESRCH') return false;
    if (err.code === 'EPERM') return true;
    return true;
  }
}

export function readLock(collabDir) {
  try {
    return JSON.parse(fs.readFileSync(lockPath(collabDir), 'utf8'));
  } catch (_) {
    return null;
  }
}

/**
 * Attempts to acquire the bridge lock. Single-owner election via fs.openSync
 * with 'wx' (O_CREAT | O_EXCL on POSIX, CREATE_NEW on Windows — atomic per
 * both platforms, see learn.microsoft.com/.../CreateFileW).
 *
 * On contention: reads the existing lock; if the owner PID is dead (ESRCH),
 * unlinks and retries once. A second EEXIST means another process beat us
 * to the reclaim — we surrender cleanly.
 *
 * NOTE: atomicity is not guaranteed on NFS/SMB filesystems
 * (pubs.opengroup.org/.../open.html). .claude/collab/ is assumed to live on
 * a local fs — same assumption as withAgentsLock inherits from.
 *
 * @param {string} collabDir
 * @param {{ sessionId: string, childPid?: number }} opts
 * @returns {{ acquired: boolean, lock: object|null, stale_reclaimed?: boolean }}
 */
export function acquireLock(collabDir, opts) {
  opts = opts || {};
  fs.mkdirSync(bridgeDir(collabDir), { recursive: true });
  const p = lockPath(collabDir);
  const data = {
    owner_pid: process.pid,
    owner_session_id: opts.sessionId || null,
    started_at: Date.now(),
    bridge_child_pid: opts.childPid || null
  };

  try {
    const fd = fs.openSync(p, 'wx');
    fs.writeSync(fd, JSON.stringify(data, null, 2));
    fs.closeSync(fd);
    return { acquired: true, lock: data };
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }

  const existing = readLock(collabDir);
  if (existing && isProcessAlive(existing.owner_pid)) {
    return { acquired: false, lock: existing };
  }
  // Defense-in-depth against a specific race: the previous MCP can release
  // the lock and process.exit in a SIGTERM handler *before* its spawned
  // bridge child has finished shutting down. If a new MCP reclaims the lock
  // during that window and spawns a second bridge, both post duplicate
  // events to Discord and ingest duplicate user_messages on inbound polls.
  // Refuse to reclaim while a previously-spawned child is still alive —
  // it will die on its own (parent-watchdog in bridge.mjs) within a few
  // heartbeat intervals. The wait is bounded and bridge operation is
  // best-effort, so a brief outage is preferable to duplicated state.
  if (existing && existing.bridge_child_pid && isProcessAlive(existing.bridge_child_pid)) {
    return { acquired: false, lock: existing };
  }

  try { fs.unlinkSync(p); } catch (_) {}
  try {
    const fd = fs.openSync(p, 'wx');
    fs.writeSync(fd, JSON.stringify(data, null, 2));
    fs.closeSync(fd);
  } catch (err2) {
    if (err2.code !== 'EEXIST') throw err2;
    return { acquired: false, lock: readLock(collabDir) };
  }
  // TOCTOU post-write verification. `unlink + openSync('wx')` is NOT atomic:
  // another process can unlink our freshly-created lock between our unlink
  // (line above) and our openSync, then openSync its own. Both callers
  // would otherwise return `acquired:true` and spawn duplicate bridges. By
  // re-reading and comparing owner_pid, the loser of such an interleaving
  // sees someone else's lock on disk and backs off.
  const verified = readLock(collabDir);
  if (verified && verified.owner_pid === process.pid &&
      verified.started_at === data.started_at) {
    return { acquired: true, lock: data, stale_reclaimed: true };
  }
  return { acquired: false, lock: verified };
}

/**
 * Releases the lock iff we own it (owner_pid === process.pid). Refuses to
 * unlink other processes' locks — prevents a panicking MCP from evicting a
 * healthy owner.
 *
 * `expectedChildPid` (optional): when passed, only release if the on-disk
 * lock's bridge_child_pid matches. Used by child-exit handlers to avoid
 * unlinking a lock that's since been re-acquired for a replacement child
 * by our own heartbeat (timers fire before poll-phase exit events, so a
 * heartbeat can re-spawn between the child's death and its exit handler).
 */
export function releaseLock(collabDir, expectedChildPid) {
  const existing = readLock(collabDir);
  if (!existing) return false;
  if (existing.owner_pid !== process.pid) return false;
  if (expectedChildPid != null && existing.bridge_child_pid !== expectedChildPid) {
    return false;
  }
  try {
    fs.unlinkSync(lockPath(collabDir));
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Updates the bridge_child_pid field of the lockfile. Only writes if we
 * own the lock. Used when the owning MCP respawns the bridge child.
 */
export function updateChildPid(collabDir, childPid) {
  const existing = readLock(collabDir);
  if (!existing || existing.owner_pid !== process.pid) return false;
  existing.bridge_child_pid = childPid;
  atomicWriteJson(lockPath(collabDir), existing);
  return true;
}

// --------------------------- Log file ---------------------------

export function appendLog(collabDir, line) {
  try {
    fs.mkdirSync(bridgeDir(collabDir), { recursive: true });
  } catch (_) { return; }
  const p = logPath(collabDir);
  const text = line.endsWith('\n') ? line : line + '\n';
  try {
    fs.appendFileSync(p, text, 'utf8');
  } catch (_) {
    // Disk full, permission denied, etc. — bridge log loss is preferable to
    // crashing the daemon.
    return;
  }
  maybeRotateLog(collabDir);
}

export function maybeRotateLog(collabDir) {
  const p = logPath(collabDir);
  let size;
  try { size = fs.statSync(p).size; } catch (_) { return; }
  if (size < LOG_ROTATE_BYTES) return;

  // Rotate highest → lowest so we never clobber an earlier file mid-chain.
  for (let i = LOG_KEEP_COUNT - 1; i >= 1; i--) {
    const from = p + '.' + i;
    const to = p + '.' + (i + 1);
    try { fs.renameSync(from, to); } catch (_) { /* missing is fine */ }
  }
  try { fs.renameSync(p, p + '.1'); } catch (_) {}

  // Prune beyond the keep window (e.g., if LOG_KEEP_COUNT shrunk across
  // restarts, clean leftover .N files one step above).
  try {
    const drop = p + '.' + (LOG_KEEP_COUNT + 1);
    fs.unlinkSync(drop);
  } catch (_) {}
}

// --------------------------- Circuit breaker ---------------------------

export function readCircuitBreaker(collabDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(circuitPath(collabDir), 'utf8'));
    return {
      disabled_until_ts: Number(raw.disabled_until_ts) || 0,
      last_error: typeof raw.last_error === 'string' ? raw.last_error : null,
      consecutive_failures: Number(raw.consecutive_failures) || 0
    };
  } catch (_) {
    return { disabled_until_ts: 0, last_error: null, consecutive_failures: 0 };
  }
}

export function isCircuitOpen(collabDir, nowMs) {
  const now = typeof nowMs === 'number' ? nowMs : Date.now();
  const cb = readCircuitBreaker(collabDir);
  return cb.disabled_until_ts > now;
}

/**
 * Records a bridge child exit failure. Backoff escalates per the plan:
 *   n=1 → 10s, n=2 → 30s, n=3 → 60s, n≥4 → 1 hour cap.
 * Auth failures (401) trip the full 1-hour ceiling immediately since the
 * fix requires user action (token rotation).
 */
export function recordBridgeFailure(collabDir, opts) {
  opts = opts || {};
  const current = readCircuitBreaker(collabDir);
  const n = current.consecutive_failures + 1;
  let backoffMs;
  if (opts.isAuthFailure) {
    backoffMs = AUTH_FAIL_BACKOFF_MS;
  } else if (n - 1 < BACKOFF_SCHEDULE_MS.length) {
    backoffMs = BACKOFF_SCHEDULE_MS[n - 1];
  } else {
    backoffMs = MAX_BACKOFF_MS;
  }
  const next = {
    disabled_until_ts: Date.now() + backoffMs,
    last_error: typeof opts.error === 'string'
      ? opts.error
      : (opts.error && opts.error.message) || null,
    consecutive_failures: n
  };
  atomicWriteJson(circuitPath(collabDir), next);
  return next;
}

/**
 * Clears the circuit breaker on a confirmed-good bridge run (at least one
 * successful REST call + a grace period). No-op when the circuit is already
 * clean so spawn-time success writes don't churn the file.
 */
export function recordBridgeSuccess(collabDir) {
  const current = readCircuitBreaker(collabDir);
  if (current.consecutive_failures === 0 && current.disabled_until_ts <= 0) {
    return current;
  }
  const next = { disabled_until_ts: 0, last_error: null, consecutive_failures: 0 };
  atomicWriteJson(circuitPath(collabDir), next);
  return next;
}
