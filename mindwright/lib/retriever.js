// TEMPR retrieval pipeline:
//   four retrievers (semantic, bm25, graph, temporal) → top-N each
//   → RRF (k=60) → top-20 fused → cross-encoder rerank → sigmoid scores
//   → recency boost on semantic-only path
//   → drop below rerank_floor (0.10) → top-K

import { rrfFuse } from './rrf.js';
import { semanticSearch, bm25Search, graphSearch, temporalSearch } from './retrievers.js';
import {
  RRF_K,
  PER_RETRIEVER_N,
  RERANK_FLOOR,
  RECENCY_BOOST_DAYS,
  RECENCY_BOOST_MAX,
  RRF_TOP_FOR_RERANK,
  TOP_K_DEFAULT,
  MS_PER_DAY,
} from './constants.js';

// Numeric defaults sourced from lib/constants.js so a retune lands in one place.
const DEFAULTS = {
  perRetrieverN: PER_RETRIEVER_N,
  rrfTopForRerank: RRF_TOP_FOR_RERANK,
  rerankFloor: RERANK_FLOOR,
  recencyBoostDays: RECENCY_BOOST_DAYS,
  recencyBoostMax: RECENCY_BOOST_MAX,
  rrfK: RRF_K,
  k: TOP_K_DEFAULT,
};

export async function retrieve({
  store,
  queryText,
  queryEmbedding = null,
  queryEntities = [],
  embed,   // fn(string[]) -> Float32Array[]
  rerank,  // fn(string, string[]) -> number[]   sigmoid-applied
  now = Date.now(),
  tier = null, // optional 'short' | 'long' filter pushed into each retriever's SQL
  // Role scoping for role-scoped long-tier rows. See lib/scope-filter.js for
  // exact semantics; null/undefined → no filter.
  roles = null,
  // Entry ids dropped from the candidate pool BEFORE rerank. Hooks pass the
  // ids they just flushed — otherwise the just-typed prompt/thinking surfaces
  // via bm25/temporal (semantic misses it: NULL embedding) and the
  // cross-encoder scores it ~1.0 against itself, echoing the prompt back as
  // additionalContext. Post-RRF so it runs once on the de-duped fused list.
  excludeIds = null,
  options = {},
}) {
  const opts = { ...DEFAULTS, ...options };
  const excludeSet =
    excludeIds && excludeIds.length
      ? new Set(excludeIds.map((id) => Number(id)))
      : null;

  let qEmb = queryEmbedding;
  if (!qEmb && embed && queryText) {
    const out = await embed([queryText]);
    qEmb = out[0];
  }

  // tier + roles flow into each retriever's SQL so the caller gets exactly k
  // tier/role-matching candidates per retriever. Sequential, not Promise.all:
  // better-sqlite3 is synchronous on a shared connection, so parallelism is
  // illusory; the async shape only keeps the door open for a future remote
  // vector store.
  const semRaw = await semanticSearch(store, qEmb, opts.perRetrieverN, tier, roles);
  const bmRaw = bm25Search(store, queryText, opts.perRetrieverN, tier, roles);
  const grRaw = graphSearch(store, queryEntities, opts.perRetrieverN, tier, roles);
  const tmRaw = temporalSearch(store, opts.perRetrieverN, tier, roles);

  const semIds = semRaw.map((r) => Number(r.id));
  const bmIds = bmRaw.map((r) => Number(r.id));
  const grIds = grRaw.map((r) => Number(r.id));
  const tmIds = tmRaw.map((r) => Number(r.id));

  const fusedAll = rrfFuse([semIds, bmIds, grIds, tmIds], { k: opts.rrfK });
  const fused = excludeSet
    ? fusedAll.filter((entry) => !excludeSet.has(Number(entry.id)))
    : fusedAll;
  if (!fused.length) return [];

  // Pair each RRF entry with its row BEFORE filtering — a missing row would
  // otherwise shift indices and draw `rrf_score` from the wrong RRF entry.
  const topForRerank = fused.slice(0, opts.rrfTopForRerank);
  const paired = topForRerank
    .map((entry) => ({ entry, row: store.fetch(entry.id) }))
    .filter((p) => p.row);
  const rows = paired.map((p) => p.row);

  let rerankScores;
  if (rerank && rows.length) {
    rerankScores = await rerank(queryText, rows.map((r) => r.content));
    // rerank returns null on connect-fail/timeout/malformed. Falling back to
    // 1.0-per-row keeps the result set alive (RRF-ordered for this turn)
    // instead of looking like rerank-floor abstention. A length mismatch is
    // treated like null — `undefined >= 0.10` would silently drop the tail.
    if (!Array.isArray(rerankScores) || rerankScores.length !== rows.length) {
      rerankScores = rows.map(() => 1.0);
    }
  } else {
    // No reranker — 1.0 everything so the floor doesn't kill the list.
    rerankScores = rows.map(() => 1.0);
  }

  // Recency boost is ORDERING only; the abstention floor below still gates on
  // raw rerank, so a recency-fresh-but-irrelevant row can't pass the floor.
  const semSet = new Set(semIds.slice(0, opts.rrfTopForRerank));
  const scored = paired.map(({ entry, row }, idx) => {
    const rerankScore = rerankScores[idx];
    let orderingScore = rerankScore;
    if (semSet.has(Number(row.id))) {
      // Recency = event_ts (when it ACTUALLY happened) when present, else
      // created_at; NULL for live rows. Recency/relevance only — never
      // lifecycle.
      orderingScore += recencyBoost(row.event_ts ?? row.created_at, now, opts.recencyBoostDays, opts.recencyBoostMax);
    }
    return { row, rerankScore, orderingScore, rrfScore: entry.score };
  });

  // Floor gates on raw rerank, not the boosted ordering score.
  const passing = scored.filter((s) => s.rerankScore >= opts.rerankFloor);
  if (!passing.length) return [];

  passing.sort((a, b) => b.orderingScore - a.orderingScore);
  return passing.slice(0, opts.k).map((s) => ({
    id: s.row.id,
    content: s.row.content,
    kind: s.row.kind,
    tier: s.row.tier,
    category: s.row.category,
    scope: s.row.scope,
    created_at: s.row.created_at,
    // This explicit literal (not store.fetch's SELECT *) is what feeds
    // recall-format's ts= token; omitting it would surface seed-run
    // created_at as "when it happened". null for live rows.
    event_ts: s.row.event_ts ?? null,
    rerank_score: s.rerankScore,
    rrf_score: s.rrfScore,
  }));
}

function recencyBoost(createdAtIso, nowMs, decayDays, maxBoost) {
  const created = Date.parse(createdAtIso);
  if (Number.isNaN(created)) return 0;
  const ageDays = (nowMs - created) / MS_PER_DAY;
  // A future timestamp means clock skew / corrupted record / seeded event_ts
  // from a faster machine — not a credible "fresh" signal. Contribute NO
  // boost (not the MAX the `ageDays <= 0` branch would give), else one skewed
  // stale row outranks every fresh fact. Only the event_ts path can reach
  // this; created_at is monotonic.
  if (ageDays < 0) return 0;
  if (ageDays <= 0) return maxBoost;
  if (ageDays >= decayDays) return 0;
  return maxBoost * (1 - ageDays / decayDays);
}
