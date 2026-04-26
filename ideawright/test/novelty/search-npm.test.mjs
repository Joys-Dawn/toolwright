import test from "node:test";
import assert from "node:assert/strict";
import { searchNpm, clipQueryForNpm } from "../../lib/novelty/search/npm.mjs";

function mkResp({ status = 200, json = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    async json() { return json; },
    async text() { return JSON.stringify(json); }
  };
}

function mockFetch(resp) {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => resp;
  return () => { globalThis.fetch = orig; };
}

test("searchNpm maps registry search objects to shape", async () => {
  const restore = mockFetch(mkResp({
    json: {
      objects: [
        {
          package: {
            name: "my-pkg",
            version: "1.2.3",
            description: "A useful thing",
            keywords: ["a", "b"],
            links: { npm: "https://www.npmjs.com/package/my-pkg" }
          }
        }
      ]
    }
  }));
  try {
    const rows = await searchNpm("query");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].source, "npm");
    assert.equal(rows[0].title, "my-pkg");
    assert.equal(rows[0].snippet, "A useful thing");
    assert.equal(rows[0].url, "https://www.npmjs.com/package/my-pkg");
    assert.equal(rows[0].meta.version, "1.2.3");
    assert.deepEqual(rows[0].meta.keywords, ["a", "b"]);
  } finally { restore(); }
});

test("searchNpm falls back to constructed npm URL when links.npm missing", async () => {
  const restore = mockFetch(mkResp({
    json: { objects: [{ package: { name: "no-links", version: "0.1.0" } }] }
  }));
  try {
    const rows = await searchNpm("query");
    assert.equal(rows[0].url, "https://www.npmjs.com/package/no-links");
  } finally { restore(); }
});

test("searchNpm returns [] on empty objects", async () => {
  const restore = mockFetch(mkResp({ json: { objects: [] } }));
  try {
    assert.deepEqual(await searchNpm("query"), []);
  } finally { restore(); }
});

test("searchNpm throws on non-2xx response", async () => {
  const restore = mockFetch(mkResp({ status: 500 }));
  try {
    await assert.rejects(() => searchNpm("query"), /npm status=500/);
  } finally { restore(); }
});

test("searchNpm handles missing description gracefully", async () => {
  const restore = mockFetch(mkResp({
    json: { objects: [{ package: { name: "bare" } }] }
  }));
  try {
    const rows = await searchNpm("query");
    assert.equal(rows[0].snippet, "");
  } finally { restore(); }
});

test("clipQueryForNpm truncates over-length queries at word boundary", () => {
  // 80 chars, several words — must come back <= 64 and end on a word.
  const q = "macos developers using iterm2 or alternative terminal emulators quick access";
  const clipped = clipQueryForNpm(q);
  assert.ok(clipped.length <= 64, `clipped is ${clipped.length} chars`);
  assert.ok(!clipped.endsWith(" "), "trimmed");
  assert.ok(!q.slice(0, 64).slice(clipped.length).match(/\S/) || /\s/.test(q.slice(clipped.length, clipped.length + 1)),
    "cut on a space, not mid-word");
  // Exactly-64-char query passes through unchanged.
  const exact = "a".repeat(64);
  assert.equal(clipQueryForNpm(exact), exact);
  // Short queries pass through.
  assert.equal(clipQueryForNpm("hello world"), "hello world");
  // Below floor → null.
  assert.equal(clipQueryForNpm("a"), null);
  assert.equal(clipQueryForNpm(""), null);
  assert.equal(clipQueryForNpm("   "), null);
});

test("searchNpm sends the clipped (not raw) text to the registry", async () => {
  let capturedUrl = "";
  const orig = globalThis.fetch;
  globalThis.fetch = async (url) => { capturedUrl = String(url); return mkResp({ json: { objects: [] } }); };
  try {
    const longQ = "macos developers using iterm2 or alternative terminal emulators quick access";
    await searchNpm(longQ);
    const sentText = new URL(capturedUrl).searchParams.get("text");
    assert.ok(sentText.length >= 2 && sentText.length <= 64, `sent ${sentText.length} chars: "${sentText}"`);
    assert.ok(longQ.startsWith(sentText), "clipped text is a prefix of the original");
  } finally { globalThis.fetch = orig; }
});

test("searchNpm returns [] without calling fetch for sub-floor queries", async () => {
  let fetched = false;
  const orig = globalThis.fetch;
  globalThis.fetch = async () => { fetched = true; return mkResp({ json: { objects: [] } }); };
  try {
    assert.deepEqual(await searchNpm("a"), []);
    assert.deepEqual(await searchNpm(""), []);
    assert.equal(fetched, false, "no HTTP call for queries below the 2-char floor");
  } finally { globalThis.fetch = orig; }
});

