// Liveness of the MACHINE-WIDE model daemon (the embedder/reranker host) —
// distinct from session-liveness.js (a Claude session bound to this project).
//
// Industry-standard local-service liveness is a connection probe against the
// service's own endpoint (cf. pg_isready, redis ping, Kubernetes TCP-socket
// liveness probes), NOT an inference from a sidecar file. The daemon already
// listens on a fixed socket; a bare connect that the listener accepts proves
// it is serving. We deliberately do NOT consult the singleton lock file here:
// the lock is an election primitive (model-daemon-singleton.js), and a held
// lock with no accepting listener (daemon mid-cold-load, or crashed mid-boot)
// is precisely the "down for the caller right now" case both consumers —
// /mindwright:status and the pending-embeds warning — must report honestly.
// Conflating "lock exists" with "serving" is the mislabel best-practices-2
// flagged.

import net from 'node:net';
import { modelDaemonSocketPath } from './paths.js';

/**
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs] connect timeout (default 1000ms; a local
 *   IPC connect is single-digit ms, this only bounds a hung/absent endpoint)
 * @returns {Promise<boolean>} true iff a connection to the daemon socket is
 *   accepted within the timeout. Never throws.
 */
export function isModelDaemonAlive({ timeoutMs = 1000 } = {}) {
  return new Promise((resolve) => {
    const path = modelDaemonSocketPath();
    let done = false;
    let conn;
    const finish = (val) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        if (conn) conn.destroy();
      } catch {
        /* already torn down */
      }
      resolve(val);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    if (timer.unref) timer.unref();

    try {
      conn = net.createConnection(path);
    } catch {
      finish(false);
      return;
    }
    // Listener accepted → daemon is serving. We speak no protocol on this
    // probe; a bare accepted connect is the liveness signal.
    conn.once('connect', () => finish(true));
    // ENOENT (no socket/pipe), ECONNREFUSED (stale socket, no listener),
    // end/close before connect → not serving.
    conn.once('error', () => finish(false));
    conn.once('close', () => finish(false));
  });
}
