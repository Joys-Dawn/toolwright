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

test('mine filters out non-matching categories and paper versions > 1', async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    async json() {
      return {
        messages: [{ status: 'ok', count: '4', cursor: '100' }],
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
        messages: [{ status: 'ok', count: '2', cursor: '100' }],
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
  });
  assert.equal(observations.length, 1);
  assert.equal(observations[0].title, 'After cursor');
});
