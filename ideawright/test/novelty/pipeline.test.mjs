import test from "node:test";
import assert from "node:assert/strict";
import { runNoveltyPipeline } from "../../lib/novelty/pipeline.mjs";
import { routeMock } from "./_fetch-mock.mjs";

const idea = {
  title: "Dotfile sync tool",
  summary: "Syncs shell and editor dotfiles across machines",
  target_user: "developers"
};

// Returns a judge mock that emits one verdict per <result id="N"> seen in
// the batched prompt, cloned from `perResult`. Mirrors what a real LLM would
// return for the batched scorer.
function batchJudge(perResult) {
  return async ({ user }) => {
    const ids = [...user.matchAll(/<result id="(\d+)">/g)].map((m) => Number(m[1]));
    return { verdicts: ids.map((id) => ({ id, ...perResult })) };
  };
}

test("runNoveltyPipeline returns novelty + debug with required fields", async () => {
  const restore = routeMock([
    { match: /hn\.algolia\.com/, json: { hits: [] } },
    { match: /api\.github\.com/, json: { items: [] } },
    { match: /registry\.npmjs\.org/, json: { objects: [] } },
    { match: /duckduckgo\.com/, body: "<html></html>" }
  ]);
  try {
    const judge = async () => ({
      is_competitor: false,
      overlap_score: 0,
      reason: "not a competitor",
      serves_same_user: false,
      solves_same_pain: false
    });
    const { novelty, debug } = await runNoveltyPipeline(idea, { judge, concurrency: 2 });
    assert.equal(novelty.verdict, "novel");
    assert.ok(typeof novelty.score_0_100 === "number");
    assert.ok(Array.isArray(novelty.competitors));
    assert.ok(Array.isArray(novelty.queries_run));
    assert.ok(novelty.queries_run.length > 0);
    assert.ok(typeof novelty.verified_at === "string");
    assert.ok(typeof debug.variant_count === "number");
    assert.ok(debug.variant_count > 0);
    assert.ok(typeof debug.started_at === "string");
  } finally { restore(); }
});

test("runNoveltyPipeline marks crowded when judge flags many competitors", async () => {
  const hnHits = Array.from({ length: 10 }, (_, i) => ({
    objectID: String(i),
    title: `similar tool ${i}`,
    url: `https://example.com/${i}`,
    points: 50,
    num_comments: 5,
    created_at: "2024-01-01"
  }));
  const restore = routeMock([
    { match: /hn\.algolia\.com/, json: { hits: hnHits } },
    { match: /api\.github\.com/, json: { items: [] } },
    { match: /registry\.npmjs\.org/, json: { objects: [] } },
    { match: /pypi\.org/, body: "" },
    { match: /duckduckgo\.com/, body: "" }
  ]);
  try {
    const judge = batchJudge({
      is_competitor: true,
      overlap_score: 0.9,
      reason: "matches",
      serves_same_user: true,
      solves_same_pain: true,
    });
    const { novelty } = await runNoveltyPipeline(idea, { judge, concurrency: 4 });
    assert.equal(novelty.verdict, "crowded");
    assert.ok(novelty.competitor_count >= 6);
  } finally { restore(); }
});

test("runNoveltyPipeline propagates custom thresholds", async () => {
  const hnHits = Array.from({ length: 3 }, (_, i) => ({
    objectID: String(i), title: `t${i}`, url: `https://ex.com/${i}`, points: 1, num_comments: 0
  }));
  const restore = routeMock([
    { match: /hn\.algolia\.com/, json: { hits: hnHits } },
    { match: /api\.github\.com/, json: { items: [] } },
    { match: /registry\.npmjs\.org/, json: { objects: [] } },
    { match: /pypi\.org/, body: "" },
    { match: /duckduckgo\.com/, body: "" }
  ]);
  try {
    const judge = batchJudge({
      is_competitor: true, overlap_score: 0.9, reason: "", serves_same_user: true, solves_same_pain: true,
    });
    const strict = await runNoveltyPipeline(idea, {
      judge, concurrency: 2, thresholds: { novelMax: 0, nicheMax: 0, competitorOverlap: 0.6 }
    });
    assert.equal(strict.novelty.verdict, "crowded");
    const permissive = await runNoveltyPipeline(idea, {
      judge, concurrency: 2, thresholds: { novelMax: 100, nicheMax: 200, competitorOverlap: 0.6 }
    });
    assert.equal(permissive.novelty.verdict, "novel");
  } finally { restore(); }
});

test("runNoveltyPipeline debug surfaces search errors", async () => {
  const restore = routeMock([
    { match: /hn\.algolia\.com/, status: 500, body: "server error" },
    { match: /api\.github\.com/, json: { items: [] } },
    { match: /registry\.npmjs\.org/, json: { objects: [] } },
    { match: /pypi\.org/, body: "" },
    { match: /duckduckgo\.com/, body: "" }
  ]);
  try {
    const judge = async () => ({ is_competitor: false, overlap_score: 0, reason: "", serves_same_user: false, solves_same_pain: false });
    const { debug } = await runNoveltyPipeline(idea, { judge, concurrency: 2 });
    assert.ok(debug.search_errors.length > 0, "should capture HN 500 errors");
    assert.ok(debug.search_errors.some(e => /hn/.test(e.source)));
  } finally { restore(); }
});
