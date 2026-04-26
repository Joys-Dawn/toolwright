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
