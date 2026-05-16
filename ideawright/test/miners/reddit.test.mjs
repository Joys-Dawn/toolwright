import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mine, parseRetryAfter, parseResetSeconds, rateLimitWaitMs } from '../../lib/miners/reddit.mjs';

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

// -- Rate-limit handling -----------------------------------------------------

// Response carrying a status + headers (existing listingResponse has neither).
function headerResponse({ status = 200, headers = {}, posts = [], after = null } = {}) {
  const lower = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = String(v);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => (k.toLowerCase() in lower ? lower[k.toLowerCase()] : null) },
    async json() {
      return { data: { dist: posts.length, after, children: posts.map((d) => ({ kind: 't3', data: d })) } };
    },
  };
}

function sleepSpy() {
  const calls = [];
  const fn = async (ms) => { calls.push(ms); };
  fn.calls = calls;
  return fn;
}

test('429 with Retry-After then 200: retries, succeeds, cursor saved, waits Retry-After', async (t) => {
  const originalFetch = globalThis.fetch;
  let call = 0;
  globalThis.fetch = async () => {
    call++;
    if (call === 1) return headerResponse({ status: 429, headers: { 'Retry-After': '5' } });
    return headerResponse({ posts: [makePost({ id: 'a', created_utc: 1700000000 })] });
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const spy = sleepSpy();

  const { observations, cursors } = await mine({
    cursors: {},
    config: { subreddits: ['s'], max_pages: 1 },
    logger: SILENT,
    _sleep: spy,
  });

  assert.equal(call, 2, 'one 429 then one 200');
  assert.equal(observations.length, 1);
  assert.equal(cursors['reddit:s'], 't3_a', 'cursor saved on eventual success');
  assert.ok(spy.calls.includes(5000), 'waited the Retry-After (5s) before retry');
});

test('429 with x-ratelimit-reset (no Retry-After) then 200: waits reset seconds', async (t) => {
  const originalFetch = globalThis.fetch;
  let call = 0;
  globalThis.fetch = async () => {
    call++;
    if (call === 1) return headerResponse({ status: 429, headers: { 'x-ratelimit-reset': '7' } });
    return headerResponse({ posts: [makePost({ id: 'b', created_utc: 1700000000 })] });
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const spy = sleepSpy();

  const { observations } = await mine({
    cursors: {},
    config: { subreddits: ['s'], max_pages: 1 },
    logger: SILENT,
    _sleep: spy,
  });

  assert.equal(call, 2);
  assert.equal(observations.length, 1);
  assert.ok(spy.calls.includes(7000), 'fell back to x-ratelimit-reset (7s) when no Retry-After');
});

test('persistent 429 past maxRetries: throws, caught per-listing, other listings still run', async (t) => {
  const originalFetch = globalThis.fetch;
  const warnings = [];
  globalThis.fetch = async (url) => {
    if (url.includes('/new.json')) return headerResponse({ status: 429, headers: { 'Retry-After': '1' } });
    if (url.includes('/top.json')) return headerResponse({ posts: [makePost({ id: 'ok', created_utc: 1700000000 })] });
    throw new Error(`unexpected url: ${url}`);
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const { observations } = await mine({
    cursors: {},
    config: {
      subreddits: ['s'],
      max_pages: 1,
      seed_listings: ['new', 'top:all'],
      rate_limit: { maxRetries: 2 },
    },
    logger: { ...SILENT, warn: (m) => warnings.push(m) },
    _sleep: sleepSpy(),
  });

  assert.ok(warnings.some((w) => w.includes('s/new') && w.includes('HTTP 429')),
    'exhausted /new listing logged as failed');
  assert.equal(observations.length, 1, '/top still harvested — partial success preserved');
  assert.equal(observations[0].raw_id, 't3_ok');
});

test('proactive throttle: low x-ratelimit-remaining triggers a pre-emptive sleep before next page', async (t) => {
  const originalFetch = globalThis.fetch;
  let call = 0;
  globalThis.fetch = async () => {
    call++;
    if (call === 1) {
      // page 0: success but budget almost gone, and there IS a next page (after set)
      return headerResponse({
        posts: [makePost({ id: 'p1', created_utc: 1700000000 })],
        after: 't3_p1',
        headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '3' },
      });
    }
    return headerResponse({ posts: [] }); // page 1: empty, ends pagination
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const spy = sleepSpy();

  await mine({
    cursors: {},
    config: { subreddits: ['s'], max_pages: 2, seed_listings: ['new'] },
    logger: SILENT,
    _sleep: spy,
  });

  assert.equal(call, 2, 'paginated to page 1');
  assert.ok(spy.calls.includes(3000), 'pre-emptively slept until reset because remaining<=threshold');
});

test('non-429 (HTTP 500) is a single throw, never retried', async (t) => {
  const originalFetch = globalThis.fetch;
  let call = 0;
  const warnings = [];
  globalThis.fetch = async () => { call++; return headerResponse({ status: 500 }); };
  t.after(() => { globalThis.fetch = originalFetch; });

  const { observations } = await mine({
    cursors: {},
    config: { subreddits: ['s'], max_pages: 1, seed_listings: ['new'], rate_limit: { maxRetries: 5 } },
    logger: { ...SILENT, warn: (m) => warnings.push(m) },
    _sleep: sleepSpy(),
  });

  assert.equal(call, 1, '500 must NOT be retried even with maxRetries=5');
  assert.equal(observations.length, 0);
  assert.ok(warnings.some((w) => w.includes('HTTP 500')));
});

// -- Exported pure helpers: direct unit tests --------------------------------
// rateLimitWaitMs / parseRetryAfter / parseResetSeconds are exported precisely
// to be unit-testable. The integration tests above only hit their numeric /
// header-present branches; these pin the fallback, clamp, ceil-rounding and
// unparseable-input branches a regression would otherwise slip past green.

test('parseRetryAfter: numeric delta-seconds → milliseconds', () => {
  assert.equal(parseRetryAfter('120'), 120_000);
});

test('parseRetryAfter: future HTTP-date → remaining milliseconds', () => {
  // parseRetryAfter reads Date.now() internally and the source has no clock
  // seam (not modifiable here), so assert a wide band: a 10-min offset with a
  // [590s, 600s] window dwarfs execution jitter + the ~1s truncation from
  // toUTCString(), keeping this deterministic (never flaky).
  const future = new Date(Date.now() + 600_000).toUTCString();

  const ms = parseRetryAfter(future);

  assert.ok(ms > 590_000 && ms <= 600_000, `expected ~600000ms, got ${ms}`);
});

test('parseRetryAfter: past HTTP-date → 0 (never negative)', () => {
  const past = new Date(Date.now() - 100_000).toUTCString();

  assert.equal(parseRetryAfter(past), 0);
});

test('parseRetryAfter: unparseable string and null → null', () => {
  assert.equal(parseRetryAfter('soon'), null);
  assert.equal(parseRetryAfter(null), null);
});

test('parseResetSeconds: fractional seconds round UP to whole-second ms', () => {
  // Math.ceil is deliberate (safe-side: never wait short of the reset window).
  // floor or round would yield 311000 and silently re-fire into an exhausted
  // budget window — this is the regression guard for that.
  assert.equal(parseResetSeconds('311.4'), 312_000);
  assert.equal(parseResetSeconds('7'), 7_000);
});

test('parseResetSeconds: negative, non-numeric, and null → null', () => {
  assert.equal(parseResetSeconds('-5'), null);
  assert.equal(parseResetSeconds('abc'), null);
  assert.equal(parseResetSeconds(null), null);
});

test('rateLimitWaitMs: no rate-limit headers → cfg.fallbackMs', () => {
  const cfg = { fallbackMs: 60_000, maxBackoffMs: 900_000 };

  const wait = rateLimitWaitMs(headerResponse({ status: 429 }), cfg);

  assert.equal(wait, 60_000);
});

test('rateLimitWaitMs: wait larger than cfg.maxBackoffMs is clamped', () => {
  const cfg = { fallbackMs: 60_000, maxBackoffMs: 900_000 };
  const res = headerResponse({ status: 429, headers: { 'Retry-After': '99999' } });

  assert.equal(rateLimitWaitMs(res, cfg), 900_000);
});

test('rateLimitWaitMs: a negative configured wait is floored at 0', () => {
  const cfg = { fallbackMs: -5_000, maxBackoffMs: 900_000 };

  const wait = rateLimitWaitMs(headerResponse({ status: 429 }), cfg);

  assert.equal(wait, 0);
});

test('rateLimitWaitMs: Retry-After takes precedence over x-ratelimit-reset', () => {
  const cfg = { fallbackMs: 60_000, maxBackoffMs: 900_000 };
  const res = headerResponse({
    status: 429,
    headers: { 'Retry-After': '5', 'x-ratelimit-reset': '999' },
  });

  assert.equal(rateLimitWaitMs(res, cfg), 5_000);
});

// -- 503 parity with 429 (Requirement 1 covers "429 and 503") ----------------

test('503 with Retry-After then 200: retries and succeeds (treated like 429)', async (t) => {
  const originalFetch = globalThis.fetch;
  let call = 0;
  globalThis.fetch = async () => {
    call++;
    if (call === 1) return headerResponse({ status: 503, headers: { 'Retry-After': '4' } });
    return headerResponse({ posts: [makePost({ id: 's503', created_utc: 1700000000 })] });
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const spy = sleepSpy();

  const { observations, cursors } = await mine({
    cursors: {},
    config: { subreddits: ['s'], max_pages: 1 },
    logger: SILENT,
    _sleep: spy,
  });

  assert.equal(call, 2, 'one 503 then one 200');
  assert.equal(observations.length, 1);
  assert.equal(cursors['reddit:s'], 't3_s503', 'cursor saved on eventual success');
  assert.ok(spy.calls.includes(4000), 'waited the Retry-After (4s) before retrying the 503');
});

test('persistent 503 past maxRetries: throws, caught per-listing, other listings still run', async (t) => {
  const originalFetch = globalThis.fetch;
  const warnings = [];
  globalThis.fetch = async (url) => {
    if (url.includes('/new.json')) return headerResponse({ status: 503, headers: { 'Retry-After': '1' } });
    if (url.includes('/top.json')) return headerResponse({ posts: [makePost({ id: 'ok503', created_utc: 1700000000 })] });
    throw new Error(`unexpected url: ${url}`);
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const { observations } = await mine({
    cursors: {},
    config: {
      subreddits: ['s'],
      max_pages: 1,
      seed_listings: ['new', 'top:all'],
      rate_limit: { maxRetries: 2 },
    },
    logger: { ...SILENT, warn: (m) => warnings.push(m) },
    _sleep: sleepSpy(),
  });

  assert.ok(warnings.some((w) => w.includes('s/new') && w.includes('HTTP 503')),
    'exhausted /new (503) listing logged as failed');
  assert.equal(observations.length, 1, '/top still harvested — partial success preserved');
  assert.equal(observations[0].raw_id, 't3_ok503');
});

// -- Proactive-throttle edge: low remaining but reset header absent ----------

test('proactive throttle: low x-ratelimit-remaining but NO reset header → no pre-emptive sleep', async (t) => {
  const originalFetch = globalThis.fetch;
  let call = 0;
  globalThis.fetch = async () => {
    call++;
    if (call === 1) {
      return headerResponse({
        posts: [makePost({ id: 'p1', created_utc: 1700000000 })],
        after: 't3_p1',
        headers: { 'x-ratelimit-remaining': '0' }, // budget low, but reset unknown
      });
    }
    return headerResponse({ posts: [] });
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const spy = sleepSpy();

  await mine({
    cursors: {},
    config: { subreddits: ['s'], max_pages: 2, seed_listings: ['new'] },
    logger: SILENT,
    _sleep: spy,
  });

  assert.equal(call, 2, 'pagination still proceeds (not stalled by a pre-emptive sleep)');
  assert.ok(
    spy.calls.length > 0 && spy.calls.every((ms) => ms === 1100),
    `only the fixed 1100ms pacing — no reset-derived pre-emptive sleep; saw ${JSON.stringify(spy.calls)}`,
  );
});

// -- Heartbeat: adaptive waits must not be silent ----------------------------
// A cold start sleeps for many minutes across ~10 rate-limit windows. With no
// progress line per wait the scan is indistinguishable from a hung process.
// Every wait path must emit an informative heartbeat first.

test('429 backoff logs a heartbeat (sub/listing, HTTP status, wait seconds, attempt) before sleeping', async (t) => {
  const originalFetch = globalThis.fetch;
  let call = 0;
  globalThis.fetch = async () => {
    call++;
    if (call === 1) return headerResponse({ status: 429, headers: { 'Retry-After': '5' } });
    return headerResponse({ posts: [makePost({ id: 'a', created_utc: 1700000000 })] });
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const infos = [];

  await mine({
    cursors: {},
    config: { subreddits: ['s'], max_pages: 1, seed_listings: ['new'] },
    logger: { ...SILENT, info: (m) => infos.push(m) },
    _sleep: sleepSpy(),
  });

  const beat = infos.find((m) => m.includes('rate-limited'));
  assert.ok(beat, `a rate-limit heartbeat was logged; saw ${JSON.stringify(infos)}`);
  assert.ok(beat.includes('[reddit] s/new'), 'identifies the sub/listing that is waiting');
  assert.ok(beat.includes('HTTP 429'), 'states why it is waiting');
  assert.ok(beat.includes('5s'), 'states how long it will wait (derived from Retry-After: 5)');
  assert.ok(beat.includes('attempt 1/'), 'states which retry attempt this is');
});

test('proactive budget-low throttle logs a heartbeat before the pre-emptive sleep', async (t) => {
  const originalFetch = globalThis.fetch;
  let call = 0;
  globalThis.fetch = async () => {
    call++;
    if (call === 1) {
      return headerResponse({
        posts: [makePost({ id: 'p1', created_utc: 1700000000 })],
        after: 't3_p1',
        headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '3' },
      });
    }
    return headerResponse({ posts: [] });
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const infos = [];

  await mine({
    cursors: {},
    config: { subreddits: ['s'], max_pages: 2, seed_listings: ['new'] },
    logger: { ...SILENT, info: (m) => infos.push(m) },
    _sleep: sleepSpy(),
  });

  assert.equal(call, 2, 'run still proceeds past the proactive wait');
  const beat = infos.find((m) => m.includes('budget low'));
  assert.ok(beat, `a budget-low heartbeat was logged; saw ${JSON.stringify(infos)}`);
  assert.ok(beat.includes('[reddit] s/new'), 'identifies the sub/listing that is waiting');
  assert.ok(beat.includes('remaining 0'), 'reports the remaining budget that triggered it');
  assert.ok(beat.includes('3s'), 'states how long it will wait (derived from x-ratelimit-reset: 3)');
});
