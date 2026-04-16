import test from "node:test";
import assert from "node:assert/strict";
import { searchHN } from "../../lib/novelty/search/hn.mjs";

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

test("searchHN maps Algolia hits with explicit URL", async () => {
  const restore = mockFetch(mkResp({
    json: {
      hits: [
        { objectID: "42", title: "Show HN: foo", url: "https://foo.dev", points: 100, num_comments: 25, created_at: "2024-03-01" }
      ]
    }
  }));
  try {
    const rows = await searchHN("q");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].source, "hn");
    assert.equal(rows[0].url, "https://foo.dev");
    assert.equal(rows[0].title, "Show HN: foo");
    assert.match(rows[0].snippet, /100 points/);
    assert.match(rows[0].snippet, /25 comments/);
    assert.equal(rows[0].meta.points, 100);
  } finally { restore(); }
});

test("searchHN falls back to HN item URL when hit has no url", async () => {
  const restore = mockFetch(mkResp({
    json: { hits: [{ objectID: "7", title: "t", points: 1, num_comments: 0 }] }
  }));
  try {
    const rows = await searchHN("q");
    assert.equal(rows[0].url, "https://news.ycombinator.com/item?id=7");
  } finally { restore(); }
});

test("searchHN uses story_title when title missing", async () => {
  const restore = mockFetch(mkResp({
    json: { hits: [{ objectID: "9", story_title: "parent story", url: "https://x.test", points: 0, num_comments: 0 }] }
  }));
  try {
    const rows = await searchHN("q");
    assert.equal(rows[0].title, "parent story");
  } finally { restore(); }
});

test("searchHN returns [] on empty hits", async () => {
  const restore = mockFetch(mkResp({ json: { hits: [] } }));
  try {
    assert.deepEqual(await searchHN("q"), []);
  } finally { restore(); }
});

test("searchHN throws on non-2xx response", async () => {
  const restore = mockFetch(mkResp({ status: 503 }));
  try {
    await assert.rejects(() => searchHN("q"), /hn status=503/);
  } finally { restore(); }
});
