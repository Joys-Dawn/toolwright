#!/usr/bin/env node
// UserPromptSubmit hook. Two jobs: (1) sweep new transcript content and let
// the chunker write any chunks it finds (single source of truth for
// cli_prompt writes); (2) run turn-start retrieval keyed on the prompt text
// and inject top-K via additionalContext, skipping silently if the pipe is
// down. On any error: emit `{}` and exit — memory must not block prompt
// submission.

import { readFileSync } from 'node:fs';
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

  // Overall retrieval budget: per-call timeouts cap each embed/rerank; this
  // caps the worst-case SUM so a slow embed+rerank can't burn turn latency.
  const { timeoutPromise: overallTimeout, isTimedOut } = createTimeoutBudget();

  try {
    // 1) Embed the prompt for the retrieval query. pipe-client returns null
    //    on the expected pipe-down path, so a thrown error here is unexpected
    //    — log it so a real bug isn't hidden behind the degrade-to-no-recall.
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

    // Daemon-down: embed returned null without timing out → model daemon
    // unreachable. Surface a once-per-session warning so degraded recall
    // isn't silent for the rest of the session.
    if (!isTimedOut() && !promptEmb) {
      const warning = emitDaemonDownWarningIfFirst(store, sessionId);
      if (warning) additionalContext = warning;
    }

    // 2) Sweep new transcript content. Single writer (the chunker) avoids
    //    the duplicates two write paths produced. Capture insertedIds so
    //    retrieval below excludes the just-flushed cli_prompt — else it
    //    scores near-perfect against itself and the prompt echoes back.
    let justFlushedIds = [];
    if (transcriptPath) {
      const flushed = flushTranscript({ store, sessionId, transcriptPath });
      if (flushed.error) {
        logHookError('user-prompt-submit', 'chunk failed', flushed.error);
      } else {
        justFlushedIds = flushed.insertedIds || [];
      }
    }

    // 3) Retrieval (only with a query embedding AND pipe up for rerank).
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

    // 4) Drain any pending nudge staged by an earlier Stop firing. Re-check
    //    BOTH triggers before surfacing — if dream ran since staging, the
    //    trigger may no longer hold and re-nudging right after the user ran
    //    dream is hostile; drop it silently and re-arm. Mirrors stop.js's
    //    gate so a nudge stays valid until BOTH triggers clear.
    try {
      const nudge = store.takePendingNudge(sessionId);
      if (nudge) {
        const triggers = evaluateNudgeTriggers(store);
        if (triggers.capCrossed || triggers.ageCrossed) {
          additionalContext = additionalContext ? `${nudge}\n\n${additionalContext}` : nudge;
        } else {
          // Both triggers cleared before this nudge surfaced. Reset the
          // edge-trigger so a future trip re-fires.
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
