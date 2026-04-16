import test from "node:test";
import assert from "node:assert/strict";
import { searchGitHubRepos, searchGitHubCode } from "../../lib/novelty/search/github.mjs";

function mkResp({ status = 200, json = {}, headers = {} } = {}) {
  const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: k => h[String(k).toLowerCase()] ?? null },
    async json() { return json; },
    async text() { return JSON.stringify(json); }
  };
}

function mockFetch(resp) {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => (Array.isArray(resp) ? resp.shift() : resp);
  return () => { globalThis.fetch = orig; };
}

function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; }
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  return (async () => {
    try { return await fn(); }
    finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }
  })();
}

test("searchGitHubRepos maps items to normalized shape", async () => {
  const restore = mockFetch(mkResp({
    json: {
      items: [
        { full_name: "foo/bar", html_url: "https://github.com/foo/bar", description: "a tool", stargazers_count: 42, language: "Rust", pushed_at: "2024-01-01" }
      ]
    }
  }));
  try {
    const rows = await searchGitHubRepos("q");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].source, "github-repo");
    assert.equal(rows[0].url, "https://github.com/foo/bar");
    assert.equal(rows[0].title, "foo/bar");
    assert.match(rows[0].snippet, /a tool • 42★ • Rust/);
    assert.equal(rows[0].meta.stars, 42);
  } finally { restore(); }
});

test("searchGitHubRepos returns [] on rate limit (403 + remaining=0)", async () => {
  const restore = mockFetch(mkResp({
    status: 403,
    headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "0" }
  }));
  try {
    const rows = await searchGitHubRepos("q");
    assert.deepEqual(rows, []);
  } finally { restore(); }
});

test("searchGitHubRepos throws on non-ratelimit 4xx", async () => {
  const restore = mockFetch(mkResp({ status: 422 }));
  try {
    await assert.rejects(() => searchGitHubRepos("q"), /status=422/);
  } finally { restore(); }
});

test("searchGitHubCode returns [] when no GITHUB_TOKEN set", async () => {
  await withEnv({ GITHUB_TOKEN: undefined, GH_TOKEN: undefined }, async () => {
    let called = false;
    const orig = globalThis.fetch;
    globalThis.fetch = async () => { called = true; return mkResp({ json: { items: [] } }); };
    try {
      const rows = await searchGitHubCode("q");
      assert.deepEqual(rows, []);
      assert.equal(called, false, "must not hit network without token");
    } finally { globalThis.fetch = orig; }
  });
});

test("searchGitHubCode calls API when token is set", async () => {
  await withEnv({ GITHUB_TOKEN: "ghp_test", GH_TOKEN: undefined }, async () => {
    let authHeader = null;
    const orig = globalThis.fetch;
    globalThis.fetch = async (_url, opts) => {
      authHeader = opts?.headers?.Authorization;
      return mkResp({
        json: { items: [{ html_url: "https://github.com/x/y/README.md", name: "README.md", path: "README.md", repository: { full_name: "x/y" } }] }
      });
    };
    try {
      const rows = await searchGitHubCode("q");
      assert.equal(rows.length, 1);
      assert.equal(rows[0].source, "github-code");
      assert.equal(authHeader, "Bearer ghp_test");
    } finally { globalThis.fetch = orig; }
  });
});

test("searchGitHubCode returns [] on rate limit", async () => {
  await withEnv({ GITHUB_TOKEN: "ghp_test" }, async () => {
    const restore = mockFetch(mkResp({
      status: 403,
      headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "0" }
    }));
    try {
      const rows = await searchGitHubCode("q");
      assert.deepEqual(rows, []);
    } finally { restore(); }
  });
});
