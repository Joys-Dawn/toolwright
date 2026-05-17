// Thin JSON-RPC client to the machine-wide model daemon's pipe server
// (mcp/daemon-pipe.mjs). Every method opens a fresh connection, sends one
// newline-delimited JSON request, awaits one response, tears it down — a
// local socket connect+call+disconnect is single-digit ms, cheaper than
// pooling across hook firings.
//
// DEGRADE-TO-NULL CONTRACT: returns `null` (never throws) on connect-fail /
// EPIPE / timeout so hooks degrade cleanly — they still write transcript
// chunks with embedding=NULL, skip retrieval that turn, and let the sweeper
// batch-embed the deferred rows later.

import net from 'node:net';
import { modelDaemonSocketPath } from './paths.js';
import { ensureModelDaemon } from './model-daemon-spawn.js';
import { PIPE_DEFAULT_TIMEOUT_MS } from './constants.js';

const DEFAULT_TIMEOUT_MS = PIPE_DEFAULT_TIMEOUT_MS;

function base64ToF32(b64) {
  const buf = Buffer.from(b64, 'base64');
  // Buffer is backed by a possibly-pooled ArrayBuffer; copy into a fresh one
  // so an unrelated write to the pool can't corrupt the returned view.
  const ab = new ArrayBuffer(buf.byteLength);
  const dst = new Uint8Array(ab);
  dst.set(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
  return new Float32Array(ab);
}

function sendOne(path, payload, timeoutMs) {
  return new Promise((resolve) => {
    let resolved = false;
    let buf = '';
    // Single cleanup point. The `resolved` flag makes late firings (e.g.
    // 'close' after 'error') safe.
    const finish = (val) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      try {
        conn.destroy();
      } catch {
        // socket already torn down
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
          // Surface the daemon's diagnostic so a server-side failure is
          // visible instead of collapsing into the "daemon down" null.
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
    // Any teardown signal (error/end/close) ⇒ daemon gone / socket unusable;
    // collapse to a single null-resolve. `resolved` makes the late `close`
    // after `error`/`end` safe.
    const bailOut = () => finish(null);
    conn.once('error', bailOut);
    conn.once('end', bailOut);
    conn.once('close', bailOut);
  });
}

/**
 * Client to the MACHINE-WIDE model daemon (one per box, shared by every
 * session/project). Stateless; on connect failure returns `null` AND
 * fire-and-forget respawns the daemon (lock election dedupes spawns).
 *
 * `sessionId` is ignored — the daemon is not per-session — but accepted for
 * call-site stability (hooks pass theirs).
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

  return {
    /**
     * Embed a batch of texts. `null` on failure (caller degrades); `[]` for
     * empty input without touching the pipe.
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
        ensureModelDaemon(); // down/booting — bring it up for next call
        return null;
      }
      try {
        return result.map(base64ToF32);
      } catch {
        return null;
      }
    },

    /**
     * Score (query, candidate) pairs. `null` on failure; `[]` for empty
     * candidates without touching the pipe.
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
        ensureModelDaemon(); // down/booting — bring it up for next call
        return null;
      }
      return result;
    },

    // No-op: no persistent connection. Kept for API symmetry.
    close() {
      /* intentionally empty */
    },
  };
}
