import { buildQueryVariants } from "./query-variants.mjs";
import { runSearchBattery } from "./search/index.mjs";
import { prefilterResults } from "./prefilter.mjs";
import { scoreResults } from "./scorer.mjs";
import { aggregateVerdict } from "./verdict.mjs";

export async function runNoveltyPipeline(idea, options = {}) {
  const {
    maxCandidates = 25,
    searchTimeoutMs = 15000,
    limitPerSource = 8,
    thresholds,
    judge,
    model,
    sources,
  } = options;

  const startedAt = new Date().toISOString();
  const variants = buildQueryVariants(idea);
  const battery = await runSearchBattery(variants, {
    timeoutMs: searchTimeoutMs,
    limitPerSource,
    sources,
  });
  const candidates = prefilterResults(idea, battery.results, { keep: maxCandidates });
  const scorerOpts = { judge };
  if (model) scorerOpts.model = model;
  const scored = await scoreResults(idea, candidates, scorerOpts);
  const verdict = aggregateVerdict(scored, thresholds);
  const verified_at = new Date().toISOString();

  return {
    novelty: {
      score_0_100: verdict.score_0_100,
      verdict: verdict.verdict,
      competitors: verdict.competitors,
      competitor_count: verdict.competitor_count,
      errored_count: verdict.errored_count,
      total_scored: verdict.total_scored,
      queries_run: battery.queries_run,
      verified_at
    },
    debug: {
      variant_count: variants.length,
      raw_result_count: battery.results.length,
      prefilter_count: candidates.length,
      competitor_count: verdict.competitor_count,
      search_errors: battery.errors,
      judge_errors: scored.filter(r => r.judge_error).length,
      started_at: startedAt
    }
  };
}
