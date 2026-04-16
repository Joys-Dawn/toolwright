import test from "node:test";
import assert from "node:assert/strict";
import { buildQueryVariants } from "../../lib/novelty/query-variants.mjs";

const idea = {
  title: "Recipe pantry sync for low-effort meal planning",
  summary: "A tool that syncs your pantry inventory to recipe suggestions and auto-generates a grocery list.",
  target_user: "busy home cooks"
};

test("buildQueryVariants emits exact + keyword + feature + site-scoped variants", () => {
  const variants = buildQueryVariants(idea);
  const strategies = new Set(variants.map(v => v.strategy));
  assert.ok(strategies.has("exact"));
  assert.ok(strategies.has("keywords"));
  assert.ok([...strategies].some(s => s.startsWith("feature")));
  assert.ok([...strategies].some(s => s.startsWith("site:github.com")));
  assert.ok([...strategies].some(s => s.startsWith("site:producthunt.com")));
  assert.ok([...strategies].some(s => s.startsWith("site:chromewebstore.google.com")));
});

test("buildQueryVariants dedupes identical queries", () => {
  const variants = buildQueryVariants({ title: "x", summary: "x", target_user: "x" });
  const queries = variants.map(v => v.query);
  assert.equal(new Set(queries).size, queries.length);
});

test("buildQueryVariants strips stopwords and keeps meaningful keywords", () => {
  const v = buildQueryVariants({
    title: "The best tool for the job",
    summary: "It is a tool that does the job",
    target_user: "anyone"
  });
  const keywordVariant = v.find(x => x.strategy === "keywords");
  assert.ok(keywordVariant, "should have a keywords variant");
  assert.ok(!/\b(the|for|is|a|that|does)\b/i.test(keywordVariant.query), "stopwords should be removed");
});

test("buildQueryVariants handles empty target_user", () => {
  const v = buildQueryVariants({ title: "foo bar", summary: "baz qux" });
  assert.ok(v.length > 0);
});
