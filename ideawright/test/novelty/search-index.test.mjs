import test from "node:test";
import assert from "node:assert/strict";
import { runSearchBattery } from "../../lib/novelty/search/index.mjs";
import { routeMock } from "./_fetch-mock.mjs";

test("runSearchBattery dedups identical URLs across sources", async () => {
  const restore = routeMock([
    {
      match: /hn\.algolia\.com/,
      json: { hits: [{ objectID: "1", title: "x", url: "https://example.com/item", points: 1, num_comments: 0 }] }
    },
    {
      match: /api\.github\.com\/search\/repositories/,
      json: { items: [{ full_name: "ex/item", html_url: "https://example.com/item", description: "d", stargazers_count: 10, language: "JS" }] }
    },
    { match: /api\.github\.com\/search\/code/, json: { items: [] } },
    { match: /registry\.npmjs\.org/, json: { objects: [] } },
    { match: /duckduckgo\.com/, body: "" }
  ]);
  try {
    const variants = [{ query: "test", strategy: "exact" }];
    const { results } = await runSearchBattery(variants, { timeoutMs: 5000 });
    assert.equal(results.length, 1, "duplicate URLs across HN + GitHub dedup to one row");
    assert.ok(results[0].origins.includes("hn"));
    assert.ok(results[0].origins.includes("github-repo"));
  } finally { restore(); }
});

test("runSearchBattery strips tracking params during dedup", async () => {
  const restore = routeMock([
    {
      match: /hn\.algolia\.com/,
      json: { hits: [
        { objectID: "1", title: "a", url: "https://example.com/x?utm_source=foo", points: 1, num_comments: 0 },
        { objectID: "2", title: "b", url: "https://example.com/x?utm_medium=bar", points: 1, num_comments: 0 }
      ] }
    },
    { match: /api\.github\.com/, json: { items: [] } },
    { match: /registry\.npmjs\.org/, json: { objects: [] } },
    { match: /duckduckgo\.com/, body: "" }
  ]);
  try {
    const { results } = await runSearchBattery([{ query: "q", strategy: "exact" }]);
    assert.equal(results.length, 1, "utm variants collapse to one row");
  } finally { restore(); }
});

test("runSearchBattery with site: variant only hits DDG", async () => {
  let hnCalled = false, githubCalled = false, ddgCalled = false;
  const restore = routeMock([
    { match: /hn\.algolia\.com/, json: (hnCalled = true, { hits: [] }) },
    { match: /api\.github\.com/, json: (githubCalled = true, { items: [] }) },
    { match: /registry\.npmjs\.org/, json: { objects: [] } },
    { match: /pypi\.org/, body: "" },
    { match: /duckduckgo\.com/, body: (ddgCalled = true, "") }
  ]);
  hnCalled = false; githubCalled = false; ddgCalled = false;
  try {
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (/hn\.algolia\.com/.test(u)) { hnCalled = true; return { ok: true, status: 200, headers: { get: () => null }, async json(){return{hits:[]};}, async text(){return"";} }; }
      if (/api\.github\.com/.test(u)) { githubCalled = true; return { ok: true, status: 200, headers: { get: () => null }, async json(){return{items:[]};}, async text(){return"";} }; }
      if (/registry\.npmjs\.org/.test(u)) { return { ok: true, status: 200, headers: { get: () => null }, async json(){return{objects:[]};}, async text(){return"";} }; }
      if (/duckduckgo\.com/.test(u)) { ddgCalled = true; return { ok: true, status: 200, headers: { get: () => null }, async json(){return{};}, async text(){return"";} }; }
      return { ok: true, status: 200, headers: { get: () => null }, async json(){return{};}, async text(){return"";} };
    };
    const variants = [{ query: "q site:github.com", strategy: "site:github.com" }];
    await runSearchBattery(variants);
    assert.equal(ddgCalled, true);
    assert.equal(hnCalled, false, "site: variant must not hit HN");
    assert.equal(githubCalled, false, "site: variant must not hit GitHub API");
  } finally { restore(); }
});

test("runSearchBattery dedups identical queries across variants", async () => {
  let ddgCalls = 0;
  const orig = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (/duckduckgo\.com/.test(String(url))) ddgCalls++;
    return { ok: true, status: 200, headers: { get: () => null }, async json(){return{items:[],hits:[],objects:[]};}, async text(){return"";} };
  };
  try {
    const variants = [
      { query: "same", strategy: "exact" },
      { query: "same", strategy: "keywords" },
      { query: "same", strategy: "feature" }
    ];
    await runSearchBattery(variants);
    assert.equal(ddgCalls, 1, "duplicate queries should only call DDG once");
  } finally { globalThis.fetch = orig; }
});

test("runSearchBattery captures per-source errors without crashing", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (/hn\.algolia\.com/.test(String(url))) {
      return { ok: false, status: 500, headers: { get: () => null }, async text(){return"";}, async json(){throw new Error();} };
    }
    return { ok: true, status: 200, headers: { get: () => null }, async json(){return{items:[],hits:[],objects:[]};}, async text(){return"";} };
  };
  try {
    const { results, errors } = await runSearchBattery([{ query: "q", strategy: "exact" }]);
    assert.ok(Array.isArray(results));
    assert.ok(errors.some(e => /hn/.test(e.source)));
  } finally { globalThis.fetch = orig; }
});

test("runSearchBattery respects per-host concurrency cap", async () => {
  let activeDDG = 0, peakDDG = 0;
  const orig = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (/duckduckgo\.com/.test(u)) {
      activeDDG++;
      peakDDG = Math.max(peakDDG, activeDDG);
      await new Promise(r => setTimeout(r, 5));
      activeDDG--;
    }
    return { ok: true, status: 200, headers: { get: () => null }, async json(){return{items:[],hits:[],objects:[]};}, async text(){return"";} };
  };
  try {
    const variants = Array.from({ length: 10 }, (_, i) => ({ query: `q${i}`, strategy: "exact" }));
    await runSearchBattery(variants, { hostCaps: { ddg: 2, exa: 10, github: 10, hn: 10, npm: 10, scholar: 10 }, sources: { exa: { enabled: false }, scholar: { enabled: false } } });
    assert.ok(peakDDG <= 2, `DDG concurrency cap=2 violated, peak=${peakDDG}`);
  } finally { globalThis.fetch = orig; }
});

test("runSearchBattery records queries_run labels", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true, status: 200, headers: { get: () => null },
    async json(){return{items:[],hits:[],objects:[]};}, async text(){return"";}
  });
  try {
    const { queries_run } = await runSearchBattery([
      { query: "q1", strategy: "exact" },
      { query: "q2 site:github.com", strategy: "site:github.com" }
    ]);
    assert.ok(queries_run.some(s => s.includes("ddg[exact]")));
    assert.ok(queries_run.some(s => s.includes("ddg[site:github.com]")));
    assert.ok(queries_run.some(s => s.includes("hn[exact]")));
    assert.ok(!queries_run.some(s => s.includes("hn[site:")));
  } finally { globalThis.fetch = orig; }
});
