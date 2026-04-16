import { listByStatus } from '../db.mjs';

// Composite ranker.
// composite_rank = w.pain * pain_norm + w.novelty * novelty_norm + w.feasibility * feasibility_norm
// All three components are normalized to [0, 1]. Weights should sum to ~1.

export function rankAll({ db, weights = {} } = {}) {
  const w = {
    pain: weights.pain ?? 0.3,
    novelty: weights.novelty ?? 0.4,
    feasibility: weights.feasibility ?? 0.3,
  };
  const gated = listByStatus(db, 'gated');
  const stmt = db.prepare(
    `UPDATE ideas SET composite_rank = ?, updated_at = datetime('now') WHERE id = ?`
  );
  let ranked = 0;
  for (const idea of gated) {
    const composite = computeComposite(idea, w);
    stmt.run(composite, idea.id);
    ranked++;
  }
  return { ranked, weights: w };
}

export function computeComposite(idea, w) {
  const pain = avgPainScore(idea) / 10;
  const novelty = clamp01((idea.novelty?.score_0_100 ?? 0) / 100);
  const feasibility = clamp01((idea.feasibility?.score_0_100 ?? 0) / 100);
  return w.pain * pain + w.novelty * novelty + w.feasibility * feasibility;
}

export function avgPainScore(idea) {
  const scores = (idea.pain_evidence ?? [])
    .map(e => Number(e.pain_score_0_10))
    .filter(Number.isFinite);
  if (scores.length === 0) return 5;
  return scores.reduce((a, b) => a + b, 0) / scores.length;
}

function clamp01(n) {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}
