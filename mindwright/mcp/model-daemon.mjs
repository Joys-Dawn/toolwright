#!/usr/bin/env node
// mindwright machine-wide model daemon: ONE process per machine owns the
// bge-m3 embedder + bge-reranker and serves embed/rerank to every session
// across every project over a single fixed global socket — exactly one copy
// of the ~1-2 GB ONNX weights regardless of how many sessions are open.
//
// Lazily spawned detached by the first client needing embeddings; racing
// spawns are harmless (the lock election picks one winner, the rest exit 0).
// Singleton via an O_EXCL lock file. Idle self-exit after
// MODEL_DAEMON_IDLE_EXIT_MS frees the weights; the next client respawns.
// Deps-less / models-not-cached ⇒ exit cleanly so clients degrade (write
// NULL-embedding rows; a later sweep backfills).

import { openSync, writeSync, closeSync, readFileSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import { depsInstalled } from '../lib/ready.js';
import {
  modelDaemonSocketPath,
  modelDaemonLockPath,
  embedderCached,
} from '../lib/paths.js';
import { isPidAlive } from '../lib/daemon-status.js';
import { MODEL_DAEMON_PROTOCOL, MODEL_DAEMON_IDLE_EXIT_MS } from '../lib/constants.js';

const log = (m) => process.stderr.write(`[mindwright/modeld] ${m}\n`);

// Become THE daemon: true if we won (and wrote the lock), false if a live
// daemon already owns it (caller exits 0). Self-heals a stale lock (dead pid
// / wrong protocol), bounded so a pathological race can't spin forever.
function acquireSingleton(lockPath) {
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

async function main() {
  const socketPath = modelDaemonSocketPath();
  const lockPath = modelDaemonLockPath();

  // A model daemon with no models is pointless: exit cleanly so the client
  // degrades (NULL-embedding write + later sweep) instead of hanging.
  if (!depsInstalled()) {
    log('native deps not installed — exiting (clients degrade until deps heal)');
    return;
  }
  if (!embedderCached()) {
    log('models not cached (run /mindwright:setup) — exiting (clients degrade)');
    return;
  }

  try {
    mkdirSync(dirname(lockPath), { recursive: true });
  } catch {
    /* best-effort; openSync below surfaces a real failure */
  }

  if (!acquireSingleton(lockPath)) {
    log('another live model daemon already owns the socket — exiting');
    return;
  }

  let shuttingDown = false;
  const cleanup = () => {
    try { unlinkSync(lockPath); } catch { /* */ }
    if (process.platform !== 'win32') {
      try { unlinkSync(socketPath); } catch { /* */ }
    }
  };
  const shutdown = (why) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`shutting down (${why})`);
    try { handle && handle.close(); } catch { /* */ }
    cleanup();
    process.exit(0);
  };

  // Imported AFTER the deps gate — startPipeServer statically pulls in
  // lib/models.js (ONNX/transformers), which must not load in a deps-less
  // process.
  const { startPipeServer } = await import('./daemon-pipe.mjs');
  const { embed: realEmbed, rerank: realRerank } = await import('../lib/models.js');

  let lastActivity = Date.now();
  const touch = () => { lastActivity = Date.now(); };
  const embedFn = (texts) => { touch(); return realEmbed(texts); };
  const rerankFn = (q, c) => { touch(); return realRerank(q, c); };

  let handle;
  try {
    handle = await startPipeServer({ pipePath: socketPath, embedFn, rerankFn });
  } catch (err) {
    log(`failed to bind socket: ${err && err.message ? err.message : err}`);
    cleanup();
    process.exit(1);
    return;
  }
  log(`listening at ${handle.path} (pid ${process.pid}, protocol ${MODEL_DAEMON_PROTOCOL})`);

  // Idle self-exit. The socket server is the event-loop liveness anchor, so
  // unref the timer — it must not keep the process alive on its own.
  const idleTimer = setInterval(() => {
    if (Date.now() - lastActivity >= MODEL_DAEMON_IDLE_EXIT_MS) {
      shutdown('idle');
    }
  }, 60_000);
  if (typeof idleTimer.unref === 'function') idleTimer.unref();

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('exit', cleanup);
}

main().catch((err) => {
  process.stderr.write(
    `[mindwright/modeld] fatal: ${err && err.stack ? err.stack : err && err.message ? err.message : err}\n`,
  );
  process.exit(1);
});
