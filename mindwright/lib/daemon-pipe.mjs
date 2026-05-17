// Daemon-pipe: tiny newline-delimited JSON-RPC server over a unix socket /
// Windows named pipe, bound by scripts/model-daemon.mjs to the fixed
// machine-global socket. Surface is two methods, `embed` and `rerank`.
//
// Wire format (each side, line-delimited):
//   request:  {"id": <n>, "method": "embed",  "params": ["t1", "t2", ...]}
//   request:  {"id": <n>, "method": "rerank", "params": {"query": "...", "candidates": ["c1", ...]}}
//   response: {"id": <n>, "result": <result>}
//   response: {"id": <n>, "error":  "<message>"}
//
// `embed` vectors are base64 of the raw HOST-ENDIAN Float32Array buffer.
// LOCAL-IPC ONLY: daemon and client are always on the same machine so both
// ends agree on endianness; for cross-host use, switch to explicit
// little-endian via DataView.setFloat32(., true). `rerank` results are
// `number[]` of sigmoid-applied scores.
//
// `embedFn` / `rerankFn` are injectable so tests can stub the wire format
// without loading ONNX.

import net from 'node:net';
import { mkdir, unlink, chmod } from 'node:fs/promises';
import { dirname } from 'node:path';
import { embed as realEmbed, rerank as realRerank } from './models.js';
import { pipePath as derivePipePath } from './paths.js';

// Per-connection input buffer cap (worst legitimate case ~3.2 MB plus
// margin). Without it a newline-less unbounded chunk grows the buffer until
// heap exhaustion (CWE-770); closing the connection drops the payload and
// the client retries or degrades to write-only.
const MAX_BUFFER_BYTES = 16 * 1024 * 1024;

function f32ToBase64(f32) {
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength).toString('base64');
}

async function handleRequest(req, embedFn, rerankFn) {
  if (!req || typeof req !== 'object' || typeof req.method !== 'string') {
    return { id: (req && req.id) ?? null, error: 'invalid request shape' };
  }
  const id = req.id ?? null;
  try {
    if (req.method === 'embed') {
      if (!Array.isArray(req.params)) {
        return { id, error: "embed: params must be a string[]" };
      }
      if (req.params.length === 0) {
        return { id, result: [] };
      }
      if (!req.params.every((t) => typeof t === 'string')) {
        return { id, error: "embed: every element of params must be a string" };
      }
      const vectors = await embedFn(req.params);
      return { id, result: vectors.map(f32ToBase64) };
    }
    if (req.method === 'rerank') {
      const p = req.params || {};
      const { query, candidates } = p;
      if (typeof query !== 'string' || !Array.isArray(candidates)) {
        return { id, error: "rerank: params must be {query: string, candidates: string[]}" };
      }
      if (candidates.length === 0) {
        return { id, result: [] };
      }
      if (!candidates.every((c) => typeof c === 'string')) {
        return { id, error: "rerank: every element of candidates must be a string" };
      }
      const scores = await rerankFn(query, candidates);
      return { id, result: scores };
    }
    return { id, error: `unknown method: ${req.method}` };
  } catch (err) {
    return { id, error: (err && err.message) ? err.message : String(err) };
  }
}

/**
 * Spawn the daemon-pipe JSON-RPC server.
 *
 * @param {object} args
 * @param {string} args.sessionId  used to derive the pipe path when `pipePath` is not given
 * @param {string} [args.pipePath]  explicit pipe path (overrides the sessionId-derived default)
 * @param {(texts: string[]) => Promise<Float32Array[]>} [args.embedFn] default: real models.embed
 * @param {(query: string, candidates: string[]) => Promise<number[]>} [args.rerankFn] default: real models.rerank
 * @param {(err: Error) => void} [args.onError]
 * @param {number} [args.maxBufferBytes] override per-connection buffer cap (test seam; defaults to MAX_BUFFER_BYTES)
 * @returns {Promise<{server: import('node:net').Server, path: string, close: () => Promise<void>}>}
 */
export async function startPipeServer({
  sessionId,
  pipePath = null,
  embedFn = realEmbed,
  rerankFn = realRerank,
  onError = (err) =>
    process.stderr.write(`[mindwright/daemon-pipe] ${err && err.message ? err.message : err}\n`),
  maxBufferBytes = MAX_BUFFER_BYTES,
} = {}) {
  if (!sessionId && !pipePath) {
    throw new Error('startPipeServer: pass either sessionId or pipePath');
  }
  const path = pipePath || derivePipePath(sessionId);

  // On POSIX the pipe is a real file: ensure the parent dir exists and a
  // stale sock from a previous run is removed before binding. Windows's
  // named-pipe namespace handles this automatically.
  if (process.platform !== 'win32') {
    await mkdir(dirname(path), { recursive: true });
    try {
      await unlink(path);
    } catch (err) {
      if (err && err.code !== 'ENOENT') throw err;
    }
  }

  const server = net.createServer((conn) => {
    let buf = '';
    conn.setEncoding('utf8');
    conn.on('data', async (chunk) => {
      buf += chunk;
      if (buf.length > maxBufferBytes) {
        try {
          if (!conn.destroyed) {
            conn.write(
              JSON.stringify({
                id: null,
                error: `request buffer exceeded ${maxBufferBytes} bytes without a newline; closing`,
              }) + '\n'
            );
          }
        } catch { /* peer may already be gone */ }
        buf = '';
        conn.destroy();
        return;
      }
      let idx;
      // Drain every complete line; a single TCP-ish chunk may carry many.
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (!line.trim()) continue;
        let req = null;
        try {
          req = JSON.parse(line);
        } catch (err) {
          const safeId = null;
          conn.write(
            JSON.stringify({ id: safeId, error: `invalid JSON: ${err.message}` }) + '\n'
          );
          continue;
        }
        const res = await handleRequest(req, embedFn, rerankFn);
        // The connection may have been torn down while we were awaiting the
        // model — best-effort write, suppress EPIPE so the server stays up.
        try {
          if (!conn.destroyed) conn.write(JSON.stringify(res) + '\n');
        } catch (err) {
          onError(err);
        }
      }
    });
    conn.on('error', onError);
  });

  server.on('error', onError);

  await new Promise((resolve, reject) => {
    const onListenErr = (err) => {
      server.off('listening', onListenOk);
      reject(err);
    };
    const onListenOk = () => {
      server.off('error', onListenErr);
      resolve();
    };
    server.once('error', onListenErr);
    server.once('listening', onListenOk);
    server.listen(path);
  });

  // POSIX: chmod the socket owner-only so a permissive umask (e.g. 0 in some
  // Docker images) doesn't leave the RPC channel open to co-located local
  // users. Windows has no portable equivalent (Node can't set pipe
  // SECURITY_ATTRIBUTES without native FFI); the threat model accepts this —
  // anyone with local-user access already has the user's full
  // read/write surface.
  if (process.platform !== 'win32') {
    try {
      await chmod(path, 0o600);
    } catch (err) {
      onError(err);
    }
  }

  return {
    server,
    path,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
      }),
  };
}
