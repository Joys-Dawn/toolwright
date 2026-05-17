#!/usr/bin/env node
/**
 * mindwright MCP server — spawned per Claude session via plugin.json.
 *
 * In-process this single Node process owns:
 *   - the writable SQLite connection (better-sqlite3 + sqlite-vec + FTS5),
 *   - the embedder + reranker singletons from lib/models.js,
 *   - the daemon-pipe JSON-RPC server (so hooks can offload embed/rerank
 *     onto it instead of paying the ONNX cold-load themselves),
 *   - a 60-second sweeper that back-fills embeddings for short-term rows
 *     written in degraded (no-embed) mode by hooks while the daemon was
 *     booting.
 *
 * The MCP stdio transport keeps stdin attached, and the daemon-pipe
 * socket holds a listener — between them the event loop has real
 * liveness anchors, so no separate heartbeat is needed.
 *
 * Hooks live in separate processes and reach the embedder/reranker through
 * `lib/pipe-client.js`. The MCP tools defined in tools.mjs run *here*, so
 * they call into the local model functions directly — no pipe round-trip.
 *
 * Two test-only env hooks are honored:
 *   - MINDWRIGHT_SESSION_ID: skip ticket polling; bind directly to this id.
 *     Used by test/mcp/server.test.mjs, where the test owns both ends.
 *   - MINDWRIGHT_USE_STUB_MODELS=1: replace lib/models.js' embed/rerank with
 *     deterministic stubs (constant Float32Array of 0.5s; rerank scores
 *     0.5 + i*0.01). Lets the server-roundtrip test run without ONNX.
 */

