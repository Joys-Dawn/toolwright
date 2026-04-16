const DEFAULT_THRESHOLDS = {
  competitorOverlap: 0.6,
  novelMax: 2,
  nicheMax: 5,
  erroredRatioClamp: 0.5
};

export function aggregateVerdict(scoredResults, opts = {}) {
  const t = { ...DEFAULT_THRESHOLDS, ...opts };
  const total = scoredResults.length;
  const errored = scoredResults.filter(r => r.judge_error).length;
  const erroredRatio = total > 0 ? errored / total : 0;

  const competitors = scoredResults
    .filter(r => !r.judge_error && r.is_competitor && r.overlap_score >= t.competitorOverlap)
    .sort((a, b) => b.overlap_score - a.overlap_score);

  const count = competitors.length;
  let verdict;
  if (count <= t.novelMax) verdict = "novel";
  else if (count <= t.nicheMax) verdict = "niche";
  else verdict = "crowded";

  if (total > 0 && erroredRatio > t.erroredRatioClamp && verdict === "novel") {
    verdict = "niche";
  }

  const avgOverlap = competitors.length
    ? competitors.reduce((s, r) => s + r.overlap_score, 0) / competitors.length
    : 0;
  const penalty = Math.min(count * 12, 80);
  let score_0_100 = Math.max(0, Math.round(100 - penalty - avgOverlap * 20));
  if (erroredRatio > t.erroredRatioClamp) {
    score_0_100 = Math.min(score_0_100, 50);
  } else if (erroredRatio > 0.25) {
    score_0_100 = Math.round(score_0_100 * (1 - erroredRatio * 0.5));
  }

  const topCompetitors = competitors.slice(0, 5).map(r => ({
    name: r.title,
    url: r.url,
    overlap: r.overlap_score,
    why: r.reason
  }));

  return {
    score_0_100,
    verdict,
    competitors: topCompetitors,
    competitor_count: count,
    errored_count: errored,
    total_scored: total
  };
}
