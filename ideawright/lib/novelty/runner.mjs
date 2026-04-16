import { openDb, listByStatus, updateNovelty } from "../db.mjs";
import { runNoveltyPipeline } from "./pipeline.mjs";

const DEFAULTS = { pipeline: runNoveltyPipeline };

function nextStatus(verdict) {
  if (verdict === "novel" || verdict === "niche") return "verified";
  return "archived";
}

export async function runNoveltyPass(options = {}) {
  const {
    repoRoot,
    filename,
    db: providedDb,
    batchSize = 10,
    searchTimeoutMs = 15000,
    limitPerSource = 8,
    minSimilarity,
    thresholds,
    judge,
    model,
    sources,
    onIdea,
    pipeline = DEFAULTS.pipeline
  } = options;

  const effectiveThresholds = thresholds ?? (
    typeof minSimilarity === "number" ? { competitorOverlap: minSimilarity } : undefined
  );

  const db = providedDb ?? openDb({ repoRoot, filename });
  const ownDb = !providedDb;

  try {
    const rows = listByStatus(db, "new", batchSize);
    const summary = {
      processed: 0,
      novel: 0,
      niche: 0,
      crowded: 0,
      errors: 0,
      details: []
    };

    for (const idea of rows) {
      try {
        const pipelineOpts = {
          searchTimeoutMs,
          limitPerSource,
          thresholds: effectiveThresholds,
          judge,
          sources,
        };
        if (model) pipelineOpts.model = model;
        const { novelty, debug } = await pipeline(idea, pipelineOpts);
        const newStatus = nextStatus(novelty.verdict);
        updateNovelty(db, idea.id, novelty, newStatus);
        summary.processed++;
        if (novelty.verdict === "novel" || novelty.verdict === "niche" || novelty.verdict === "crowded") {
          summary[novelty.verdict]++;
        } else {
          summary.errors++;
        }
        summary.details.push({
          id: idea.id,
          title: idea.title,
          verdict: novelty.verdict,
          competitor_count: novelty.competitors.length,
          next_status: newStatus,
          debug
        });
        if (onIdea) onIdea({ idea, novelty, newStatus, debug });
      } catch (e) {
        summary.errors++;
        summary.details.push({
          id: idea.id,
          title: idea.title,
          error: e?.message || String(e)
        });
      }
    }
    return summary;
  } finally {
    if (ownDb && typeof db.close === "function") db.close();
  }
}
