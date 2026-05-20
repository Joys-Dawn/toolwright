// The four candidate retrievers over the store. Each returns ids only;
// fusion + rerank live in lib/retriever.js. graphSearch is a stub until
// consolidation populates entities — RRF tolerates a zero-result list.

import { tierScopeClause } from './scope-filter.js';

const DEFAULT_PER_RETRIEVER_N = 50;

export async function semanticSearch(store, queryEmbedding, n = DEFAULT_PER_RETRIEVER_N, tier = null, roles = null) {
  if (!queryEmbedding) return [];
  const rows = store.semanticSearch(queryEmbedding, n, tier, roles);
  return rows.map((r) => ({ id: r.id, distance: r.distance }));
}

export function bm25Search(store, queryText, n = DEFAULT_PER_RETRIEVER_N, tier = null, roles = null) {
  if (!queryText || !queryText.trim()) return [];
  const sanitized = sanitizeFtsQuery(queryText);
  if (!sanitized) return [];
  try {
    const rows = store.bm25Search(sanitized, n, tier, roles);
    return rows.map((r) => ({ id: r.id, rank: r.rank }));
  } catch (e) {
    // Any SQLite SQL error (including FTS5 syntax surprises) degrades to
    // no-results so the rest of the retrieval pipeline keeps working.
    // Programming bugs (TypeError, etc.) still propagate.
    if (e && e.code === 'SQLITE_ERROR') return [];
    throw e;
  }
}

// Rows whose entities overlap the query entities. Recency tiebreak is
// COALESCE(event_ts, created_at) — rank by when it actually happened;
// recency/relevance only, never lifecycle SQL.
//
// `e.pending_session_id IS NULL` keeps the live-staged short-tier rows out of
// every retriever path, matching the same filter in store.semanticSearch /
// bm25Search / temporalSearch.
export function graphSearch(store, queryEntities, n = DEFAULT_PER_RETRIEVER_N, tier = null, roles = null) {
  if (!queryEntities || queryEntities.length === 0) return [];
  const placeholders = queryEntities.map(() => '?').join(',');
  const ts = tierScopeClause(tier, roles);
  const rows = store.db.prepare(`
    SELECT DISTINCT e.id
      FROM entries e
      JOIN entry_entities ee ON ee.entry_id = e.id
      JOIN entities ent ON ent.id = ee.entity_id
     WHERE e.active = 1 AND e.pending_session_id IS NULL${ts.clause}
       AND ent.name IN (${placeholders})
     ORDER BY COALESCE(e.event_ts, e.created_at) DESC
     LIMIT ?
  `).all(...ts.params, ...queryEntities, n);
  return rows.map((r) => ({ id: r.id }));
}

export function temporalSearch(store, n = DEFAULT_PER_RETRIEVER_N, tier = null, roles = null) {
  return store.temporalSearch(n, tier, roles).map((r) => ({ id: r.id }));
}

// FTS5 has a strict query mini-grammar that free-text punctuation/hyphens can
// blow up. Extract Unicode letter/digit/underscore runs and OR them; `\p{L}
// \p{N}` match ANY script, preserving bge-m3's multilingual recall. Length
// floor is script-sensitive: ASCII tokens need 2+ chars (drops 'a'/'I'
// noise), but non-ASCII single chars are kept because a single CJK char is a
// complete word.
function sanitizeFtsQuery(text) {
  const matches = String(text).toLocaleLowerCase().match(/[\p{L}\p{N}_]+/gu);
  if (!matches || !matches.length) return null;
  const filtered = matches.filter(
    (t) => t.length >= 2 || /[^\x00-\x7f]/.test(t),
  );
  if (!filtered.length) return null;
  // Quote each token to dodge reserved FTS5 syntax (AND/OR/NOT/NEAR).
  return filtered.map((t) => `"${t}"`).join(' OR ');
}
