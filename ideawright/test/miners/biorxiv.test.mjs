import { test } from 'node:test';
import assert from 'node:assert/strict';
import { categoryMatches, mine } from '../../lib/miners/biorxiv.mjs';

test('categoryMatches is case-insensitive exact match', () => {
  assert.ok(categoryMatches('Bioinformatics', ['bioinformatics']));
  assert.ok(categoryMatches('BIOINFORMATICS', ['bioinformatics']));
});

test('categoryMatches is a substring search, not strict equality', () => {
  assert.ok(categoryMatches('Systems Biology', ['systems biology']));
  assert.ok(categoryMatches('Synthetic Biology and Engineering', ['synthetic biology']));
});

test('categoryMatches rejects non-matching categories', () => {
  assert.ok(!categoryMatches('Microbiology', ['bioinformatics', 'synthetic biology']));
  assert.ok(!categoryMatches(null, ['bioinformatics']));
  assert.ok(!categoryMatches('', ['bioinformatics']));
});

// Pin the clock so date-based filters use a fixed `today` regardless of when the suite runs.
// Fixture paper dates (2026-04-10/11) must fall within `today − lookbackDays`.
const FIXED_NOW = () => new Date('2026-04-12T00:00:00Z');

test('mine filters out non-matching categories and paper versions > 1', async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    async json() {
      return {
        messages: [{ status: 'ok', count: 4, total: 4, cursor: 0 }],
        collection: [
          { doi: '10.1/aaa', title: 'Keep me', abstract: 'Good', authors: 'Alice Smith', date: '2026-04-10', category: 'bioinformatics', version: '1', type: 'new' },
          { doi: '10.1/bbb', title: 'Wrong category', abstract: 'x', authors: 'x', date: '2026-04-10', category: 'microbiology', version: '1', type: 'new' },
          { doi: '10.1/ccc', title: 'Revision drop', abstract: 'x', authors: 'x', date: '2026-04-10', category: 'bioinformatics', version: '2', type: 'new' },
          { doi: '10.1/ddd', title: 'Also keep', abstract: 'Also good', authors: 'Bob', date: '2026-04-11', category: 'Synthetic Biology', version: '1', type: 'new' },
        ],
      };
    },
  });
  t.after(() => { globalThis.fetch = originalFetch; });

  const { observations } = await mine({
    cursors: {},
    config: { categories: ['bioinformatics', 'synthetic biology'] },
    logger: { warn() {}, info() {}, error() {} },
    now: FIXED_NOW,
  });

  const titles = observations.map((o) => o.title).sort();
  assert.deepEqual(titles, ['Also keep', 'Keep me']);
  for (const o of observations) {
    assert.equal(o.source, 'biorxiv');
    assert.ok(o.source_url.startsWith('https://www.biorxiv.org/content/10.1/'));
    assert.ok(o.raw_id.startsWith('biorxiv:'));
  }
});

test('mine respects the since-date cursor', async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    async json() {
      return {
        messages: [{ status: 'ok', count: 2, total: 2, cursor: 0 }],
        collection: [
          { doi: '10.1/new', title: 'After cursor', abstract: 'x', authors: 'A', date: '2026-04-11', category: 'bioinformatics', version: '1' },
          { doi: '10.1/old', title: 'Before cursor', abstract: 'x', authors: 'A', date: '2026-04-01', category: 'bioinformatics', version: '1' },
        ],
      };
    },
  });
  t.after(() => { globalThis.fetch = originalFetch; });

  const { observations } = await mine({
    cursors: { 'biorxiv:last_doi_date': '2026-04-10' },
    config: { categories: ['bioinformatics'] },
    logger: { warn() {}, info() {}, error() {} },
    now: FIXED_NOW,
  });
  assert.equal(observations.length, 1);
  assert.equal(observations[0].title, 'After cursor');
});

test('mine config.lookback_days widens the from→to window', async (t) => {
  const originalFetch = globalThis.fetch;
  let capturedUrl = '';
  globalThis.fetch = async (url) => {
    capturedUrl = String(url);
    return {
      ok: true,
      async json() {
        return { messages: [{ status: 'ok', count: 0, total: 0, cursor: 0 }], collection: [] };
      },
    };
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  await mine({
    cursors: {},
    config: { categories: ['bioinformatics'], lookback_days: 90 },
    logger: { warn() {}, info() {}, error() {} },
    now: () => new Date('2026-04-12T00:00:00Z'),
  });

  // 90 days before 2026-04-12 → 2026-01-12. Should appear in URL path.
  assert.match(capturedUrl, /\/2026-01-12\/2026-04-12\//);
});

test('mine config.max_per_run caps how many papers get fetched', async (t) => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return {
      ok: true,
      async json() {
        // Each page returns 5 papers and reports total=999 so the loop would
        // otherwise keep paginating forever.
        const papers = Array.from({ length: 5 }, (_, i) => ({
          doi: `10.1/p${calls}-${i}`,
          title: `t${calls}-${i}`,
          abstract: 'x',
          authors: 'A',
          date: '2026-04-11',
          category: 'bioinformatics',
          version: '1',
        }));
        return {
          messages: [{ status: 'ok', count: 5, total: 999, cursor: 0 }],
          collection: papers,
        };
      },
    };
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  await mine({
    cursors: {},
    config: { categories: ['bioinformatics'], max_per_run: 7 },
    logger: { warn() {}, info() {}, error() {} },
    now: FIXED_NOW,
  });

  // After page 1 (5 fetched), second iteration starts (5 < 7), fetches 5 more
  // (total 10 fetched), loop terminates because 10 >= 7. So exactly 2 fetches.
  assert.equal(calls, 2);
});

test('mine paginates until pageCursor >= window total', async (t) => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    const m = String(url).match(/\/(\d+)$/);
    const cursor = m ? Number(m[1]) : 0;
    calls.push(cursor);
    const pages = {
      0: [
        { doi: '10.1/p0a', title: 'p0a', abstract: '', authors: 'A', date: '2026-04-11', category: 'bioinformatics', version: '1' },
        { doi: '10.1/p0b', title: 'p0b', abstract: '', authors: 'A', date: '2026-04-11', category: 'bioinformatics', version: '1' },
      ],
      2: [
        { doi: '10.1/p2a', title: 'p2a', abstract: '', authors: 'A', date: '2026-04-11', category: 'bioinformatics', version: '1' },
      ],
    };
    return {
      ok: true,
      async json() {
        return {
          messages: [{ status: 'ok', count: pages[cursor]?.length ?? 0, total: 3, cursor }],
          collection: pages[cursor] ?? [],
        };
      },
    };
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const { observations } = await mine({
    cursors: {},
    config: { categories: ['bioinformatics'] },
    logger: { warn() {}, info() {}, error() {} },
    now: FIXED_NOW,
  });
  assert.deepEqual(calls, [0, 2], 'cursor advances by page length, not echoed value');
  assert.equal(observations.length, 3, 'all three papers across both pages are kept');
});

