// Client-side lazy spawn for the machine-wide model daemon.
//
// Hooks and skill scripts call ensureModelDaemon() when an embed/rerank RPC
// finds the socket down. The spawn is detached + fire-and-forget: we never
// block the caller on a multi-second ONNX cold-load. THIS call still degrades
// (the pipe-client returns null → NULL-embedding write + later sweep); the
// daemon comes up in the background so the NEXT call connects.
//
// Single-flight is owned by the daemon's own O_EXCL lock election
// (mcp/model-daemon.mjs#acquireSingleton): racing spawns from many sessions
// are harmless — exactly one wins, the rest exit 0. The in-process throttle
// here only avoids re-spawning on every hook firing within one process.

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { openSync, closeSync } from 'node:fs';
import { PLUGIN_ROOT, modelDaemonLogPath } from './paths.js';
import { logHookError } from './hook-log.js';

// Don't re-fire the detached spawn more than once per this window per process.
// The daemon takes a few seconds to bind + warm; spamming spawns in that gap
// just burns processes that all lose the lock election.
const SPAWN_THROTTLE_MS = 10_000;
let lastSpawnAt = 0;

export function ensureModelDaemon() {
  if (process.env.MINDWRIGHT_MODEL_DAEMON_DISABLE === '1') return;
  const now = Date.now();
  if (now - lastSpawnAt < SPAWN_THROTTLE_MS) return;
  lastSpawnAt = now;
  try {
    const script = join(PLUGIN_ROOT, 'mcp', 'model-daemon.mjs');
    // Append the daemon's own stderr to a machine-global log so a failed
    // cold-load is diagnosable; stdin/stdout ignored (no protocol on them).
    let logFd = 'ignore';
    try {
      logFd = openSync(modelDaemonLogPath(), 'a');
    } catch {
      logFd = 'ignore';
    }
    const child = spawn(process.execPath, [script], {
      detached: true,
      stdio: ['ignore', 'ignore', logFd],
      windowsHide: true,
      env: { ...process.env },
    });
    try { child.unref(); } catch { /* */ }
    if (typeof logFd === 'number') {
      // The child has inherited the fd; close our copy so we don't pin it.
      try { closeSync(logFd); } catch { /* */ }
    }
  } catch (e) {
    try { logHookError('model-daemon', 'ensure spawn failed', e); } catch { /* */ }
  }
}
