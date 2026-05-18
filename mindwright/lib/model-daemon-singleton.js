// Singleton election for the machine-wide model daemon, extracted from
// scripts/model-daemon.mjs so the O_EXCL lock race + stale-lock self-heal
// (dead pid / wrong protocol / corrupt JSON) + bounded-retry exhaustion are
// unit-testable without forking a real ONNX daemon. scripts/model-daemon.mjs
// is the sole production caller and must stay statically dep-free, so this
// module imports node:fs + session-liveness + constants only (no native deps).

import { openSync, writeSync, closeSync, readFileSync, unlinkSync } from 'node:fs';
import { isPidAlive as defaultIsPidAlive } from './session-liveness.js';
import { MODEL_DAEMON_PROTOCOL } from './constants.js';

// Become THE daemon: true if we won (and wrote the lock), false if a live
// daemon already owns it (caller exits 0). Self-heals a stale lock (dead pid
// / wrong protocol / corrupt JSON), bounded so a pathological race can't spin
// forever. `isPidAlive` is injectable purely so the liveness branch is
// unit-testable without a real foreign PID; production passes the default
// (same session-liveness probe), keeping behaviour byte-identical.
export function acquireSingleton(lockPath, { isPidAlive = defaultIsPidAlive } = {}) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const fd = openSync(lockPath, 'wx');
      writeSync(
        fd,
        JSON.stringify({
          pid: process.pid,
          protocol: MODEL_DAEMON_PROTOCOL,
          startedAt: new Date().toISOString(),
        }),
      );
      closeSync(fd);
      return true;
    } catch (err) {
      if (!err || err.code !== 'EEXIST') throw err;
      let holder = null;
      try {
        holder = JSON.parse(readFileSync(lockPath, 'utf8'));
      } catch {
        /* unparseable → treat as stale below */
      }
      const liveOwner =
        holder &&
        holder.protocol === MODEL_DAEMON_PROTOCOL &&
        typeof holder.pid === 'number' &&
        holder.pid !== process.pid &&
        isPidAlive(holder.pid);
      if (liveOwner) return false; // another live daemon owns it
      // Stale (dead pid / wrong protocol / corrupt) — clear and retry.
      try { unlinkSync(lockPath); } catch { /* a peer may have just cleared it */ }
    }
  }
  // Lost every race to peers also (re)claiming — defer to whoever won.
  return false;
}
