import test from "node:test";
import assert from "node:assert/strict";
import { searchNpm } from "../../lib/novelty/search/npm.mjs";

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
    const rows = await searchNpm("q");
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
    const rows = await searchNpm("q");
    assert.equal(rows[0].url, "https://www.npmjs.com/package/no-links");
  } finally { restore(); }
});

test("searchNpm returns [] on empty objects", async () => {
  const restore = mockFetch(mkResp({ json: { objects: [] } }));
  try {
    assert.deepEqual(await searchNpm("q"), []);
  } finally { restore(); }
});

test("searchNpm throws on non-2xx response", async () => {
  const restore = mockFetch(mkResp({ status: 500 }));
  try {
    await assert.rejects(() => searchNpm("q"), /npm status=500/);
  } finally { restore(); }
});

test("searchNpm handles missing description gracefully", async () => {
  const restore = mockFetch(mkResp({
    json: { objects: [{ package: { name: "bare" } }] }
  }));
  try {
    const rows = await searchNpm("q");
    assert.equal(rows[0].snippet, "");
  } finally { restore(); }
});
