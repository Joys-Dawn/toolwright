// Daemon-pipe: tiny newline-delimited JSON-RPC server over a per-session
// Windows named pipe (`\\.\pipe\mindwright-<sessionId>`) or POSIX unix
// socket (`<.claude/mindwright>/daemon-<sessionId>.sock`). The MCP server
// process spawns this so hooks can offload hot-model calls (embed + rerank)
// onto the persistent daemon and avoid paying the ~1-3 s ONNX cold-load
// cost per PreToolUse firing.
//
// Surface is intentionally minimal: two methods, `embed` and `rerank`. All
// DB I/O stays in the hooks' own better-sqlite3 connections (WAL handles
// the concurrency). See DESIGN.md "Architecture sketch" / "Daemon pattern".
//
// Wire format (each side, line-delimited):
//   request:  {"id": <n>, "method": "embed",  "params": ["t1", "t2", ...]}
//   request:  {"id": <n>, "method": "rerank", "params": {"query": "...", "candidates": ["c1", ...]}}
//   response: {"id": <n>, "result": <result>}
//   response: {"id": <n>, "error":  "<message>"}
//
// `embed` results are Float32Array[]; each vector is base64-encoded from the
// raw HOST-ENDIAN byte buffer of the typed array. JavaScript's Float32Array
// uses the platform's native endianness — little-endian on x86/ARM, big on
// the rare legacy big-endian box. Since the daemon and the pipe-client always
// run on the SAME machine over a named pipe / unix socket, both ends agree
// on endianness and the round-trip Float32Array → Buffer → base64 → ArrayBuffer
// → Float32Array reproduces the original bits losslessly. This wire format is
// LOCAL-IPC ONLY. If we ever extend the daemon to accept connections from a
// different host, switch to explicit little-endian via DataView.setFloat32(.,
// true). `rerank` results are plain `number[]` of sigmoid-applied scores.
//
// `embedFn` / `rerankFn` are constructor injectable. Production code passes
// the real `lib/models.js` exports; tests pass stubs so `daemon-pipe.test.mjs`
// doesn't need to download or load ONNX runtime to validate the wire format.

import net from 'node:net';
import { mkdir, unlink, chmod } from 'node:fs/promises';
import { dirname } from 'node:path';
import { embed as realEmbed, rerank as realRerank } from '../lib/models.js';
import { pipePath as derivePipePath } from '../lib/paths.js';

// Per-connection input buffer cap. Sized for the worst legitimate case
// (~100 texts × 32 KB ≈ 3.2 MB for an embed batch; same order of magnitude
// for rerank candidate lists) plus margin. A client that sends an unbounded
// chunk with no newline can otherwise grow the buffer until heap exhaustion
// and crash the daemon — CWE-770. Closing the connection drops the in-flight
// payload; the client either retries with a sane size or the hook degrades
// to write-only via the pipe-client's existing null-return path.
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

  // On POSIX the pipe is a real file under .claude/mindwright/. Make sure
  // the parent dir exists and a stale sock from a previous run is removed
  // before we try to bind. On Windows the named-pipe namespace handles this
  // automatically; node:net rejects re-binding if it's already in use.
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
        // Refuse to keep growing. Best-effort error reply, then close.
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

  // POSIX defense-in-depth: lock the socket to owner-only so a permissive
  // umask (e.g. 0 in some Docker images / shared shells) doesn't leave the
  // RPC channel accessible to co-located local users. Per-session path is
  // already the primary boundary; this closes the file-mode side door.
  //
  // WINDOWS LIMITATION: this chmod is POSIX-only. The named pipe namespace
  // `\\.\pipe\mindwright-<sessionId>` is by default accessible to any local
  // process on the same Windows machine — Node's net.createServer does not
  // expose a portable way to set the pipe SECURITY_ATTRIBUTES from JS, and
  // Win32 SetNamedPipeHandleState/SetKernelObjectSecurity require native
  // FFI. On Windows the per-session id (typically a UUIDv4 from Claude Code,
  // matched against SESSION_ID_PATTERN) is therefore the SOLE boundary
  // against a co-located local user discovering the pipe — a co-located
  // attacker who can read ps/env can also read the session id and connect.
  // Threat model accepts this: mindwright runs in the user's own session;
  // anyone with local-user access on the same Windows box already has the
  // user's full project read/write surface.
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
