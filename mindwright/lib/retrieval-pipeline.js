// Shared retrieve → post-filter → format → dedup-append leg for the two
// recall surfaces (UserPromptSubmit and PreToolUse), so the dedup contract,
// timeout budget, and formatRecall + "Current time:" prefix can't diverge.
// The hooks still own their outer flow (flush, source-specific embed, the
// PreToolUse novelty gate).
//
// The historical self-echo workaround (`justFlushedIds → excludeIds`) is
// retired: chunker writes land in `entries` with `pending_session_id` set,
// and every retriever's SQL filters those rows out structurally. The
// `excludeIds` channel into retrieve() is preserved for its remaining uses
// (the injected-fact-ids per-session dedup, and the mindwright_recall MCP
// tool's `exclude_ids` argument).

import { retrieve } from './retriever.js';
import { formatRecall } from './recall-format.js';
import {
  INJECTED_FACT_IDS_CAP,
  RETRIEVAL_OVERALL_TIMEOUT_MS,
  DAEMON_DOWN_WARNING,
} from './constants.js';

// Shared overall-timeout budget: { timeoutPromise (resolves a sentinel after
// the cap, race it against embed/retrieve), isTimedOut() }. setTimeout is
// .unref()'d so it never holds the process past the hook's exit.
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

// Daemon-down warning, once per session (idempotent latch, cleared by
// SessionStart so a fresh boot can warn again). Best-effort: meta read/write
// failure swallows the warning rather than crashing the hook.
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
// @param {Promise} args.timeoutPromise - from createTimeoutBudget().
// @param {() => boolean} args.isTimedOut - from createTimeoutBudget().
// @returns {Promise<{additionalContext: string|null, timedOut: boolean, retrieveError: Error|null, appendError: Error|null}>}
export async function fetchRecallContext({
  store, sessionId, pipe, queryText, queryEmbedding, k,
  timeoutPromise, isTimedOut,
}) {
  let roles = [];
  try { roles = store.getRoles(sessionId); } catch { /* default [] */ }
  let injectedIds = [];
  try { injectedIds = store.getInjectedFactIds(sessionId); } catch { /* default [] */ }
  // excludeIds now carries only the per-session injected-ids dedup set
  // (the self-echo problem is gone — pending rows are SQL-filtered out).
  const excludeIds = injectedIds;

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
