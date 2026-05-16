// Reciprocal Rank Fusion. Standard k=60.
//
// Given N ranked lists, produces one fused ranking where item id gets:
//   score(id) = Σ_l 1 / (k + rank_l(id))
// rank is 1-based (best=1). Items absent from a list contribute 0 for that list.
//
// The single source of truth for k is RRF_K in constants.js. Use that for
// "what k value does mindwright use" — this default just keeps rrfFuse
// callable without callers having to wire it through.

import { RRF_K } from './constants.js';

export function rrfFuse(rankedLists, { k = RRF_K } = {}) {
  const scores = new Map();
  for (const list of rankedLists) {
    list.forEach((id, idx) => {
      const rank = idx + 1;
      const inc = 1 / (k + rank);
      scores.set(id, (scores.get(id) || 0) + inc);
    });
  }
  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score);
}
