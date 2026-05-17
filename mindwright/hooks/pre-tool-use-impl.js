#!/usr/bin/env node
// PreToolUse hook. (1) Read transcript [offset, EOF], chunk, write all rows
// in one transaction, advance offset (unconditional). (2) Find the latest
// thinking block, apply the novelty gate, and on pass run retrieval with
// length-bucketed K. (3) Per-session dedup via injected_fact_ids, FIFO-
// trimmed at INJECTED_FACT_IDS_CAP, cleared by SessionStart. On any error
// emit {} so the tool call is never blocked.

import { readFileSync } from 'node:fs';
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

// Top-K by thinking-block length: short blocks get fewer hits to keep
// injected context tight; long blocks get more to cover more surface.
export function topKForLength(len) {
  if (len <= LENGTH_BUCKET_SMALL) return TOP_K_BY_LENGTH.small;
  if (len <= LENGTH_BUCKET_MID) return TOP_K_BY_LENGTH.mid;
  return TOP_K_BY_LENGTH.large;
}

// Novelty gate. Fire when there's no prior embedding (first PreToolUse, or
// cleared on resume), or cosine strictly below threshold. On any error fire
// (a malformed meta row must not wedge retrieval permanently silent).
export function noveltyPasses(prev, curr) {
  if (!prev) return true;
  try {
    const cos = cosineSimilarity(prev, curr);
    return cos < NOVELTY_THRESHOLD;
  } catch {
    return true;
  }
}

export async function main() {
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
    // Exclude the rows just written: the just-flushed thinking block IS the
    // query, so without this it scores ~1.0 against itself and dominates its
    // own recall context.
    const justFlushedIds = flushed.insertedIds || [];

    // Step 2 — identify the latest thinking block.
    const thinking = lastThinkingChunk(chunks);
    if (!thinking) return;

    // Step 3 — embed the thinking block. Pipe down → skip retrieval (the row
    // is still in entries; the sweeper backfills the embedding later).
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
      // Daemon-down: embed returned null without timing out → model daemon
      // unreachable. Surface a once-per-session degraded-recall warning;
      // fall through to the finally so it's emitted to Claude.
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
    // Persist the new embedding BEFORE retrieval so a retrieval failure still
    // advances the gate (else a slow rerank leaves last_query_emb stale and
    // re-triggers on the same thinking block).
    try { store.setLastQueryEmb(sessionId, promptEmb); } catch (e) {
      logHookError('pre-tool-use', 'setLastQueryEmb failed', e);
    }

    // Step 5 — retrieval.
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
