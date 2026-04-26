import test from "node:test";
import assert from "node:assert/strict";
import { prefilterResults } from "../../lib/novelty/prefilter.mjs";

test("prefilterResults ranks identical text at the top score (1.0)", () => {
  const idea = { title: "alpha beta gamma", summary: "", target_user: "" };
  const ranked = prefilterResults(idea, [
    { title: "alpha beta gamma", snippet: "alpha beta gamma", url: "match", source: "hn" },
    { title: "delta epsilon zeta", snippet: "totally different", url: "miss", source: "hn" }
  ]);
  assert.equal(ranked[0].url, "match");
  assert.equal(ranked[0].prefilter_score, 1);
});

test("prefilterResults gives disjoint text a score of 0", () => {
  const idea = { title: "alpha beta", summary: "", target_user: "" };
  const ranked = prefilterResults(idea, [
    { title: "gamma delta", snippet: "totally unrelated", url: "u", source: "hn" }
  ]);
  assert.equal(ranked[0].prefilter_score, 0);
});

test("prefilterResults ignores stopwords when ranking", () => {
  // Adding stopword padding to one result must not change its score relative
  // to a baseline that has no padding — proves stopwords don't drive ranking.
  const idea = { title: "pantry sync", summary: "syncs pantry to recipes", target_user: "home cooks" };
  const baseScore = prefilterResults(idea, [
    { title: "pantry sync tool", snippet: "pantry recipes", url: "u", source: "hn" }
  ])[0].prefilter_score;
  const paddedScore = prefilterResults(idea, [
    { title: "the pantry sync tool", snippet: "the pantry and the recipes", url: "u", source: "hn" }
  ])[0].prefilter_score;
  assert.equal(paddedScore, baseScore);
});

test("prefilterResults ignores tokens shorter than 3 characters", () => {
  // Two-character tokens should be filtered, so adding 'a' or 'b' must not
  // change the score.
  const idea = { title: "alpha beta", summary: "", target_user: "" };
  const baseScore = prefilterResults(idea, [
    { title: "alpha beta", snippet: "", url: "u", source: "hn" }
  ])[0].prefilter_score;
  const noisyScore = prefilterResults(idea, [
    { title: "alpha beta a b", snippet: "a a b", url: "u", source: "hn" }
  ])[0].prefilter_score;
  assert.equal(noisyScore, baseScore);
});

test("prefilterResults ranks results by similarity descending", () => {
  const idea = { title: "pantry sync", summary: "syncs pantry to recipes", target_user: "home cooks" };
  const results = [
    { title: "unrelated crypto app", snippet: "blockchain wallet", url: "a", source: "hn" },
    { title: "pantry sync tool", snippet: "syncs pantry inventory with recipes", url: "b", source: "hn" },
    { title: "recipe finder", snippet: "finds recipes", url: "c", source: "hn" }
  ];
  const ranked = prefilterResults(idea, results);
  assert.equal(ranked[0].url, "b", "most similar should rank first");
  assert.ok(ranked[0].prefilter_score >= ranked[1].prefilter_score);
  assert.ok(ranked[1].prefilter_score >= ranked[2].prefilter_score);
});

test("prefilterResults caps result count at the keep parameter", () => {
  const idea = { title: "x", summary: "y", target_user: "z" };
  const results = Array.from({ length: 50 }, (_, i) => ({
    title: `r${i}`, snippet: "", url: `u${i}`, source: "hn"
  }));
  const ranked = prefilterResults(idea, results, { keep: 10 });
  assert.equal(ranked.length, 10);
});
