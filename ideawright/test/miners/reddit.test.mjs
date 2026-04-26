import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mine } from '../../lib/miners/reddit.mjs';

const SILENT = { warn() {}, info() {}, error() {} };

function makePost({ id, created_utc, title = 'I wish there was a tool for X', selftext = '', sub = 'sub' } = {}) {
  return {
    name: `t3_${id}`,
    id,
    title,
    selftext,
    permalink: `/r/${sub}/comments/${id}/x/`,
    author: `user${id}`,
    ups: 5,
    num_comments: 3,
    score: 5,
    created_utc,
  };
}

function listingResponse(posts, after = null) {
  return {
    ok: true,
    async json() {
      return {
        data: {
          dist: posts.length,
          after,
          children: posts.map((data) => ({ kind: 't3', data })),
        },
      };
    },
  };
}

test('mine cold-start uses /new by default when seed_listings is unset', async (t) => {
  const originalFetch = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    return listingResponse([makePost({ id: 'a', created_utc: Date.now() / 1000 })]);
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  await mine({
    cursors: {},
    config: { subreddits: ['testsub'], max_pages: 1 },
    logger: SILENT,
  });

  assert.equal(urls.length, 1);
  assert.match(urls[0], /\/r\/testsub\/new\.json/);
});

test('mine cold-start hits each listing in seed_listings and dedupes posts by id', async (t) => {
  const originalFetch = globalThis.fetch;
  const urls = [];
  const sharedPost = makePost({ id: 'shared', created_utc: 1700000000, title: 'I wish there was a CLI' });
  const newOnly = makePost({ id: 'newonly', created_utc: 1700001000, title: 'someone should build X' });
  const topOnly = makePost({ id: 'toponly', created_utc: 1600000000, title: 'why is there no Y' });

  globalThis.fetch = async (url) => {
    urls.push(String(url));
    if (url.includes('/new.json')) return listingResponse([sharedPost, newOnly]);
    if (url.includes('/top.json')) return listingResponse([sharedPost, topOnly]);
    throw new Error(`unexpected url: ${url}`);
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const { observations } = await mine({
    cursors: {},
    config: {
      subreddits: ['s'],
      max_pages: 1,
      seed_listings: ['new', 'top:all'],
    },
    logger: SILENT,
  });

  // Both endpoints hit
  assert.equal(urls.length, 2);
  assert.ok(urls.some((u) => u.includes('/new.json')));
  assert.ok(urls.some((u) => u.includes('/top.json')));
  assert.ok(urls.some((u) => u.includes('t=all')));

  // 3 unique posts → 3 observations (all match pain regex), shared post not double-counted
  assert.equal(observations.length, 3);
  const ids = observations.map((o) => o.raw_id).sort();
  assert.deepEqual(ids, ['t3_newonly', 't3_shared', 't3_toponly']);
});

test('mine incremental mode only hits /new with before= cursor', async (t) => {
  const originalFetch = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    return listingResponse([]);
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  await mine({
    cursors: { 'reddit:s': 't3_lastseen' },
    config: {
      subreddits: ['s'],
      seed_listings: ['new', 'top:all', 'controversial:all'], // ignored when cursor set
    },
    logger: SILENT,
  });

  // Only one fetch — incremental skips seed_listings entirely.
  assert.equal(urls.length, 1);
  assert.match(urls[0], /before=t3_lastseen/);
  assert.match(urls[0], /\/new\.json/);
});

test('mine cursor is set to the newest post by created_utc (not first-seen)', async (t) => {
  const originalFetch = globalThis.fetch;
  // /top returns highest-scored first, NOT date-sorted — the score-sorted post
  // happens to be older. The cursor must end up pointing at the newer post,
  // not the first-iterated one.
  const old_high_score = makePost({ id: 'oldhi', created_utc: 1600000000, title: 'I wish' });
  const new_low_score = makePost({ id: 'newlow', created_utc: 1700000000, title: 'I wish' });

  globalThis.fetch = async () => listingResponse([old_high_score, new_low_score]);
  t.after(() => { globalThis.fetch = originalFetch; });

  const { cursors } = await mine({
    cursors: {},
    config: { subreddits: ['s'], seed_listings: ['top:all'] },
    logger: SILENT,
  });

  assert.equal(cursors['reddit:s'], 't3_newlow', 'cursor should track newest by date, not first-seen');
});

test('mine drops malformed listing specs and falls back to /new', async (t) => {
  const originalFetch = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    return listingResponse([]);
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  await mine({
    cursors: {},
    config: {
      subreddits: ['s'],
      seed_listings: ['bogus_listing', 'top:nonsense_window', '', 42],
    },
    logger: SILENT,
  });

  // All specs invalid → fall back to default ['new'] → one fetch on /new.
  assert.equal(urls.length, 1);
  assert.match(urls[0], /\/new\.json/);
});

test('mine top: defaults to t=all when no time filter given', async (t) => {
  const originalFetch = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    return listingResponse([]);
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  await mine({
    cursors: {},
    config: { subreddits: ['s'], seed_listings: ['top'] },
    logger: SILENT,
  });

  assert.equal(urls.length, 1);
  assert.match(urls[0], /\/top\.json/);
  assert.match(urls[0], /t=all/);
});

test('mine pain-regex filter excludes posts without a pain phrase', async (t) => {
  const originalFetch = globalThis.fetch;
  const matches = makePost({ id: 'a', created_utc: 1700000000, title: 'I wish there was a CLI' });
  const noMatch = makePost({ id: 'b', created_utc: 1700001000, title: 'Just shipped my new app!' });

  globalThis.fetch = async () => listingResponse([matches, noMatch]);
  t.after(() => { globalThis.fetch = originalFetch; });

  const { observations } = await mine({
    cursors: {},
    config: { subreddits: ['s'] },
    logger: SILENT,
  });

  assert.equal(observations.length, 1);
  assert.equal(observations[0].raw_id, 't3_a');
});

test('mine cursor tracks newest even when date-newest sits past max_posts_per_sub cap (regression for cap+newest interaction)', async (t) => {
  const originalFetch = globalThis.fetch;
  // /top:all returns score-sorted, not date-sorted. The genuinely newest
  // post by created_utc is at index 4 (last). With max_posts_per_sub=2 the
  // old code would break out of the loop before reaching it and set the
  // cursor to a non-newest post.
  const posts = [
    makePost({ id: 'top1', created_utc: 1500000000, title: 'I wish there was a tool for A' }),
    makePost({ id: 'top2', created_utc: 1510000000, title: 'I wish there was a tool for B' }),
    makePost({ id: 'top3', created_utc: 1520000000, title: 'I wish there was a tool for C' }),
    makePost({ id: 'top4', created_utc: 1530000000, title: 'I wish there was a tool for D' }),
    makePost({ id: 'newest', created_utc: 1700000000, title: 'I wish there was a tool for E' }),
  ];
  globalThis.fetch = async () => listingResponse(posts);
  t.after(() => { globalThis.fetch = originalFetch; });

  const { cursors, observations } = await mine({
    cursors: {},
    config: {
      subreddits: ['s'],
      seed_listings: ['top:all'],
      max_posts_per_sub: 2,
    },
    logger: SILENT,
  });

  // Cap applies to observation emission (we keep only the first 2 posts'
  // observations) but newest tracking sees ALL posts.
  assert.equal(observations.length, 2, 'cap limits emitted observations');
  assert.equal(cursors['reddit:s'], 't3_newest', 'cursor must reflect the date-newest across ALL posts, not just within the cap');
});

test('mine continues to next listing when one listing throws (partial success preserved)', async (t) => {
  const originalFetch = globalThis.fetch;
  const okPost = makePost({ id: 'ok1', created_utc: 1700000000, title: 'I wish there was a tool for X' });
  globalThis.fetch = async (url) => {
    if (url.includes('/new.json')) return listingResponse([okPost]);
    if (url.includes('/top.json')) return { ok: false, status: 500, async json() { return {}; } };
    if (url.includes('/controversial.json')) return listingResponse([
      makePost({ id: 'ok2', created_utc: 1700001000, title: 'I wish there was a tool for Y' }),
    ]);
    throw new Error(`unexpected url: ${url}`);
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const { observations } = await mine({
    cursors: {},
    config: {
      subreddits: ['s'],
      seed_listings: ['new', 'top:all', 'controversial:all'],
    },
    logger: SILENT,
  });

  // The /top failure should NOT discard /new + /controversial results.
  assert.equal(observations.length, 2);
  const ids = observations.map((o) => o.raw_id).sort();
  assert.deepEqual(ids, ['t3_ok1', 't3_ok2']);
});

test('mine rejects time filter on /new and /hot (Reddit ignores it anyway)', async (t) => {
  const originalFetch = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    return listingResponse([]);
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  await mine({
    cursors: {},
    config: {
      subreddits: ['s'],
      seed_listings: ['new:all', 'hot:week', 'top:all'], // first two should be rejected
    },
    logger: SILENT,
  });

  // Only top:all is valid → exactly one fetch.
  assert.equal(urls.length, 1);
  assert.match(urls[0], /\/top\.json/);
});

test('parseListing rejects specs with extra colons', async (t) => {
  const originalFetch = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    return listingResponse([]);
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  await mine({
    cursors: {},
    config: {
      subreddits: ['s'],
      seed_listings: ['top:all:bogus'], // extra colon, must be rejected
    },
    logger: SILENT,
  });

  // 'top:all:bogus' rejected → no valid seed listings → fall back to ['new'].
  assert.equal(urls.length, 1);
  assert.match(urls[0], /\/new\.json/);
});

test('mine handles per-sub failure without crashing the run', async (t) => {
  const originalFetch = globalThis.fetch;
  const warnings = [];
  let call = 0;
  globalThis.fetch = async () => {
    call++;
    if (call === 1) return { ok: false, status: 500, async json() { return {}; } };
    return listingResponse([]);
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const { observations } = await mine({
    cursors: {},
    config: { subreddits: ['failing', 'ok'] },
    logger: { ...SILENT, warn(m) { warnings.push(m); } },
  });

  assert.ok(warnings.some((w) => w.includes('failing')));
  assert.equal(observations.length, 0);
});
