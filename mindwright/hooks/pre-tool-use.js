#!/usr/bin/env node
// PreToolUse hook. Most complex of the five.
//
//   1) Read transcript [stored offset, EOF], chunk it, write all rows in a
//      single transaction, advance the offset. Writes are unconditional.
//   2) Identify the most-recent thinking block in the new chunks. Apply the
//      novelty gate (DESIGN.md "Locked design decisions" #4):
//         cosine(thinking_emb, meta:last_retrieval_query_emb:<sessionId>) < NOVELTY_THRESHOLD
//      First firing of a session always passes (no prior embedding).
//      When the gate passes, run retrieval with length-bucketed K and
//      emit hookSpecificOutput.additionalContext. Otherwise return {}.
//   3) Per-session dedup: every retrieval path reads
//      meta:injected_fact_ids:<sessionId>, passes its contents as
//      excludeIds, and appends the just-emitted ids after the response.
//      The set is FIFO-trimmed at INJECTED_FACT_IDS_CAP. SessionStart
//      clears it so a fresh boot starts cold.
//
// On any error this hook emits {} so the tool call is never blocked.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { openStore } from '../lib/store.js';
import { flushTranscript } from '../lib/transcript-flush.js';
import { connectPipe } from '../lib/pipe-client.js';
import {
  NOVELTY_THRESHOLD,
  TOP_K_BY_LENGTH,
  LENGTH_BUCKET_SMALL,
  LENGTH_BUCKET_MID,
  RETRIEVAL_OVERALL_TIMEOUT_MS,
} from '../lib/constants.js';
import {
  createTimeoutBudget,
  fetchRecallContext,
  emitDaemonDownWarningIfFirst,
} from '../lib/retrieval-pipeline.js';
import { cosineSimilarity } from '../lib/vec.js';
import { logHookError } from '../lib/hook-log.js';

function lastThinkingChunk(chunks) {
  for (let i = chunks.length - 1; i >= 0; i--) {
    if (chunks[i].kind === 'thinking') return chunks[i];
  }
  return null;
}

// Pick top-K based on thinking-block length. Short blocks get fewer hits to
// keep injected context tight; long blocks get more hits to cover more of
// the agent's mental surface.
export function topKForLength(len) {
  if (len <= LENGTH_BUCKET_SMALL) return TOP_K_BY_LENGTH.small;
  if (len <= LENGTH_BUCKET_MID) return TOP_K_BY_LENGTH.mid;
  return TOP_K_BY_LENGTH.large;
}

// Novelty gate. Returns true when retrieval should fire. No prior embedding
// (first PreToolUse of a session, or DB-cleared on resume) → fire. Cosine
// strictly less than threshold → fire. Length mismatch on the stored row
// → fire (defensive: a malformed meta row shouldn't wedge retrieval silent).
export function noveltyPasses(prev, curr) {
  if (!prev) return true;
  try {
    const cos = cosineSimilarity(prev, curr);
    return cos < NOVELTY_THRESHOLD;
  } catch {
    return true;
  }
}

async function main() {
  let input;
  try {
    input = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    process.stdout.write('{}\n');
    return;
  }

  const sessionId = input.session_id;
  const transcriptPath = input.transcript_path;
  if (!sessionId || !transcriptPath) {
    process.stdout.write('{}\n');
    return;
  }

  let store;
  try {
    store = openStore();
  } catch (e) {
    logHookError('pre-tool-use', 'store open failed', e);
    process.stdout.write('{}\n');
    return;
  }

  const pipe = connectPipe(sessionId);
  let additionalContext = '';

  try {
    // Step 1 — read + chunk + write under one transaction.
    const flushed = flushTranscript({ store, sessionId, transcriptPath });
    if (flushed.error) {
      logHookError('pre-tool-use', 'flush failed', flushed.error);
      return;
    }
    const chunks = flushed.chunks;
    // Stash the row ids the chunker just wrote so retrieval can exclude
    // them — the just-flushed thinking block IS the query; without this
    // filter it scores ~1.0 against itself via bm25/temporal and dominates
    // its own recall context.
    const justFlushedIds = flushed.insertedIds || [];

    // Step 2 — identify the latest thinking block.
    const thinking = lastThinkingChunk(chunks);
    if (!thinking) return;

    // Step 3 — embed the thinking block. Pipe down → no embed → skip
    // retrieval. (The chunk row is still in entries; the sweeper will
    // backfill the embedding next time the daemon is live.)
    const { timeoutPromise: overallTimeout, isTimedOut } = createTimeoutBudget();
    let promptEmb = null;
    try {
      const out = await Promise.race([pipe.embed([thinking.content]), overallTimeout]);
      if (isTimedOut()) {
        logHookError('pre-tool-use', 'retrieval timed out', `embed exceeded ${RETRIEVAL_OVERALL_TIMEOUT_MS}ms`);
      } else {
        promptEmb = Array.isArray(out) && out[0] ? out[0] : null;
      }
    } catch (e) {
      logHookError('pre-tool-use', 'embed failed', e);
      promptEmb = null;
    }
    if (!promptEmb) {
      // Daemon-down: embed returned null without timing out → MCP daemon is
      // unreachable. Surface a once-per-session warning so the user knows
      // recall is degraded for the rest of this session. Fall through to the
      // finally so additionalContext is emitted to Claude.
      if (!isTimedOut()) {
        const warning = emitDaemonDownWarningIfFirst(store, sessionId);
        if (warning) additionalContext = warning;
      }
      return;
    }

    // Step 4 — novelty gate.
    let prevEmb = null;
    try { prevEmb = store.getLastQueryEmb(sessionId); } catch { prevEmb = null; }
    if (!noveltyPasses(prevEmb, promptEmb)) {
      return;
    }
    // Persist the new embedding BEFORE retrieval so a retrieval failure
    // still updates the gate state (otherwise a slow rerank could leave
    // last_query_emb stale and re-trigger on the same thinking block).
    try { store.setLastQueryEmb(sessionId, promptEmb); } catch (e) {
      logHookError('pre-tool-use', 'setLastQueryEmb failed', e);
    }

    // Step 5 — retrieval. Length-bucket K. Dedup via injected_fact_ids.
    const result = await fetchRecallContext({
      store,
      sessionId,
      pipe,
      queryText: thinking.content,
      queryEmbedding: promptEmb,
      k: topKForLength(thinking.content.length),
      justFlushedIds,
      timeoutPromise: overallTimeout,
      isTimedOut,
    });
    if (result.retrieveError) {
      logHookError('pre-tool-use', 'retrieval failed', result.retrieveError);
    }
    if (result.timedOut) {
      logHookError('pre-tool-use', 'retrieval timed out', `retrieve exceeded ${RETRIEVAL_OVERALL_TIMEOUT_MS}ms`);
    }
    if (result.appendError) {
      logHookError('pre-tool-use', 'appendInjectedFactIds failed', result.appendError);
    }
    if (result.additionalContext) additionalContext = result.additionalContext;
  } finally {
    store.close();
    pipe.close();
    if (additionalContext) {
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            additionalContext,
          },
        }) + '\n'
      );
    } else {
      process.stdout.write('{}\n');
    }
  }
}

// Only run main() when this file is invoked directly by Claude Code (as a
// hook script), not when imported for unit testing — the import path
// would otherwise trigger a stdin read that blocks the test runner.
const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((err) => {
    logHookError('pre-tool-use', 'crashed', err);
    process.stdout.write('{}\n');
  });
}
