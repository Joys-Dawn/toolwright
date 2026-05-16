#!/usr/bin/env node
// UserPromptSubmit hook. Two jobs (DESIGN.md "Trigger sources"):
//   1) Sweep new transcript content from the last offset and let the
//      chunker write any chunks it finds (including the cli_prompt row for
//      this prompt if Claude has already landed it in the transcript).
//      The chunker is the single source of truth for cli_prompt writes —
//      whatever UPS doesn't catch here lands via the next PreToolUse/Stop
//      hook, since the prompt is appended to the transcript before the
//      next chunker pass.
//   2) Run turn-start retrieval keyed on the prompt text and inject top-K
//      via `hookSpecificOutput.additionalContext`. If the pipe-client is
//      down (daemon gone), skip retrieval silently — the row will still
//      reach the DB via the chunker.
//
// On any error: emit empty `{}` and exit. Memory features must not block
// prompt submission.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { openStore } from '../lib/store.js';
import { flushTranscript } from '../lib/transcript-flush.js';
import { connectPipe } from '../lib/pipe-client.js';
import {
  TOP_K_DEFAULT,
  NUDGE_STATES,
  RETRIEVAL_OVERALL_TIMEOUT_MS,
} from '../lib/constants.js';
import {
  createTimeoutBudget,
  fetchRecallContext,
  emitDaemonDownWarningIfFirst,
} from '../lib/retrieval-pipeline.js';
import { evaluateNudgeTriggers } from '../lib/nudge.js';
import { logHookError } from '../lib/hook-log.js';

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
  const prompt = typeof input.prompt === 'string' ? input.prompt : '';

  if (!sessionId || !prompt.trim()) {
    process.stdout.write('{}\n');
    return;
  }

  let store;
  try {
    store = openStore();
  } catch (e) {
    logHookError('user-prompt-submit', 'store open failed', e);
    process.stdout.write('{}\n');
    return;
  }

  const pipe = connectPipe(sessionId);
  let additionalContext = '';

  // Overall retrieval budget for this hook. Per-call PIPE_DEFAULT_TIMEOUT_MS
  // caps each individual embed/rerank; this cap protects against the
  // worst-case SUM (slow embed + slow rerank) burning turn-start latency.
  const { timeoutPromise: overallTimeout, isTimedOut } = createTimeoutBudget();

  try {
    // 1) Try to embed the prompt — used as the retrieval query below.
    //    The pipe-client returns null on the expected pipe-down path, so a
    //    thrown error here means something unexpected (malformed JSON-RPC
    //    payload, unhandled IO error). Log it to stderr so silent retrieval
    //    failure doesn't hide a real bug — the user-facing behavior still
    //    degrades to "no recall this turn" either way.
    let promptEmb = null;
    try {
      const out = await Promise.race([pipe.embed([prompt]), overallTimeout]);
      if (isTimedOut()) {
        logHookError('user-prompt-submit', 'retrieval timed out', `embed exceeded ${RETRIEVAL_OVERALL_TIMEOUT_MS}ms`);
      } else {
        promptEmb = Array.isArray(out) && out[0] ? out[0] : null;
      }
    } catch (e) {
      logHookError('user-prompt-submit', 'embed failed', e);
      promptEmb = null;
    }

    // Daemon-down: embed returned null without timing out → MCP daemon is
    // unreachable. Surface a once-per-session warning so the user knows
    // recall is degraded for the rest of this session instead of silently
    // returning [] on every retrieval attempt.
    if (!isTimedOut() && !promptEmb) {
      const warning = emitDaemonDownWarningIfFirst(store, sessionId);
      if (warning) additionalContext = warning;
    }

    // 2) Sweep new transcript content. The chunker emits a cli_prompt
    //    chunk for the user record once it lands in the transcript — UPS
    //    catches it here if Claude wrote it pre-hook, otherwise the next
    //    PreToolUse/Stop chunk pass catches it. No direct insert: keeping
    //    a single writer (the chunker) avoids the duplicate that two
    //    write paths produced (inflated countShortTermFor, dup retrieval
    //    hits, dup exchanges into the consolidator).
    //    Capture insertedIds so retrieval below excludes the just-flushed
    //    cli_prompt — otherwise it scores near-perfect against itself via
    //    bm25/temporal and the user's own prompt echoes back as recall.
    let justFlushedIds = [];
    if (transcriptPath) {
      const flushed = flushTranscript({ store, sessionId, transcriptPath });
      if (flushed.error) {
        logHookError('user-prompt-submit', 'chunk failed', flushed.error);
      } else {
        justFlushedIds = flushed.insertedIds || [];
      }
    }

    // 3) Retrieval (only if we got a query embedding AND the pipe is up for rerank).
    if (promptEmb && !isTimedOut()) {
      const result = await fetchRecallContext({
        store,
        sessionId,
        pipe,
        queryText: prompt,
        queryEmbedding: promptEmb,
        k: TOP_K_DEFAULT,
        justFlushedIds,
        timeoutPromise: overallTimeout,
        isTimedOut,
      });
      if (result.retrieveError) {
        logHookError('user-prompt-submit', 'retrieval failed', result.retrieveError);
      }
      if (result.timedOut) {
        logHookError('user-prompt-submit', 'retrieval timed out', `retrieve exceeded ${RETRIEVAL_OVERALL_TIMEOUT_MS}ms`);
      }
      if (result.appendError) {
        logHookError('user-prompt-submit', 'appendInjectedFactIds failed', result.appendError);
      }
      if (result.additionalContext) additionalContext = result.additionalContext;
    }

    // 4) Drain any pending nudge staged by an earlier Stop-hook firing
    //    (cap-reached or safety-net). Re-check BOTH conditions before
    //    surfacing — if /mindwright:dream ran between the staging Stop and
    //    now the trigger may no longer hold, and surfacing a stale
    //    "run /mindwright:dream" prompt right after the user did exactly
    //    that is hostile. Drop it silently in that case and re-arm so the
    //    next real trigger fires a fresh nudge. Mirror of stop.js's gate so
    //    a nudge staged by EITHER trigger stays valid until BOTH clear.
    try {
      const nudge = store.takePendingNudge(sessionId);
      if (nudge) {
        const triggers = evaluateNudgeTriggers(store);
        if (triggers.capCrossed || triggers.ageCrossed) {
          additionalContext = additionalContext ? `${nudge}\n\n${additionalContext}` : nudge;
        } else {
          // Both triggers cleared (likely by /mindwright:dream) before this
          // nudge surfaced. Reset the edge-trigger so a future trip re-fires.
          try { store.setNudgeState(NUDGE_STATES.ARMED); } catch { /* */ }
        }
      }
    } catch (e) {
      logHookError('user-prompt-submit', 'nudge drain failed', e);
    }
  } finally {
    store.close();
    pipe.close();
  }

  if (additionalContext) {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext,
        },
      }) + '\n'
    );
  } else {
    process.stdout.write('{}\n');
  }
}

// Only run main() when this file is invoked directly by Claude Code (as a
// hook script), not when imported for unit testing — the import path
// would otherwise trigger a stdin read that blocks the test runner.
const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((err) => {
    logHookError('user-prompt-submit', 'crashed', err);
    process.stdout.write('{}\n');
  });
}
