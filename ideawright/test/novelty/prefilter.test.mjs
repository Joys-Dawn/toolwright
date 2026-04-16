import test from "node:test";
import assert from "node:assert/strict";
import { prefilterResults, _internal } from "../../lib/novelty/prefilter.mjs";

const { tokenize, jaccard } = _internal;

test("tokenize strips stopwords and short tokens", () => {
  const toks = tokenize("The quick brown fox");
  assert.ok(toks.has("quick"));
  assert.ok(toks.has("brown"));
  assert.ok(!toks.has("the"));
});

test("jaccard returns 1 for identical sets", () => {
  const a = tokenize("alpha beta gamma");
  assert.equal(jaccard(a, a), 1);
});

test("jaccard returns 0 for disjoint sets", () => {
  const a = tokenize("alpha beta");
  const b = tokenize("gamma delta");
  assert.equal(jaccard(a, b), 0);
});

test("prefilterResults ranks results by Jaccard similarity", () => {
  const idea = { title: "pantry sync", summary: "syncs pantry to recipes", target_user: "home cooks" };
  const results = [
    { title: "unrelated crypto app", snippet: "blockchain wallet", url: "a", source: "ddg" },
    { title: "pantry sync tool", snippet: "syncs pantry inventory with recipes", url: "b", source: "ddg" },
    { title: "recipe finder", snippet: "finds recipes", url: "c", source: "ddg" }
  ];
  const ranked = prefilterResults(idea, results);
  assert.equal(ranked[0].url, "b", "most similar should rank first");
  assert.ok(ranked[0].prefilter_score > ranked[2].prefilter_score);
  assert.ok(ranked[2].prefilter_score > ranked.at(-1).prefilter_score - 0.0001);
});

test("prefilterResults caps result count", () => {
  const idea = { title: "x", summary: "y", target_user: "z" };
  const results = Array.from({ length: 50 }, (_, i) => ({
    title: `r${i}`, snippet: "", url: `u${i}`, source: "ddg"
  }));
  const ranked = prefilterResults(idea, results, { keep: 10 });
  assert.equal(ranked.length, 10);
});
