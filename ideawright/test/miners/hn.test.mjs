import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mine } from '../../lib/miners/hn.mjs';

const SILENT = { warn() {}, info() {}, error() {} };

test('mine config.queries replaces the built-in pain phrases', async (t) => {
  const originalFetch = globalThis.fetch;
  const queriesSeen = [];
  globalThis.fetch = async (url) => {
    const u = new URL(String(url));
    queriesSeen.push(u.searchParams.get('query'));
    return { ok: true, async json() { return { hits: [] }; } };
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  await mine({
    cursors: {},
    config: { queries: ['"my custom phrase"', '"another"'] },
    logger: SILENT,
  });

  assert.deepEqual(queriesSeen, ['"my custom phrase"', '"another"']);
});

test('mine falls back to all 8 built-in queries when config.queries is null', async (t) => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return { ok: true, async json() { return { hits: [] }; } };
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  await mine({ cursors: {}, config: { queries: null }, logger: SILENT });
  assert.equal(calls, 8);
});

test('mine config.max_per_query controls hitsPerPage in the Algolia URL', async (t) => {
  const originalFetch = globalThis.fetch;
  let capturedUrl = '';
  globalThis.fetch = async (url) => {
    capturedUrl = String(url);
    return { ok: true, async json() { return { hits: [] }; } };
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  await mine({
    cursors: {},
    config: { queries: ['"x"'], max_per_query: 25 },
    logger: SILENT,
  });

  assert.match(capturedUrl, /hitsPerPage=25/);
});

test('mine config.lookback_days narrows the since-timestamp', async (t) => {
  const originalFetch = globalThis.fetch;
  let capturedUrl = '';
  globalThis.fetch = async (url) => {
    capturedUrl = String(url);
    return { ok: true, async json() { return { hits: [] }; } };
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  // 1-day lookback → since ≈ now - 86400. Verify the numericFilters value
  // is at least within 60s of the expected floor (test tolerance for clock skew).
  const before = Math.floor(Date.now() / 1000) - 86400;
  await mine({
    cursors: {},
    config: { queries: ['"x"'], lookback_days: 1 },
    logger: SILENT,
  });
  const after = Math.floor(Date.now() / 1000) - 86400;

  const m = capturedUrl.match(/created_at_i%3E(\d+)/);
  assert.ok(m, 'expected created_at_i numeric filter in URL');
  const since = Number(m[1]);
  assert.ok(since >= before - 60 && since <= after + 60, `since=${since} not within ±60s of ${before}..${after}`);
});

test('mine prefers an existing cursor over the lookback floor (cursor wins)', async (t) => {
  const originalFetch = globalThis.fetch;
  let capturedUrl = '';
  globalThis.fetch = async (url) => {
    capturedUrl = String(url);
    return { ok: true, async json() { return { hits: [] }; } };
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const cursorTs = Math.floor(Date.now() / 1000) - 60; // 1 min ago
  await mine({
    cursors: { 'hn:last_ts': cursorTs },
    config: { queries: ['"x"'], lookback_days: 365 }, // would otherwise widen
    logger: SILENT,
  });

  // Math.max picks the more recent of the two — cursorTs (1 min ago) over
  // the 365-day floor.
  assert.match(capturedUrl, new RegExp(`created_at_i%3E${cursorTs}`));
});

test('mine extracts pain-matching observations and updates the cursor', async (t) => {
  const originalFetch = globalThis.fetch;
  const nowTs = Math.floor(Date.now() / 1000);
  globalThis.fetch = async () => ({
    ok: true,
    async json() {
      return {
        hits: [
          {
            objectID: 'hit-1',
            comment_text: 'Honestly I wish there was a CLI for this. Frustrated daily.',
            story_title: 'A story',
            author: 'alice',
            points: 12,
            created_at_i: nowTs - 3600,
          },
          {
            objectID: 'hit-2',
            comment_text: 'No pain phrase here.',
            story_title: 's',
            author: 'bob',
            points: 1,
            created_at_i: nowTs - 7200,
          },
        ],
      };
    },
  });
  t.after(() => { globalThis.fetch = originalFetch; });

  const r = await mine({
    cursors: {},
    config: { queries: ['"i wish there was"'], lookback_days: 30 },
    logger: SILENT,
  });

  assert.equal(r.observations.length, 1);
  assert.equal(r.observations[0].source, 'hn');
  assert.equal(r.observations[0].raw_id, 'hit-1');
  assert.equal(r.cursors['hn:last_ts'], nowTs - 3600);
});