// MCP SDK is resolved from the persistent ${CLAUDE_PLUGIN_DATA}/node_modules
// via lib/native-require.js (see that file's header). The SDK is CJS, so the
// symbols live on the module.exports object — loadNativeDefault() returns it.
// Top-level await is safe: this impl module is only ever loaded AFTER the
// readiness gate, through the MCP shim.
import { loadNativeDefault } from '../lib/native-require.js';
const { Server } = await loadNativeDefault('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = await loadNativeDefault('@modelcontextprotocol/sdk/server/stdio.js');
const { ListToolsRequestSchema, CallToolRequestSchema } =
  await loadNativeDefault('@modelcontextprotocol/sdk/types.js');
import { utimesSync } from 'node:fs';

import { bindOwnSession } from './session-bind.mjs';
import { startPipeServer } from './daemon-pipe.mjs';
import { getToolDefinitions, handleToolCall } from './tools.mjs';
import { openStore } from '../lib/store.js';
import { UNBOUND_SESSION_ID } from '../lib/constants.js';
import { embed as realEmbed, rerank as realRerank, EMBEDDING_DIM } from '../lib/models.js';
import { pipePath as derivePipePath } from '../lib/paths.js';
import { startSweeperLoop } from '../lib/sweeper-loop.js';

const SERVER_NAME = 'mindwright';
const SERVER_VERSION = '0.2.0';
const SWEEPER_INTERVAL_MS = 60_000;
const SWEEPER_BATCH = 50;
// Periodic ticket-touch interval. Honors the liveness contract documented
// in lib/constants.js#DAEMON_TICKET_MAX_AGE_MS: as long as this daemon runs,
// its ticket file's mtime stays inside the 10-minute freshness window so
// isDaemonAlive() reports true and reset.js refuses to delete the live DB.
// 60s gives ~10x headroom against the 10-minute freshness window — well
// inside the budget even if a tick is delayed.
const TICKET_TOUCH_INTERVAL_MS = 60_000;

// Test-only deterministic stubs. The shape matches real `embed` / `rerank`:
// embed returns Float32Array[] of length EMBEDDING_DIM, rerank returns
// number[] of post-sigmoid scores.
function stubEmbed(texts) {
  return Promise.resolve(
    texts.map(() => {
      const v = new Float32Array(EMBEDDING_DIM);
      v.fill(0.5);
      return v;
    })
  );
}
function stubRerank(_query, candidates) {
  return Promise.resolve(candidates.map((_, i) => 0.5 + i * 0.01));
}

function pickModelFns() {
  if (process.env.MINDWRIGHT_USE_STUB_MODELS === '1') {
    return { embedFn: stubEmbed, rerankFn: stubRerank };
  }
  return { embedFn: realEmbed, rerankFn: realRerank };
}

async function resolveBinding() {
  if (process.env.MINDWRIGHT_SESSION_ID) {
    // Test-only bypass: no ticket file exists in this path, so we skip the
    // periodic touch loop (ticketPath=null disables it).
    return { sessionId: process.env.MINDWRIGHT_SESSION_ID, ticketPath: null };
  }
  return bindOwnSession();
}

export async function main() {
  const { embedFn, rerankFn } = pickModelFns();

  // Open the writable store FIRST so migrations have run by the time tool
  // calls hit; if the DB is wedged, fail loud before announcing capabilities.
  const store = openStore({});

  // Connect stdio transport BEFORE any slow init so the MCP handshake
  // completes within the client's deadline (~5s). Tools called before the
  // sessionId resolves return a clean "not initialized" error via tools.mjs.
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: { tools: {} },
      instructions:
        'mindwright: per-agent memory + cross-session learning for Claude Code multi-agent setups.\n' +
        'Tools: mindwright_recall (TEMPR retrieval), mindwright_retain (explicit save), mindwright_status (diagnostic), mindwright_drain_batch / mindwright_retain_fact / mindwright_mark_superseded / mindwright_finalize_drain (dream-cycle helpers), mindwright_get_roles / mindwright_assign_role / mindwright_unassign_role (role management), mindwright_update_memory (single-fact supersede), mindwright_resolve_contradiction (4-way clash resolver).\n' +
        'See SKILL.md bodies under skills/ for the cycle protocols; do not call dream-cycle helpers ad-hoc.',
    }
  );

  // Tool dispatch. `ctx` is built fresh per call so a late session-bind
  // re-resolution lands without restarting the server.
  let sessionId = null;
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: getToolDefinitions(),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    return handleToolCall(name, args || {}, {
      store,
      sessionId,
      embed: embedFn,
      rerank: rerankFn,
    });
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`[mindwright/mcp] server running on stdio\n`);

  // Resolve session id. In unbound mode we still serve, but the store's
  // implicit-sessionId fields (consolidator fallback, retain author) use
  // UNBOUND_SESSION_ID. The first tool call after a successful late bind
  // picks up the resolved id via closure.
  let ticketPath = null;
  const binding = await resolveBinding();
  if (binding) {
    sessionId = binding.sessionId;
    ticketPath = binding.ticketPath;
    store.setSessionId(sessionId);
    process.stderr.write(`[mindwright/mcp] bound to session ${sessionId}\n`);
  } else {
    store.setSessionId(UNBOUND_SESSION_ID);
    process.stderr.write(
      `[mindwright/mcp] no session ticket — running in unbound mode (tools will still work but author=unbound)\n`
    );
  }

  // Keep our own ticket file fresh so isDaemonAlive() reports true while we
  // run. Without this, reset.js falsely concludes the daemon is dead 10
  // minutes into a live session and deletes the DB underneath us. The MCP
  // server is the only process that knows it's still alive — the hook that
  // wrote the ticket exited long ago. Skips when there's no ticket
  // (unbound mode or MINDWRIGHT_SESSION_ID bypass).
  let ticketTouchTimer = null;
  if (ticketPath) {
    ticketTouchTimer = setInterval(() => {
      try {
        const now = new Date();
        utimesSync(ticketPath, now, now);
      } catch (err) {
        process.stderr.write(
          `[mindwright/mcp] ticket touch failed: ${err && err.message ? err.message : err}\n`
        );
      }
    }, TICKET_TOUCH_INTERVAL_MS);
    if (typeof ticketTouchTimer.unref === 'function') ticketTouchTimer.unref();
  }

  // Spawn the daemon-pipe so hooks can offload model calls. Bound to the
  // resolved sessionId; if we never bound, we still need a path to listen
  // on so a late-arriving hook (with the matching ticket) can connect.
  // Skip when there's no session — there is no pipe path without an id.
  let pipeHandle = null;
  if (sessionId) {
    try {
      pipeHandle = await startPipeServer({
        pipePath: derivePipePath(sessionId),
        embedFn,
        rerankFn,
      });
      process.stderr.write(`[mindwright/mcp] daemon-pipe listening at ${pipeHandle.path}\n`);
    } catch (err) {
      process.stderr.write(
        `[mindwright/mcp] daemon-pipe failed to bind: ${err.message} — hooks will degrade to NULL-embedding inserts\n`
      );
    }
  }

  // Deferred-embed sweeper. Hooks that booted while the daemon-pipe was
  // unavailable insert short-term rows with NULL embedding; this loop
  // back-fills them in batches so retrieval recall stays honest. See
  // lib/sweeper-loop.js for why we use a self-rescheduling setTimeout chain
  // rather than setInterval (avoiding concurrent sweeps when the per-text
  // fallback path stretches a tick past the 60s interval).
  const sweeper = startSweeperLoop({
    sweep: () => sweepOnce(store, embedFn),
    intervalMs: SWEEPER_INTERVAL_MS,
    onError: (err) => {
      process.stderr.write(
        `[mindwright/mcp] sweeper error: ${err && err.message ? err.message : err}\n`
      );
    },
  });

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stderr.write(`[mindwright/mcp] ${signal} received, shutting down\n`);
    sweeper.stop();
    if (ticketTouchTimer) clearInterval(ticketTouchTimer);
    if (pipeHandle) {
      try {
        await pipeHandle.close();
      } catch {
        // best-effort
      }
    }
    try {
      store.close();
    } catch {
      // best-effort
    }
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

