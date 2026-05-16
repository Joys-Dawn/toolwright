// The four candidate retrievers wrapped over the store.
// Each returns ids only — fusion + rerank live in lib/retriever.js.
//
// Graph retriever is a v1 stub (the entities table starts empty until consolidation
// runs); RRF gracefully tolerates a zero-result list.

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

// v1 stub. Returns the rows whose entities overlap with the query entities.
// Recency tiebreak is COALESCE(event_ts, created_at) so a seeded/distilled
// row ranks by when its underlying exchange actually happened; NULL event_ts
// (every live row) falls back to created_at — pre-change behavior preserved.
// Relevance-ranking read only (governing invariant: never lifecycle SQL).
export function graphSearch(store, queryEntities, n = DEFAULT_PER_RETRIEVER_N, tier = null, roles = null) {
  if (!queryEntities || queryEntities.length === 0) return [];
  const placeholders = queryEntities.map(() => '?').join(',');
  const ts = tierScopeClause(tier, roles);
  const rows = store.db.prepare(`
    SELECT DISTINCT e.id
      FROM entries e
      JOIN entry_entities ee ON ee.entry_id = e.id
      JOIN entities ent ON ent.id = ee.entity_id
     WHERE e.active = 1${ts.clause}
       AND ent.name IN (${placeholders})
     ORDER BY COALESCE(e.event_ts, e.created_at) DESC
     LIMIT ?
  `).all(...ts.params, ...queryEntities, n);
  return rows.map((r) => ({ id: r.id }));
}

export function temporalSearch(store, n = DEFAULT_PER_RETRIEVER_N, tier = null, roles = null) {
  return store.temporalSearch(n, tier, roles).map((r) => ({ id: r.id }));
}

// FTS5 has a strict query mini-grammar. Free-text user queries containing
// punctuation, hyphens, or short tokens can blow it up. The safest path is to
// extract token-like runs of Unicode letters/digits/underscore and OR them —
// that's how we use BM25 here anyway. The `\p{L}\p{N}` classes match letters
// and numbers in ANY script, which preserves bge-m3's multilingual recall
// (DESIGN.md line 29 — multilingual support was a load-bearing model choice).
//
// Length floor is script-sensitive: ASCII tokens need 2+ chars (drops the
// 'a'/'I' English noise that would flood BM25), but non-ASCII single chars
// are kept because in CJK and similar scripts a single character (日 sun,
// 水 water, 我 I) is a complete word — a flat {2,} floor silently degraded
// multilingual recall.
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
