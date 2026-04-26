import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mine } from '../../lib/miners/github.mjs';

const SILENT = { warn() {}, info() {}, error() {} };

function makeIssue(id, daysAgo = 1, overrides = {}) {
  const updated = new Date(Date.now() - daysAgo * 86400_000).toISOString();
  return {
    id,
    html_url: `https://github.com/x/y/issues/${id}`,
    title: `Issue ${id}`,
    body: 'A wish-this-existed issue.',
    user: { login: `user${id}` },
    comments: 5,
    reactions: { '+1': 3, heart: 1 },
    state: 'closed',
    state_reason: 'not_planned',
    labels: ['help wanted'],
    created_at: updated,
    updated_at: updated,
    ...overrides,
  };
}

test('mine config.queries replaces the built-in query list', async (t) => {
  const originalFetch = globalThis.fetch;
  const queriesSeen = [];
  globalThis.fetch = async (url) => {
    const u = new URL(String(url));
    queriesSeen.push(u.searchParams.get('q'));
    return { ok: true, async json() { return { items: [] }; } };
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  await mine({
    cursors: {},
    config: { queries: ['custom-query-A', 'custom-query-B'] },
    logger: SILENT,
  });

  assert.deepEqual(queriesSeen, ['custom-query-A', 'custom-query-B']);
});

test('mine falls back to the 3 built-in queries when config.queries is null', async (t) => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return { ok: true, async json() { return { items: [] }; } };
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  await mine({ cursors: {}, config: { queries: null }, logger: SILENT });
  assert.equal(calls, 3);
});

test('mine config.lookback_days narrows the initial since-cursor', async (t) => {
  const originalFetch = globalThis.fetch;
  const tenDaysAgo = makeIssue(1, 10);
  globalThis.fetch = async () => ({
    ok: true,
    async json() { return { items: [tenDaysAgo] }; },
  });
  t.after(() => { globalThis.fetch = originalFetch; });

  // 1-day lookback → 10-day-old issue is older than the cursor floor → dropped.
  const r1 = await mine({
    cursors: {},
    config: { queries: ['q'], lookback_days: 1 },
    logger: SILENT,
  });
  assert.equal(r1.observations.length, 0);

  // 30-day lookback → same issue is now inside the window → kept.
  const r2 = await mine({
    cursors: {},
    config: { queries: ['q'], lookback_days: 30 },
    logger: SILENT,
  });
  assert.equal(r2.observations.length, 1);
});

test('mine config.max_per_query controls the per_page param sent to GitHub', async (t) => {
  const originalFetch = globalThis.fetch;
  let capturedUrl = '';
  globalThis.fetch = async (url) => {
    capturedUrl = String(url);
    return { ok: true, async json() { return { items: [] }; } };
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  await mine({
    cursors: {},
    config: { queries: ['q'], max_per_query: 17 },
    logger: SILENT,
  });

  assert.match(capturedUrl, /per_page=17/);
});

test('mine emits observations with engagement aggregated across reactions', async (t) => {
  const originalFetch = globalThis.fetch;
  const issue = makeIssue(42, 1, {
    reactions: { '+1': 2, '-1': 1, heart: 4, hooray: 0, total_count: 'ignored-string' },
  });
  globalThis.fetch = async () => ({
    ok: true,
    async json() { return { items: [issue] }; },
  });
  t.after(() => { globalThis.fetch = originalFetch; });

  const { observations } = await mine({
    cursors: {},
    config: { queries: ['q'], lookback_days: 30 },
    logger: SILENT,
  });

  assert.equal(observations.length, 1);
  // Numeric values summed (2 + 1 + 4 + 0); string 'ignored-string' skipped.
  assert.equal(observations[0].engagement.reactions, 7);
  assert.equal(observations[0].source, 'github');
});

test('mine handles per-query failure without crashing the run', async (t) => {
  const originalFetch = globalThis.fetch;
  const warnings = [];
  let call = 0;
  globalThis.fetch = async () => {
    call++;
    if (call === 1) return { ok: false, status: 500, async json() { return {}; } };
    return { ok: true, async json() { return { items: [] }; } };
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const r = await mine({
    cursors: {},
    config: { queries: ['q1', 'q2'] },
    logger: { ...SILENT, warn(m) { warnings.push(m); } },
  });

  assert.ok(warnings.some((w) => w.includes('q1')), 'should warn about the failing query');
  assert.equal(r.observations.length, 0);
});
