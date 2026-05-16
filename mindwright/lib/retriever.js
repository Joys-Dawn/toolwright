// TEMPR retrieval pipeline. See DESIGN.md "Retrieval pipeline" + plan Phase 4.
//
//   queryEmbedding + queryText + queryEntities
//        ↓
//   four parallel retrievers (semantic, bm25, graph, temporal) → top-N each
//        ↓
//   RRF (k=60) → fused ranking
//        ↓
//   top-20 fused → cross-encoder rerank → sigmoid scores
//        ↓
//   apply recency boost on semantic-only path
//        ↓
//   drop items below rerank_floor (0.10) → empty array if all fail
//        ↓
//   return top-K

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

// Numeric defaults sourced from lib/constants.js so a future retune (DESIGN.md
// "Open Questions" anticipates tier-specific rerank_floor calibration) only
// has to land in one place.
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
  // Optional role scoping for role-scoped long-tier rows (scope LIKE
  // 'role:%'). When provided, only such rows whose `scope IN ('role:<r>')`
  // matches one of the active roles are included; user-/project-scoped and
  // short-tier rows pass through untouched. See lib/scope-filter.js for the
  // exact semantics — null/undefined leaves legacy behavior (no filter).
  roles = null,
  // Optional list of entry ids to drop from the candidate pool BEFORE
  // rerank. The UPS / PreToolUse hooks pass the ids they just inserted via
  // flushTranscript — without this, the just-typed prompt or thinking block
  // is its own near-perfect rerank candidate (NULL embedding makes
  // semantic-search miss it, but bm25 via FTS5 trigger and temporal
  // ORDER-BY-created_at DESC both surface it), and the cross-encoder
  // scoring (query, identical-candidate) near 1.0 sails past the 0.10 floor.
  // End result before this filter: the user's prompt echoes back as
  // additionalContext. Filtering is post-RRF so it runs once on the
  // de-duped fused list, not four times in the per-retriever SQL.
  excludeIds = null,
  options = {},
}) {
  const opts = { ...DEFAULTS, ...options };
  const excludeSet =
    excludeIds && excludeIds.length
      ? new Set(excludeIds.map((id) => Number(id)))
      : null;

  // 1. Get an embedding for the query if one wasn't supplied.
  let qEmb = queryEmbedding;
  if (!qEmb && embed && queryText) {
    const out = await embed([queryText]);
    qEmb = out[0];
  }

  // 2. Run all four retrievers. tier flows into each retriever's SQL so the
  //    caller gets exactly k tier-matching candidates per retriever, rather
  //    than k pre-filter candidates that may happen to be all wrong-tier.
  //    roles is similarly pushed into each retriever's SQL so candidate
  //    surfaces never include procedural rows scoped to a different role.
  //
  //    Called sequentially, not Promise.all'd, because better-sqlite3 is
  //    fully synchronous and all four queries share the same connection — a
  //    Promise.all would only add microtask scheduling overhead and mislead
  //    readers into reasoning about parallelism that doesn't exist. The
  //    semanticSearch wrapper is async-shaped to keep the door open for a
  //    future remote vector store; when that lands, re-introduce parallelism
  //    here at the call site.
  const semRaw = await semanticSearch(store, qEmb, opts.perRetrieverN, tier, roles);
  const bmRaw = bm25Search(store, queryText, opts.perRetrieverN, tier, roles);
  const grRaw = graphSearch(store, queryEntities, opts.perRetrieverN, tier, roles);
  const tmRaw = temporalSearch(store, opts.perRetrieverN, tier, roles);

  const semIds = semRaw.map((r) => Number(r.id));
  const bmIds = bmRaw.map((r) => Number(r.id));
  const grIds = grRaw.map((r) => Number(r.id));
  const tmIds = tmRaw.map((r) => Number(r.id));

  // 3. RRF fusion.
  const fusedAll = rrfFuse([semIds, bmIds, grIds, tmIds], { k: opts.rrfK });
  const fused = excludeSet
    ? fusedAll.filter((entry) => !excludeSet.has(Number(entry.id)))
    : fusedAll;
  if (!fused.length) return [];

  // 4. Take top-N for rerank. Pair each RRF entry with its fetched row BEFORE
  //    filtering — otherwise a missing row would shift later indices and
  //    `rrf_score` on the response would be drawn from the wrong RRF entry.
  const topForRerank = fused.slice(0, opts.rrfTopForRerank);
  const paired = topForRerank
    .map((entry) => ({ entry, row: store.fetch(entry.id) }))
    .filter((p) => p.row);
  const rows = paired.map((p) => p.row);

  // 5. Cross-encoder rerank if we have one.
  let rerankScores;
  if (rerank && rows.length) {
    rerankScores = await rerank(queryText, rows.map((r) => r.content));
    // pipe-client.rerank documented to return null on connect-fail / timeout
    // / malformed response. Without this guard the indexing at step 6 would
    // throw and the caller's try/catch would silently emit empty results,
    // looking like rerank-floor abstention rather than infrastructure
    // failure. Falling back to 1.0-per-row keeps the result set alive and
    // the floor lets ordering be RRF-driven for this one turn. Length
    // mismatch is treated the same as null — a short response would
    // otherwise leave rerankScores[idx] === undefined, and
    // `undefined >= 0.10` silently drops the tail of `paired` instead of
    // surfacing as infrastructure failure.
    if (!Array.isArray(rerankScores) || rerankScores.length !== rows.length) {
      rerankScores = rows.map(() => 1.0);
    }
  } else {
    // No reranker — assign 1.0 to everything so the floor doesn't immediately kill the list.
    rerankScores = rows.map(() => 1.0);
  }

  // 6. Apply recency boost on the semantic-path rows for ORDERING only — the
  //    abstention floor still gates on raw rerank, so a recency-fresh-but-irrelevant
  //    row can't sneak back over the floor.
  const semSet = new Set(semIds.slice(0, opts.rrfTopForRerank));
  const scored = paired.map(({ entry, row }, idx) => {
    const rerankScore = rerankScores[idx];
    let orderingScore = rerankScore;
    if (semSet.has(Number(row.id))) {
      // Recency = event_ts when the row carries one (distilled/seeded from a
      // historical exchange — rank by when it ACTUALLY happened, not the
      // seed-run write time), else created_at. NULL for every live row, so
      // `?? row.created_at` is byte-identical to pre-change there. Ordering
      // ONLY — the abstention floor below still gates on raw rerank, so a
      // recency-fresh-but-irrelevant row can't sneak back over the floor.
      orderingScore += recencyBoost(row.event_ts ?? row.created_at, now, opts.recencyBoostDays, opts.recencyBoostMax);
    }
    return { row, rerankScore, orderingScore, rrfScore: entry.score };
  });

  // 7. Drop below floor (on raw rerank, not the boosted ordering score).
  const passing = scored.filter((s) => s.rerankScore >= opts.rerankFloor);
  if (!passing.length) return [];

  // 8. Sort by ordering score desc, take top-K.
  passing.sort((a, b) => b.orderingScore - a.orderingScore);
  return passing.slice(0, opts.k).map((s) => ({
    id: s.row.id,
    content: s.row.content,
    kind: s.row.kind,
    tier: s.row.tier,
    category: s.row.category,
    scope: s.row.scope,
    created_at: s.row.created_at,
    // event_ts is the REAL recency-surfacing projection site (store.fetch is
    // SELECT * so s.row already has it, but this explicit return literal —
    // not the fetch — is what feeds recall-format's ts= token). Omitting it
    // here would silently surface seed-run created_at as "when it happened"
    // for every seeded row with no error. null for live rows (honest, not a
    // fabricated provenance time).
    event_ts: s.row.event_ts ?? null,
    rerank_score: s.rerankScore,
    rrf_score: s.rrfScore,
  }));
}

function recencyBoost(createdAtIso, nowMs, decayDays, maxBoost) {
  const created = Date.parse(createdAtIso);
  if (Number.isNaN(created)) return 0;
  const ageDays = (nowMs - created) / MS_PER_DAY;
  // A future timestamp (created > now) is not a credible "this is fresh"
  // signal — it means clock skew (a laptop + a second machine syncing
  // transcripts via OneDrive can disagree by seconds-to-minutes), an
  // edited/corrupted JSONL record, or a seeded event_ts stamped by a
  // faster machine. Treat it exactly like the unparseable-date case above:
  // contribute NO boost, instead of the MAXIMUM boost the `ageDays <= 0`
  // branch below would otherwise hand out — which let a single skewed,
  // stale row outrank every genuinely fresh fact on every recall.
  // created_at is monotonic (set at insert, never future), so this guard
  // only ever fires on the event_ts path the seeding overhaul introduced —
  // zero regression for NULL-event_ts (live) rows that fall back to
  // created_at and can never reach it.
  if (ageDays < 0) return 0;
  if (ageDays <= 0) return maxBoost;
  if (ageDays >= decayDays) return 0;
  return maxBoost * (1 - ageDays / decayDays);
}
