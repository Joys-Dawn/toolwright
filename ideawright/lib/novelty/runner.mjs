import { openDb, listByStatus, updateNovelty } from "../db.mjs";
import { runNoveltyPipeline } from "./pipeline.mjs";
import { makeHostLimiters } from "./search/index.mjs";

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
    // Upper bound on how many `new` ideas this pass will touch. There is no
    // actual batching here (each idea triggers its own search-+-judge), so
    // this is a per-invocation LIMIT, not a batch size. Default: unlimited.
    maxPerRun = Infinity,
    // Per-pass concurrency: how many ideas are processed in parallel. Each
    // idea fires its own search battery (Exa/GitHub/HN/npm/Scholar) + an
    // LLM scoring call. Per-host limiters are SHARED across all ideas in
    // this pass (see hostLimiters below), so per-host caps stay global
    // regardless of concurrency. The LLM scoring call is the only thing
    // that scales linearly with concurrency. Default: 8.
    concurrency = 8,
    hostCaps,
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
    const limit = Number.isFinite(maxPerRun) ? maxPerRun : Number.MAX_SAFE_INTEGER;
    const rows = listByStatus(db, "new", limit);
    const summary = {
      processed: 0,
      novel: 0,
      niche: 0,
      crowded: 0,
      errors: 0,
      details: new Array(rows.length),
    };

    // One shared limiter set for the whole pass. With concurrency > 1,
    // per-idea limiters would multiply per-host load by concurrency
    // (e.g., 8 ideas × 2 GitHub = 16 in flight against a 30/min cap).
    // Sharing keeps per-host caps global.
    const hostLimiters = makeHostLimiters(hostCaps);

    const pipelineOpts = {
      searchTimeoutMs,
      limitPerSource,
      thresholds: effectiveThresholds,
      judge,
      sources,
      limiters: hostLimiters,
    };
    if (model) pipelineOpts.model = model;

    async function processIdea(idea, index) {
      try {
        const { novelty, debug } = await pipeline(idea, pipelineOpts);
        const newStatus = nextStatus(novelty.verdict);
        updateNovelty(db, idea.id, novelty, newStatus);
        summary.processed++;
        if (novelty.verdict === "novel" || novelty.verdict === "niche" || novelty.verdict === "crowded") {
          summary[novelty.verdict]++;
        } else {
          summary.errors++;
        }
        summary.details[index] = {
          id: idea.id,
          title: idea.title,
          verdict: novelty.verdict,
          competitor_count: novelty.competitors.length,
          next_status: newStatus,
          debug,
        };
        if (onIdea) onIdea({ idea, novelty, newStatus, debug });
      } catch (e) {
        summary.errors++;
        summary.details[index] = {
          id: idea.id,
          title: idea.title,
          error: e?.message || String(e),
        };
      }
    }

    // Bounded concurrency: spawn N workers that pull from a shared index.
    // JS is single-threaded so the index++ and counter mutations are safe
    // between await points. summary.details is pre-sized + indexed so order
    // is preserved regardless of completion order.
    const effectiveConcurrency = Math.max(
      1,
      Math.min(Number.isFinite(concurrency) ? concurrency : 1, rows.length),
    );
    let nextIndex = 0;
    async function worker() {
      while (nextIndex < rows.length) {
        const i = nextIndex++;
        await processIdea(rows[i], i);
      }
    }
    await Promise.all(
      Array.from({ length: effectiveConcurrency }, () => worker()),
    );

    return summary;
  } finally {
    if (ownDb && typeof db.close === "function") db.close();
  }
}
