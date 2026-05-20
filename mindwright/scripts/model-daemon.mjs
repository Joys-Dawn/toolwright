#!/usr/bin/env node
// mindwright machine-wide model daemon: ONE process per machine owns the
// bge-m3 embedder + gte-reranker-modernbert-base and serves embed/rerank to every session
// across every project over a single fixed global socket — exactly one copy
// of the multi-GB resident model set regardless of how many sessions are open.
//
// Lazily spawned detached by the first client needing embeddings; racing
// spawns are harmless (the lock election picks one winner, the rest exit 0).
// Singleton via an O_EXCL lock file. Idle self-exit after
// MODEL_DAEMON_IDLE_EXIT_MS frees the weights; the next client respawns.
// Deps-less / models-not-cached ⇒ exit cleanly so clients degrade (write
// NULL-embedding rows; a later sweep backfills).

import { unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import { depsInstalled } from '../lib/ready.js';
import {
  modelDaemonSocketPath,
  modelDaemonLockPath,
  embedderCached,
} from '../lib/paths.js';
import { acquireSingleton } from '../lib/model-daemon-singleton.js';
import {
  MODEL_DAEMON_PROTOCOL,
  MODEL_DAEMON_IDLE_EXIT_MS,
  MODEL_DAEMON_RSS_LIMIT_BYTES,
} from '../lib/constants.js';

const log = (m) => process.stderr.write(`[mindwright/modeld] ${m}\n`);

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
    /* best-effort; acquireSingleton's lock open below surfaces a real failure */
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
  const shutdown = async (why) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`shutting down (${why})`);
    try { handle && handle.close(); } catch { /* */ }
    // Release the native ONNX sessions before exit. Process exit reclaims
    // anyway, but disposing first is correct and lets a future
    // unload-without-exit path reuse this. disposeModels never throws.
    try { await disposeModels(); } catch { /* */ }
    cleanup();
    process.exit(0);
  };

  // Imported AFTER the deps gate — startPipeServer statically pulls in
  // lib/models.js (ONNX/transformers), which must not load in a deps-less
  // process.
  const { startPipeServer } = await import('../lib/daemon-pipe.mjs');
  const { embed: realEmbed, rerank: realRerank, disposeModels } = await import('../lib/models.js');

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

  // Health monitor: idle self-exit OR RSS-ceiling self-recycle. The socket
  // server is the event-loop liveness anchor, so unref the timer — it must
  // not keep the process alive on its own. Both paths route through the same
  // shutdown (close socket → dispose models → exit); the next client
  // respawns a fresh daemon via the lock election, so a recycle is
  // transparent (that one call degrades to a NULL-embedding write and the
  // sweeper backfills).
  const monitorTimer = setInterval(() => {
    if (Date.now() - lastActivity >= MODEL_DAEMON_IDLE_EXIT_MS) {
      shutdown('idle');
      return;
    }
    const rss = process.memoryUsage().rss;
    if (rss >= MODEL_DAEMON_RSS_LIMIT_BYTES) {
      log(
        `RSS ${Math.round(rss / 1048576)} MB >= limit ` +
          `${Math.round(MODEL_DAEMON_RSS_LIMIT_BYTES / 1048576)} MB`,
      );
      shutdown('rss-recycle');
    }
  }, 60_000);
  if (typeof monitorTimer.unref === 'function') monitorTimer.unref();

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
