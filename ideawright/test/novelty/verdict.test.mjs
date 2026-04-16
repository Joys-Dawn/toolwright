import test from "node:test";
import assert from "node:assert/strict";
import { aggregateVerdict } from "../../lib/novelty/verdict.mjs";

function mkResult({ competitor = true, overlap = 0.8, title = "comp", url = "u", reason = "r" } = {}) {
  return {
    source: "ddg",
    title,
    snippet: "",
    url,
    is_competitor: competitor,
    overlap_score: overlap,
    reason,
    serves_same_user: true,
    solves_same_pain: true
  };
}

test("verdict=novel when 0 competitors", () => {
  const v = aggregateVerdict([]);
  assert.equal(v.verdict, "novel");
  assert.equal(v.competitor_count, 0);
  assert.equal(v.competitors.length, 0);
});

test("verdict=novel when ≤2 competitors above threshold", () => {
  const v = aggregateVerdict([mkResult(), mkResult({ url: "b" })]);
  assert.equal(v.verdict, "novel");
  assert.equal(v.competitor_count, 2);
});

test("verdict=niche for 3-5 competitors", () => {
  const results = Array.from({ length: 4 }, (_, i) => mkResult({ url: `u${i}` }));
  const v = aggregateVerdict(results);
  assert.equal(v.verdict, "niche");
  assert.equal(v.competitor_count, 4);
});

test("verdict=crowded for 6+ competitors", () => {
  const results = Array.from({ length: 8 }, (_, i) => mkResult({ url: `u${i}` }));
  const v = aggregateVerdict(results);
  assert.equal(v.verdict, "crowded");
  assert.equal(v.competitor_count, 8);
});

test("verdict ignores low-overlap results", () => {
  const v = aggregateVerdict([
    mkResult({ overlap: 0.3 }),
    mkResult({ overlap: 0.4, url: "b" }),
    mkResult({ overlap: 0.5, url: "c" })
  ]);
  assert.equal(v.verdict, "novel");
  assert.equal(v.competitor_count, 0);
});

test("verdict ignores results marked is_competitor=false", () => {
  const v = aggregateVerdict([
    mkResult({ competitor: false, overlap: 0.95 }),
    mkResult({ competitor: false, overlap: 0.95, url: "b" })
  ]);
  assert.equal(v.competitor_count, 0);
});

test("score_0_100 decreases as competitor count increases", () => {
  const few = aggregateVerdict([mkResult()]);
  const many = aggregateVerdict(Array.from({ length: 8 }, (_, i) => mkResult({ url: `u${i}` })));
  assert.ok(few.score_0_100 > many.score_0_100);
});

test("top competitors are sorted by overlap_score descending", () => {
  const v = aggregateVerdict([
    mkResult({ overlap: 0.7, url: "a", title: "low" }),
    mkResult({ overlap: 0.95, url: "b", title: "high" }),
    mkResult({ overlap: 0.8, url: "c", title: "mid" })
  ]);
  assert.equal(v.competitors[0].name, "high");
  assert.ok(v.competitors[0].overlap >= v.competitors.at(-1).overlap);
});

test("custom thresholds override defaults", () => {
  const results = Array.from({ length: 3 }, (_, i) => mkResult({ url: `u${i}` }));
  const v = aggregateVerdict(results, { novelMax: 0, nicheMax: 1 });
  assert.equal(v.verdict, "crowded");
});

test("judge-errored results are excluded from competitor count", () => {
  const results = [
    { ...mkResult({ overlap: 0.9 }), judge_error: true },
    { ...mkResult({ overlap: 0.9, url: "b" }), judge_error: true },
    mkResult({ overlap: 0.9, url: "c" })
  ];
  const v = aggregateVerdict(results);
  assert.equal(v.competitor_count, 1);
  assert.equal(v.errored_count, 2);
  assert.equal(v.total_scored, 3);
});

test("high judge-error ratio downgrades novel to niche", () => {
  const results = [
    ...Array.from({ length: 8 }, (_, i) => ({ ...mkResult({ url: `e${i}` }), judge_error: true })),
    ...Array.from({ length: 2 }, (_, i) => mkResult({ competitor: false, overlap: 0.1, url: `ok${i}` }))
  ];
  const v = aggregateVerdict(results);
  assert.equal(v.verdict, "niche", "cannot confirm novelty with >50% judge errors");
  assert.equal(v.errored_count, 8);
});

test("high judge-error ratio clamps score_0_100", () => {
  const results = Array.from({ length: 10 }, (_, i) => ({ ...mkResult({ url: `e${i}` }), judge_error: true }));
  const v = aggregateVerdict(results);
  assert.ok(v.score_0_100 <= 50, `expected clamped score, got ${v.score_0_100}`);
});

test("low judge-error ratio does not downgrade novel", () => {
  const results = [
    { ...mkResult({ overlap: 0.9 }), judge_error: true },
    ...Array.from({ length: 9 }, (_, i) => mkResult({ competitor: false, overlap: 0.1, url: `ok${i}` }))
  ];
  const v = aggregateVerdict(results);
  assert.equal(v.verdict, "novel");
  assert.equal(v.errored_count, 1);
});

test("empty scoredResults returns 0 errored_count and 0 total_scored", () => {
  const v = aggregateVerdict([]);
  assert.equal(v.errored_count, 0);
  assert.equal(v.total_scored, 0);
});
