import test from "node:test";
import assert from "node:assert/strict";
import { installFetchMock, mockResponse } from "./_fetch-mock.mjs";
import { searchScholar } from "../../lib/novelty/search/scholar.mjs";

test("searchScholar maps Semantic Scholar response to standard shape", async () => {
  const restore = installFetchMock(async (url) => {
    assert.ok(url.includes("api.semanticscholar.org/graph/v1/paper/search"));
    assert.ok(url.includes("query=dotfile+sync"));
    assert.ok(url.includes("fields=title"));
    return mockResponse({
      json: {
        total: 2,
        data: [
          { paperId: "abc123", title: "Dotfile Management", url: "https://s2.org/paper/abc123", abstract: "We present a system for managing dotfiles.", citationCount: 42, year: 2024 },
          { paperId: "def456", title: "Config Sync", url: null, abstract: null, citationCount: 0, year: 2025 },
        ],
      },
    });
  });
  try {
    const results = await searchScholar("dotfile sync", { limit: 5 });
    assert.equal(results.length, 2);
    assert.equal(results[0].source, "scholar");
    assert.equal(results[0].url, "https://s2.org/paper/abc123");
    assert.equal(results[0].title, "Dotfile Management");
    assert.ok(results[0].snippet.includes("managing dotfiles"));
    assert.equal(results[0].meta.citationCount, 42);
    assert.equal(results[1].url, "https://www.semanticscholar.org/paper/def456");
    assert.ok(results[1].snippet.includes("0 citations"));
  } finally {
    restore();
  }
});

test("searchScholar sends API key header when env var is set", async () => {
  const orig = process.env.SEMANTIC_SCHOLAR_API_KEY;
  process.env.SEMANTIC_SCHOLAR_API_KEY = "test-s2-key";
  let capturedHeaders;
  const restore = installFetchMock(async (url, opts) => {
    capturedHeaders = opts.headers;
    return mockResponse({ json: { data: [] } });
  });
  try {
    await searchScholar("test");
    assert.equal(capturedHeaders["x-api-key"], "test-s2-key");
  } finally {
    restore();
    if (orig !== undefined) process.env.SEMANTIC_SCHOLAR_API_KEY = orig;
    else delete process.env.SEMANTIC_SCHOLAR_API_KEY;
  }
});

test("searchScholar works without API key (no x-api-key header)", async () => {
  const orig = process.env.SEMANTIC_SCHOLAR_API_KEY;
  delete process.env.SEMANTIC_SCHOLAR_API_KEY;
  let capturedHeaders;
  const restore = installFetchMock(async (url, opts) => {
    capturedHeaders = opts.headers;
    return mockResponse({ json: { data: [] } });
  });
  try {
    await searchScholar("test");
    assert.equal(capturedHeaders["x-api-key"], undefined);
  } finally {
    restore();
    if (orig !== undefined) process.env.SEMANTIC_SCHOLAR_API_KEY = orig;
  }
});

test("searchScholar throws on non-2xx response", async () => {
  const restore = installFetchMock(async () => mockResponse({ status: 429 }));
  try {
    await assert.rejects(() => searchScholar("q"), /scholar status=429/);
  } finally {
    restore();
  }
});

test("searchScholar handles empty data array", async () => {
  const restore = installFetchMock(async () => mockResponse({ json: { data: [] } }));
  try {
    const results = await searchScholar("obscure");
    assert.deepEqual(results, []);
  } finally {
    restore();
  }
});