// Exported for unit tests. Hooks that booted while the daemon-pipe was
// unavailable insert short-term rows with NULL embedding; this back-fills
// them in batches so retrieval recall stays honest. Designed to never
// throw: embedFn rejection, per-vector type mismatch, and per-row
// writeEmbedding errors are all logged and swallowed so a transient
// failure does not wedge the 60s sweep loop.
export async function sweepOnce(store, embedFn) {
  const pending = store.pendingEmbedSweep(SWEEPER_BATCH);
  if (!pending.length) return;
  const texts = pending.map((r) => r.content);
  let vectors;
  // alreadyBumped[i] is true when the per-row retry path already incremented
  // the failure counter for pending[i] — prevents double-bumping in the
  // write loop below.
  const alreadyBumped = new Array(pending.length).fill(false);
  try {
    vectors = await embedFn(texts);
  } catch (err) {
    // Batch-level failure used to return without making forward progress,
    // so a single poison row (content that crashes the tokenizer, oversized
    // input, etc.) wedged the entire sweep loop and the backlog grew without
    // bound. Fall back to per-text embedding so the rest of the batch lands;
    // texts that still fail individually have their embed_failures bumped
    // and eventually drop out of pendingEmbedSweep.
    process.stderr.write(
      `[mindwright/mcp] sweeper batch-embed failed, retrying per-text: ${err && err.message ? err.message : err}\n`
    );
    vectors = new Array(pending.length).fill(null);
    for (let i = 0; i < pending.length; i++) {
      try {
        const single = await embedFn([texts[i]]);
        if (Array.isArray(single) && single[0] instanceof Float32Array) {
          vectors[i] = single[0];
        } else {
          // Embedder returned but produced no valid vector — count as a
          // failed attempt against this row so persistent poison content
          // eventually drops out of the sweep queue.
          try { store.bumpEmbedFailure(pending[i].id); alreadyBumped[i] = true; } catch { /* */ }
        }
      } catch (perRowErr) {
        process.stderr.write(
          `[mindwright/mcp] sweeper per-text embed failed for id=${pending[i].id}: ${perRowErr && perRowErr.message ? perRowErr.message : perRowErr}\n`
        );
        try { store.bumpEmbedFailure(pending[i].id); alreadyBumped[i] = true; } catch { /* */ }
      }
    }
  }
  for (let i = 0; i < pending.length; i++) {
    const v = vectors[i];
    if (!(v instanceof Float32Array)) {
      // Non-vector slot from the batch path (e.g. embedder returned null
      // for this row) — count as a failed attempt unless the per-row
      // fallback already counted it.
      if (!alreadyBumped[i]) {
        try { store.bumpEmbedFailure(pending[i].id); } catch { /* */ }
      }
      continue;
    }
    try {
      store.writeEmbedding(pending[i].id, v);
    } catch (err) {
      process.stderr.write(
        `[mindwright/mcp] sweeper writeEmbedding failed for id=${pending[i].id}: ${err && err.message ? err.message : err}\n`
      );
      // writeEmbedding rejects mis-shaped vectors; bump so an embedder bug
      // that produces wrong-length output doesn't trap the row forever.
      try { store.bumpEmbedFailure(pending[i].id); } catch { /* */ }
    }
  }
}
