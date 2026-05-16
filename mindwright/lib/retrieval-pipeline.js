// Shared retrieval pipeline for the two recall surfaces (UserPromptSubmit
// and PreToolUse). Both hooks call retrieve() with the same dedup contract
// (read injected_fact_ids, exclude them + the just-flushed ids, append
// emitted ids back), the same overall-timeout budget, and the same
// formatRecall + "Current time:" prefix. The duplication used to live in
// both hooks; future changes to dedup, formatting, or timeout would need to
// land in both places or the surfaces would silently diverge.
//
// The hooks still own their own outer flow — transcript flush, embedding
// the source-specific input (prompt vs thinking block), and the novelty
// gate (PreToolUse only). This helper covers only the retrieve →
// post-filter → format → dedup-append leg.

import { retrieve } from './retriever.js';
import { formatRecall } from './recall-format.js';
import {
  INJECTED_FACT_IDS_CAP,
  RETRIEVAL_OVERALL_TIMEOUT_MS,
  DAEMON_DOWN_WARNING,
} from './constants.js';

// Build the shared overall-timeout budget used by both hooks. Returned shape:
//   {
//     timeoutPromise:   Promise that resolves with a sentinel after the cap
//                       — pass into Promise.race with an embed/retrieve call,
//     isTimedOut:       () => boolean — true once the cap fired.
//   }
// Caller owns the lifetime; setTimeout uses .unref() so it never holds the
// process alive past the hook's natural exit.
export function createTimeoutBudget(ms = RETRIEVAL_OVERALL_TIMEOUT_MS) {
  let timedOut = false;
  const timeoutPromise = new Promise((resolve) => {
    const t = setTimeout(() => {
      timedOut = true;
      resolve('__mindwright_retrieval_timeout__');
    }, ms);
    if (t.unref) t.unref();
  });
  return { timeoutPromise, isTimedOut: () => timedOut };
}

// Returns the daemon-down warning the first time this session observes the
// MCP daemon as unreachable; null on subsequent calls (idempotent latch). The
// latch is per-session and cleared by SessionStart, so a fresh boot is
// allowed to warn again. Best-effort: meta read/write failures swallow the
// warning rather than crashing the calling hook — the worst outcome is the
// user doesn't see the warning, which is strictly no worse than today.
export function emitDaemonDownWarningIfFirst(store, sessionId) {
  if (!sessionId) return null;
  try {
    if (store.wasDaemonDownWarned(sessionId)) return null;
    store.markDaemonDownWarned(sessionId);
    return DAEMON_DOWN_WARNING;
  } catch {
    return null;
  }
}

// Execute the retrieve → format → dedup-append leg with the shared dedup
// contract.
//
// @param {object} args
// @param {object} args.store - openStore() handle.
// @param {string} args.sessionId - calling session id.
// @param {object} args.pipe - connectPipe(sessionId) handle.
// @param {string} args.queryText - the text to query against (prompt or thinking).
// @param {Array|Float32Array} args.queryEmbedding - precomputed embedding for queryText.
// @param {number} args.k - top-K for retrieval.
// @param {number[]} [args.justFlushedIds] - row ids just written by the chunker; excluded.
// @param {Promise} args.timeoutPromise - from createTimeoutBudget().
// @param {() => boolean} args.isTimedOut - from createTimeoutBudget().
// @returns {Promise<{additionalContext: string|null, timedOut: boolean, retrieveError: Error|null, appendError: Error|null}>}
export async function fetchRecallContext({
  store, sessionId, pipe, queryText, queryEmbedding, k,
  justFlushedIds = [], timeoutPromise, isTimedOut,
}) {
  let roles = [];
  try { roles = store.getRoles(sessionId); } catch { /* default [] */ }
  let injectedIds = [];
  try { injectedIds = store.getInjectedFactIds(sessionId); } catch { /* default [] */ }
  const excludeIds = [...justFlushedIds, ...injectedIds];

  let hits;
  try {
    hits = await Promise.race([
      retrieve({
        store,
        queryText,
        queryEmbedding,
        embed: pipe.embed.bind(pipe),
        rerank: pipe.rerank.bind(pipe),
        roles,
        excludeIds,
        options: { k },
      }),
      timeoutPromise,
    ]);
  } catch (e) {
    return { additionalContext: null, timedOut: false, retrieveError: e, appendError: null };
  }

  if (isTimedOut()) {
    return { additionalContext: null, timedOut: true, retrieveError: null, appendError: null };
  }
  if (!Array.isArray(hits) || hits.length === 0) {
    return { additionalContext: null, timedOut: false, retrieveError: null, appendError: null };
  }

  const additionalContext = `Current time: ${new Date().toISOString()}\n\n${formatRecall(hits)}`;
  const emittedIds = hits.map((h) => Number(h.id)).filter((n) => Number.isFinite(n));
  let appendError = null;
  if (emittedIds.length > 0) {
    try { store.appendInjectedFactIds(sessionId, emittedIds, INJECTED_FACT_IDS_CAP); }
    catch (e) { appendError = e; }
  }
  return { additionalContext, timedOut: false, retrieveError: null, appendError };
}
