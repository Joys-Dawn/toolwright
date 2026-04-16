import test from "node:test";
import assert from "node:assert/strict";
import { searchDDG } from "../../lib/novelty/search/ddg.mjs";

const goodHtml = `
<html><body>
<div class="result__body">
  <h2 class="result__title">
    <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage1&amp;rut=abc">Example <b>Page</b> 1</a>
  </h2>
  <a class="result__snippet" href="https://example.com/page1">This is a snippet for page 1 &amp; it has entities</a>
</div>
<div class="result__body">
  <h2 class="result__title">
    <a class="result__a" href="https://example.org/direct">Direct URL</a>
  </h2>
  <a class="result__snippet" href="https://example.org/direct">Another snippet</a>
</div>
</body></html>`;

function mockFetch(responses) {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => responses.shift();
  return () => { globalThis.fetch = orig; };
}

function mkResp({ status = 200, body = "" } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    async text() { return body; }
  };
}

test("searchDDG parses titles/urls/snippets from HTML", async () => {
  const restore = mockFetch([mkResp({ body: goodHtml })]);
  try {
    const rows = await searchDDG("test query");
    assert.equal(rows.length, 2);
    assert.equal(rows[0].source, "ddg");
    assert.equal(rows[0].url, "https://example.com/page1");
    assert.equal(rows[0].title, "Example Page 1");
    assert.match(rows[0].snippet, /snippet for page 1/);
    assert.ok(rows[0].snippet.includes("&") && !rows[0].snippet.includes("&amp;"));
    assert.equal(rows[1].url, "https://example.org/direct");
  } finally { restore(); }
});

test("searchDDG respects limit parameter", async () => {
  const restore = mockFetch([mkResp({ body: goodHtml })]);
  try {
    const rows = await searchDDG("test", { limit: 1 });
    assert.equal(rows.length, 1);
  } finally { restore(); }
});

test("searchDDG returns [] on empty HTML", async () => {
  const restore = mockFetch([mkResp({ body: "" })]);
  try {
    const rows = await searchDDG("test");
    assert.deepEqual(rows, []);
  } finally { restore(); }
});

test("searchDDG throws on non-2xx response", async () => {
  const restore = mockFetch([mkResp({ status: 502 })]);
  try {
    await assert.rejects(() => searchDDG("test"), /ddg status=502/);
  } finally { restore(); }
});

test("searchDDG warns when HTML is non-empty but 0 results parsed", async () => {
  const restore = mockFetch([mkResp({ body: "x".repeat(2000) })]);
  const origWarn = console.warn;
  const warnings = [];
  console.warn = (...a) => warnings.push(a.join(" "));
  try {
    const rows = await searchDDG("test");
    assert.deepEqual(rows, []);
    assert.ok(warnings.some(w => /ddg/.test(w) && /stale|captcha|rate-limit/.test(w)));
  } finally {
    restore();
    console.warn = origWarn;
  }
});

test("searchDDG decodes uddg-redirected URLs", async () => {
  const html = `<div class="result__body"><h2><a href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fencoded.example.com%2Fx%3Fa%3D1">T</a></h2><a class="result__snippet" href="#">s</a></div>`;
  const restore = mockFetch([mkResp({ body: html })]);
  try {
    const rows = await searchDDG("test");
    assert.equal(rows[0].url, "https://encoded.example.com/x?a=1");
  } finally { restore(); }
});
