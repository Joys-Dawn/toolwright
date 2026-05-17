// Reciprocal Rank Fusion. score(id) = Σ_l 1 / (k + rank_l(id)); rank is
// 1-based, absent items contribute 0. k's source of truth is RRF_K in
// constants.js; the default just keeps rrfFuse callable.

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
