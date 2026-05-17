// pipe-client: thin JSON-RPC client used by hooks to talk to the in-session
// MCP daemon's pipe server (mcp/daemon-pipe.mjs). Every method opens a fresh
// connection, sends a single newline-delimited JSON request, awaits one
// newline-delimited JSON response, then tears the connection down. Local
// named-pipe / unix-socket connect+call+disconnect lands in single-digit ms,
// so the simplicity is cheaper than reusing connections across hook firings.
//
// The whole point of returning `null` (instead of throwing) on connect-fail
// / EPIPE / timeout is to give hooks a clean degradation path: when the
// daemon is down they still write transcript chunks into `entries` with
// `embedding=NULL`, skip retrieval for that turn, and let the next-live
// daemon's sweeper batch-embed the deferred rows. See DESIGN.md
// "Daemon liveness" for the full degradation story.

import net from 'node:net';
import { modelDaemonSocketPath } from './paths.js';
import { ensureModelDaemon } from './model-daemon-spawn.js';
import { PIPE_DEFAULT_TIMEOUT_MS } from './constants.js';

const DEFAULT_TIMEOUT_MS = PIPE_DEFAULT_TIMEOUT_MS;

function base64ToF32(b64) {
  const buf = Buffer.from(b64, 'base64');
  // The Buffer is backed by a possibly-pooled ArrayBuffer; copy into a
  // fresh ArrayBuffer so the returned view isn't tied to Buffer's pool slice
  // (an unrelated write to the pool could otherwise corrupt this view).
  // Same pattern as store.js getLastQueryEmb — keep it consistent.
  const ab = new ArrayBuffer(buf.byteLength);
  const dst = new Uint8Array(ab);
  dst.set(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
  return new Float32Array(ab);
}

function sendOne(path, payload, timeoutMs) {
  return new Promise((resolve) => {
    let resolved = false;
    let buf = '';
    // Single cleanup point: clears the timeout, destroys the socket, and
    // resolves the promise. Every path (timer, parse, error, end, close,
    // write-throw) calls finish() — callers no longer need to remember
    // clearTimeout. The `resolved` flag makes late firings (e.g. 'close'
    // after 'error') safe.
    const finish = (val) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      try {
        conn.destroy();
      } catch {
        // socket already torn down; nothing to clean up
      }
      resolve(val);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    if (timer.unref) timer.unref();

    let conn;
    try {
      conn = net.createConnection(path);
    } catch {
      clearTimeout(timer);
      resolve(null);
      return;
    }
    conn.setEncoding('utf8');

    conn.once('connect', () => {
      try {
        conn.write(JSON.stringify(payload) + '\n');
      } catch {
        finish(null);
      }
    });
    conn.on('data', (chunk) => {
      buf += chunk;
      const idx = buf.indexOf('\n');
      if (idx < 0) return;
      const line = buf.slice(0, idx);
      try {
        const res = JSON.parse(line);
        if (res && res.error) {
          // Surface the daemon's diagnostic so a server-side failure
          // (bad params, model exception, oversized buffer) is visible to
          // the operator instead of collapsing into the same `null` the
          // hooks use for "daemon is down".
          process.stderr.write(
            `mindwright/pipe-client: daemon error on ${payload.method}: ${res.error}\n`,
          );
          finish(null);
          return;
        }
        finish(res ? res.result : null);
      } catch {
        finish(null);
      }
    });
    // Any teardown signal — error, end, close — means the daemon is gone or
    // the socket is unusable; collapse into a single null-resolve path. The
    // `resolved` flag inside finish() makes the once() registrations safe
    // against the late `close` fire that always follows `error`/`end`.
    const bailOut = () => finish(null);
    conn.once('error', bailOut);
    conn.once('end', bailOut);
    conn.once('close', bailOut);
  });
}

/**
 * Build a client to the MACHINE-WIDE model daemon (one per box, shared by
 * every session/project). The returned object is stateless; each method opens
 * and closes its own connection. On any connect failure the method returns
 * `null` (caller degrades) AND fire-and-forget respawns the daemon so the
 * next call connects — the daemon's lock election dedupes concurrent spawns.
 *
 * `sessionId` is accepted for call-site compatibility (hooks pass theirs) but
 * is no longer part of the socket path — the daemon is not per-session.
 *
 * @param {string} [sessionId] ignored; kept for signature stability
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs] per-call timeout in ms (default 5000)
 * @returns {{
 *   embed: (texts: string[]) => Promise<Float32Array[]|null>,
 *   rerank: (query: string, candidates: string[]) => Promise<number[]|null>,
 *   close: () => void,
 * }}
 */
export function connectPipe(sessionId, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const path = modelDaemonSocketPath();

  // Each method opens a FRESH socket, so there's no in-flight request to
  // correlate against — the connection itself is the correlation. The
  // daemon echoes back req.id when set but the client never reads it, so
  // we omit it entirely; the daemon's `req.id ?? null` handles the absence.

  return {
    /**
     * Embed a batch of texts via the daemon. Returns `null` on failure
     * (server down, timeout, malformed response) so the caller can degrade.
     * An empty `texts` returns `[]` without ever touching the pipe.
     */
    async embed(texts) {
      if (!Array.isArray(texts)) return null;
      if (texts.length === 0) return [];
      const result = await sendOne(
        path,
        { method: 'embed', params: texts },
        timeoutMs
      );
      if (!Array.isArray(result)) {
        ensureModelDaemon(); // down/booting — bring it up for the next call
        return null;
      }
      try {
        return result.map(base64ToF32);
      } catch {
        return null;
      }
    },

    /**
     * Score (query, candidate) pairs via the daemon. Returns `null` on
     * failure. Empty `candidates` returns `[]` without touching the pipe.
     */
    async rerank(query, candidates) {
      if (typeof query !== 'string') return null;
      if (!Array.isArray(candidates)) return null;
      if (candidates.length === 0) return [];
      const result = await sendOne(
        path,
        { method: 'rerank', params: { query, candidates } },
        timeoutMs
      );
      if (!Array.isArray(result)) {
        ensureModelDaemon(); // down/booting — bring it up for the next call
        return null;
      }
      return result;
    },

    /**
     * No-op — the client doesn't hold a persistent connection. Provided for
     * API symmetry with other pooled-connection styles.
     */
    close() {
      /* intentionally empty */
    },
  };
}
