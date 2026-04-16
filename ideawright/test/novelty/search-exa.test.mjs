import test from "node:test";
import assert from "node:assert/strict";
import { installFetchMock, mockResponse } from "./_fetch-mock.mjs";
import { searchExa } from "../../lib/novelty/search/exa.mjs";

test("searchExa returns [] when EXA_API_KEY is not set", async () => {
  const orig = process.env.EXA_API_KEY;
  delete process.env.EXA_API_KEY;
  try {
    const results = await searchExa("test query");
    assert.deepEqual(results, []);
  } finally {
    if (orig !== undefined) process.env.EXA_API_KEY = orig;
  }
});

test("searchExa maps results to standard shape", async () => {
  const orig = process.env.EXA_API_KEY;
  process.env.EXA_API_KEY = "test-key";
  const restore = installFetchMock(async (url, opts) => {
    assert.ok(url.includes("api.exa.ai/search"));
    assert.equal(opts.method, "POST");
    const body = JSON.parse(opts.body);
    assert.equal(body.query, "dotfile sync");
    assert.equal(body.numResults, 5);
    const headers = opts.headers;
    assert.equal(headers["x-api-key"], "test-key");
    return mockResponse({
      json: {
        results: [
          { url: "https://example.com/1", title: "Dotfile Tool", text: "A tool for syncing dotfiles", publishedDate: "2024-01-01", author: "Alice" },
          { url: "https://example.com/2", title: "Config Sync", text: null, publishedDate: null, author: null },
        ],
      },
    });
  });
  try {
    const results = await searchExa("dotfile sync", { limit: 5 });
    assert.equal(results.length, 2);
    assert.equal(results[0].source, "exa");
    assert.equal(results[0].url, "https://example.com/1");
    assert.equal(results[0].title, "Dotfile Tool");
    assert.ok(results[0].snippet.includes("syncing dotfiles"));
    assert.equal(results[0].meta.author, "Alice");
    assert.equal(results[1].snippet, "");
  } finally {
    restore();
    if (orig !== undefined) process.env.EXA_API_KEY = orig;
    else delete process.env.EXA_API_KEY;
  }
});

test("searchExa throws on non-2xx response", async () => {
  const orig = process.env.EXA_API_KEY;
  process.env.EXA_API_KEY = "test-key";
  const restore = installFetchMock(async () => mockResponse({ status: 429 }));
  try {
    await assert.rejects(() => searchExa("q"), /exa status=429/);
  } finally {
    restore();
    if (orig !== undefined) process.env.EXA_API_KEY = orig;
    else delete process.env.EXA_API_KEY;
  }
});

test("searchExa handles empty results array", async () => {
  const orig = process.env.EXA_API_KEY;
  process.env.EXA_API_KEY = "test-key";
  const restore = installFetchMock(async () => mockResponse({ json: { results: [] } }));
  try {
    const results = await searchExa("obscure query");
    assert.deepEqual(results, []);
  } finally {
    restore();
    if (orig !== undefined) process.env.EXA_API_KEY = orig;
    else delete process.env.EXA_API_KEY;
  }
});
