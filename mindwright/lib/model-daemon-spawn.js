// Client-side lazy spawn for the machine-wide model daemon. Detached +
// fire-and-forget so the caller never blocks on the ONNX cold-load: THIS call
// still degrades (pipe-client null → NULL-embedding write), the daemon comes
// up so the NEXT call connects. Single-flight is the daemon's own O_EXCL lock
// election; the in-process throttle here only dedupes per-process re-spawns.

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { openSync, closeSync } from 'node:fs';
import { PLUGIN_ROOT, modelDaemonLogPath } from './paths.js';
import { logHookError } from './hook-log.js';

// One detached spawn per this window per process: the daemon takes seconds to
// bind+warm, spamming in that gap just burns lock-losing processes.
const SPAWN_THROTTLE_MS = 10_000;
let lastSpawnAt = 0;

// Real implementations are the defaults; the named seams exist ONLY so the
// throttle, the detached-spawn body and the log-fd open/close lifecycle are
// unit-testable without forking a real daemon. Production calls
// ensureModelDaemon() with no args → every default below → byte-identical to
// the un-seamed version.
export function ensureModelDaemon({
  spawn: spawnFn = spawn,
  openLog = () => openSync(modelDaemonLogPath(), 'a'),
  closeFd = closeSync,
  clock = Date.now,
} = {}) {
  if (process.env.MINDWRIGHT_MODEL_DAEMON_DISABLE === '1') return;
  const now = clock();
  if (now - lastSpawnAt < SPAWN_THROTTLE_MS) return;
  lastSpawnAt = now;
  try {
    const script = join(PLUGIN_ROOT, 'scripts', 'model-daemon.mjs');
    // Append the daemon's own stderr to a machine-global log so a failed
    // cold-load is diagnosable; stdin/stdout ignored (no protocol on them).
    let logFd = 'ignore';
    try {
      logFd = openLog();
    } catch {
      logFd = 'ignore';
    }
    const child = spawnFn(process.execPath, [script], {
      detached: true,
      stdio: ['ignore', 'ignore', logFd],
      windowsHide: true,
      env: { ...process.env },
    });
    try { child.unref(); } catch { /* */ }
    if (typeof logFd === 'number') {
      // The child has inherited the fd; close our copy so we don't pin it.
      try { closeFd(logFd); } catch { /* */ }
    }
  } catch (e) {
    try { logHookError('model-daemon', 'ensure spawn failed', e); } catch { /* */ }
  }
}