// --- Regression: the permanent cursor trap (date-watermark vs offset API) ---
// bioRxiv's /details feed is offset-paginated and strictly date-ascending.
// The cursor must anchor the window's `from` bound. If it is instead only a
// client-side skip filter over a full `today − lookback` re-page (the old
// bug), every run re-pages thousands of older records from offset 0 and
// bioRxiv 503s before the first emittable one, so the cursor never advances
// and obs is 0 forever. These tests pin the fixed behavior.

test('a cursor anchors the API window `from` at the cursor date, not today−lookback', async (t) => {
  const originalFetch = globalThis.fetch;
  let capturedUrl = '';
  globalThis.fetch = async (url) => {
    capturedUrl = String(url);
    return {
      ok: true,
      async json() {
        return { messages: [{ status: 'ok', count: 0, total: 0, cursor: 0 }], collection: [] };
      },
    };
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  await mine({
    cursors: { 'biorxiv:last_doi_date': '2026-04-08' },
    config: { categories: ['bioinformatics'], lookback_days: 90 },
    logger: { warn() {}, info() {}, error() {} },
    now: FIXED_NOW,
  });

  // lookback_days 90 before 2026-04-12 is 2026-01-12. The pre-existing cursor
  // is 2026-04-08. The window must start at the cursor, NOT 2026-01-12 — that
  // is the whole fix: no 90-day re-page from offset 0.
  assert.match(capturedUrl, /\/2026-04-08\/2026-04-12\//);
  assert.doesNotMatch(capturedUrl, /\/2026-01-12\//);
});

test('with a cursor, offset-0 papers are emittable and the cursor advances forward', async (t) => {
  const originalFetch = globalThis.fetch;
  let capturedFrom = '';
  globalThis.fetch = async (url) => {
    capturedFrom = String(url).match(/\/details\/biorxiv\/([\d-]+)\//)?.[1] ?? '';
    return {
      ok: true,
      async json() {
        return {
          messages: [{ status: 'ok', count: 1, total: 1, cursor: 0 }],
          collection: [
            { doi: '10.1/fresh', title: 'Fresh after cursor', abstract: 'x', authors: 'A', date: '2026-04-10', category: 'bioinformatics', version: '1' },
          ],
        };
      },
    };
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const { observations, cursors } = await mine({
    cursors: { 'biorxiv:last_doi_date': '2026-04-09' },
    config: { categories: ['bioinformatics'] },
    logger: { warn() {}, info() {}, error() {} },
    now: FIXED_NOW,
  });

  assert.equal(capturedFrom, '2026-04-09', 'window starts at the cursor');
  assert.equal(observations.length, 1, 'reaches emittable papers immediately — not trapped at obs=0');
  assert.equal(cursors['biorxiv:last_doi_date'], '2026-04-10', 'cursor advances to the newest fetched date');
});

test('a 503 mid-pagination still banks the newest fetched date (no permanent trap)', async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const cursor = Number(String(url).match(/\/(\d+)$/)?.[1] ?? 0);
    if (cursor === 0) {
      return {
        ok: true,
        async json() {
          return {
            messages: [{ status: 'ok', count: 2, total: 999, cursor: 0 }],
            collection: [
              { doi: '10.1/p1', title: 'p1', abstract: 'x', authors: 'A', date: '2026-04-02', category: 'bioinformatics', version: '1' },
              { doi: '10.1/p2', title: 'p2', abstract: 'x', authors: 'A', date: '2026-04-03', category: 'bioinformatics', version: '1' },
            ],
          };
        },
      };
    }
    return { ok: false, status: 503, async json() { return {}; } };
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const { observations, cursors } = await mine({
    cursors: { 'biorxiv:last_doi_date': '2026-04-01' },
    config: { categories: ['bioinformatics'] },
    logger: { warn() {}, info() {}, error() {} },
    now: FIXED_NOW,
  });

  assert.equal(observations.length, 2, 'papers fetched before the 503 are kept');
  assert.equal(
    cursors['biorxiv:last_doi_date'],
    '2026-04-03',
    'cursor advances past the pre-existing watermark despite the 503 — next run resumes forward',
  );
});
