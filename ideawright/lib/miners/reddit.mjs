// Reddit signal miner.
// Uses the public .json endpoints (no auth, no OAuth). Reddit rate-limits
// unauthenticated .json access by IP (~100 requests / ~600s window, surfaced
// via the x-ratelimit-* response headers). fetchListing is rate-limit-aware:
// it backs off and retries on HTTP 429/503 honoring Retry-After then
// x-ratelimit-reset, and proactively throttles when the remaining budget runs
// low so a deep cold-start rides out windows instead of dying. Read-only.

import { matchPainPhrases, hasPainPhrase } from './pain-regex.mjs';

const TARGET_SUBS = [
  // Explicit idea-request subs
  'SomebodyMakeThis',
  'AppIdeas',
  'lightbulb',
  'shutupandtakemymoney',
  'HelpMeFind',
  // Pain-centric dev/ops communities
  'Entrepreneur',
  'SaaS',
  'indiehackers',
  'sideproject',
  'webdev',
  'learnprogramming',
  'ExperiencedDevs',
  'productivity',
  'selfhosted',
  'devops',
  'sysadmin',
  'datascience',
  // AI / coding-assistant tool communities
  'ChatGPTCoding',
  'ClaudeAI',
  // PKM / note-taking
  'ObsidianMD',
  'Zettelkasten',
  // DIY infra
  'homelab',
  // Business / freelance
  'smallbusiness',
  'freelance',
  'startups',
];

const USER_AGENT = 'ideawright (signal-miner; contact via https://github.com/Joys-Dawn/toolwright)';

// Rate-limit handling defaults. Overridable via config.rate_limit.
//  - maxRetries: 429/503 retries per request. 12 is enough to ride out ~10+
//    Reddit budget windows on a deep cold-start.
//  - maxBackoffMs: hard cap on any single wait so a pathological Retry-After
//    can't hang the run.
//  - fallbackMs: wait used when neither Retry-After nor x-ratelimit-reset is
//    present on a 429/503.
//  - remainingThreshold: when x-ratelimit-remaining drops to/below this after a
//    success, sleep until reset to avoid tripping 429 on the next request.
const DEFAULT_RATE_CFG = {
  maxRetries: 12,
  maxBackoffMs: 900_000,
  fallbackMs: 60_000,
  remainingThreshold: 2,
};

function resolveRateCfg(raw) {
  return { ...DEFAULT_RATE_CFG, ...(raw && typeof raw === 'object' ? raw : {}) };
}

// Fixed ~1 req/sec inter-request pacing for Reddit's unauthenticated .json
// endpoints. Composes additively with the adaptive header-driven backoff in
// fetchWithRateLimit (so it never under-waits). Applied between pages, between
// seed listings, and after each sub.
const PACING_MS = 1100;

const VALID_LISTINGS = new Set(['new', 'hot', 'top', 'controversial']);
const VALID_TIME_FILTERS = new Set(['hour', 'day', 'week', 'month', 'year', 'all']);
const TIME_AWARE_LISTINGS = new Set(['top', 'controversial']);

// Parse a listing spec like "new", "top:all", "controversial:year".
// Returns { endpoint, time } or null if malformed.
function parseListing(spec) {
  if (typeof spec !== 'string') return null;
  const parts = spec.split(':');
  if (parts.length > 2) return null;
  const [endpoint, time] = parts;
  if (!VALID_LISTINGS.has(endpoint)) return null;
  if (time !== undefined) {
    if (!VALID_TIME_FILTERS.has(time)) return null;
    if (!TIME_AWARE_LISTINGS.has(endpoint)) return null;
  }
  if (TIME_AWARE_LISTINGS.has(endpoint) && !time) {
    return { endpoint, time: 'all' };
  }
  return { endpoint, time: time ?? null };
}

// Null-safe header read. Test mocks return bare { ok, status, json } with no
// `headers`, so every header access must tolerate its absence.
function getHeader(res, key) {
  return res?.headers?.get?.(key) ?? null;
}

function numHeader(res, key) {
  const v = getHeader(res, key);
  if (v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Retry-After: either delta-seconds ("120") or an HTTP-date. Returns ms or null.
export function parseRetryAfter(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (/^\d+$/.test(s)) return Number(s) * 1000;
  const t = Date.parse(s);
  if (!Number.isNaN(t)) {
    const delta = t - Date.now();
    return delta > 0 ? delta : 0;
  }
  return null;
}

// x-ratelimit-reset is seconds-until-reset on Reddit's .json endpoint
// (verified live: value ~311, not a Unix timestamp). ceil is deliberate —
// rounding the wait up can only ever wait slightly long, never short (so we
// never re-fire into a still-exhausted window). Returns ms or null.
export function parseResetSeconds(v) {
  if (v == null) return null;
  const n = parseFloat(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.ceil(n) * 1000;
}

// Wait to apply on a 429/503: Retry-After, else x-ratelimit-reset, else the
// configured fallback. Clamped to [0, maxBackoffMs].
export function rateLimitWaitMs(res, cfg) {
  const ra = parseRetryAfter(getHeader(res, 'retry-after'));
  const reset = ra === null ? parseResetSeconds(getHeader(res, 'x-ratelimit-reset')) : null;
  const base = ra ?? reset ?? cfg.fallbackMs;
  return Math.min(Math.max(base, 0), cfg.maxBackoffMs);
}

// Single fetch with adaptive rate-limit handling. On 429/503: wait out the
// window and retry, up to cfg.maxRetries, then throw. On any other non-2xx:
// throw immediately (preserves the existing "one listing throws → skip it,
// run continues" behavior). On success: if the remaining budget is low,
// proactively sleep until reset so the *next* request doesn't 429.
async function fetchWithRateLimit(url, { headers, cfg, sleepFn, label, logger }) {
  // Without a heartbeat the adaptive waits below are silent: on a first cold
  // start the proactive throttle + 429/503 backoff sleep for many minutes per
  // window (~10 windows, ~1.5h), making a healthy scan indistinguishable from
  // a hung process. Log before every wait. Default to a noop so callers that
  // don't pass a logger still work. `label` (sub/listing identity) is passed
  // in canonically rather than re-parsed out of the error string, so the
  // heartbeat logs and the thrown message can't drift apart.
  const log = logger ?? { info() {}, warn() {}, error() {} };
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers });
    if (res.ok) {
      const remaining = numHeader(res, 'x-ratelimit-remaining');
      if (remaining !== null && remaining <= cfg.remainingThreshold) {
        const resetMs = parseResetSeconds(getHeader(res, 'x-ratelimit-reset'));
        if (resetMs !== null) {
          const waitMs = Math.min(resetMs, cfg.maxBackoffMs);
          log.info(
            `[reddit] ${label}: budget low (remaining ${remaining}); `
            + `waiting ${Math.ceil(waitMs / 1000)}s for window reset`,
          );
          await sleepFn(waitMs);
        }
      }
      return res;
    }
    if ((res.status === 429 || res.status === 503) && attempt < cfg.maxRetries) {
      const waitMs = rateLimitWaitMs(res, cfg);
      log.info(
        `[reddit] ${label}: rate-limited (HTTP ${res.status}); `
        + `waiting ${Math.ceil(waitMs / 1000)}s for window reset `
        + `(attempt ${attempt + 1}/${cfg.maxRetries})`,
      );
      await sleepFn(waitMs);
      continue;
    }
    throw new Error(`reddit ${label}: HTTP ${res.status}`);
  }
}

// Single canonical Reddit listing URL builder. `before` and `after` are
// mutually-exclusive Reddit cursor params (before = newer than, after = older).
async function fetchListing(sub, parsed, { maxPages = 1, before, cfg = DEFAULT_RATE_CFG, logger, _sleep } = {}) {
  const sleepFn = _sleep ?? sleep;
  const { endpoint, time } = parsed;
  const all = [];
  let after = null;
  for (let page = 0; page < maxPages; page++) {
    const params = new URLSearchParams({ limit: '100' });
    if (time) params.set('t', time);
    if (after) params.set('after', after);
    if (before && page === 0) params.set('before', before);
    const url = `https://www.reddit.com/r/${sub}/${endpoint}.json?${params}`;
    const label = `${sub}/${endpoint}${time ? `:${time}` : ''}`;
    const res = await fetchWithRateLimit(url, {
      headers: { 'User-Agent': USER_AGENT }, cfg, sleepFn, label, logger,
    });
    const data = await res.json();
    const children = data?.data?.children ?? [];
    if (children.length === 0) break;
    all.push(...children.map((c) => c.data));
    after = data.data.after;
    if (!after || before) break; // before-mode is single-page only
    if (page < maxPages - 1) await sleepFn(PACING_MS);
  }
  return all;
}

// Cold-start path: walk every seed listing, dedup by post id. A failure on
// one listing is logged and the remaining listings still run, so partial
// results from successful listings aren't discarded.
async function fetchSubColdStart(sub, parsedSeedListings, maxPages, logger, cfg, sleepFn) {
  const byId = new Map();
  for (let i = 0; i < parsedSeedListings.length; i++) {
    const parsed = parsedSeedListings[i];
    try {
      const posts = await fetchListing(sub, parsed, { maxPages, cfg, logger, _sleep: sleepFn });
      for (const p of posts) {
        if (p?.name && !byId.has(p.name)) byId.set(p.name, p);
      }
    } catch (err) {
      const tag = `${parsed.endpoint}${parsed.time ? `:${parsed.time}` : ''}`;
      logger.warn(`[reddit] ${sub}/${tag} failed: ${err.message}`);
    }
    if (i < parsedSeedListings.length - 1) await sleepFn(PACING_MS);
  }
  return [...byId.values()];
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function pickNewest(posts) {
  return posts.reduce(
    (best, p) => (!best || (p?.created_utc ?? 0) > (best?.created_utc ?? 0)) ? p : best,
    null,
  );
}

function buildObservation(post, sub) {
  const text = [post.title || '', post.selftext || ''].join('\n');
  if (!hasPainPhrase(text)) return null;
  const matches = matchPainPhrases(text);
  return {
    source: 'reddit',
    source_sub: sub,
    source_url: `https://www.reddit.com${post.permalink}`,
    title: post.title,
    quote: matches[0]?.excerpt ?? post.title,
    pain_matches: matches.map((m) => m.match),
    author: post.author,
    engagement: {
      ups: post.ups ?? 0,
      num_comments: post.num_comments ?? 0,
      score: post.score ?? 0,
    },
    created_at: new Date((post.created_utc ?? 0) * 1000).toISOString(),
    raw_id: post.name,
  };
}

export async function mine({
  cursors = {},
  maxPostsPerSub,
  logger = console,
  config = {},
  _sleep,
} = {}) {
  const sleepFn = _sleep ?? sleep;
  const cfg = resolveRateCfg(config.rate_limit);
  const observations = [];
  const updatedCursors = { ...cursors };
  const subs = Array.isArray(config.subreddits) && config.subreddits.length > 0
    ? config.subreddits
    : TARGET_SUBS;
  const maxPages = config.max_pages ?? 10;
  const perSubCap = maxPostsPerSub ?? config.max_posts_per_sub ?? maxPages * 100;
  const parsedSeed = Array.isArray(config.seed_listings) && config.seed_listings.length > 0
    ? config.seed_listings.map(parseListing).filter(Boolean)
    : null;
  const seedListings = (parsedSeed && parsedSeed.length > 0)
    ? parsedSeed
    : [{ endpoint: 'new', time: null }];

  for (const sub of subs) {
    const cursorKey = `reddit:${sub}`;
    const cursor = cursors[cursorKey];
    try {
      const posts = cursor
        ? await fetchListing(sub, { endpoint: 'new', time: null }, { before: cursor, cfg, logger, _sleep: sleepFn })
        : await fetchSubColdStart(sub, seedListings, maxPages, logger, cfg, sleepFn);

      // Newest tracking is a separate full-pass over the deduped posts so
      // it can't be truncated by perSubCap (regression guard for the
      // top:-first ordering bug where the date-newest sat past the cap).
      const newestPost = pickNewest(posts);

      for (const post of posts.slice(0, perSubCap)) {
        const obs = buildObservation(post, sub);
        if (obs) observations.push(obs);
      }

      if (newestPost?.name) updatedCursors[cursorKey] = newestPost.name;
    } catch (err) {
      logger.warn(`[reddit] ${sub} failed: ${err.message}`);
    } finally {
      await sleepFn(PACING_MS);
    }
  }

  return { observations, cursors: updatedCursors };
}

export const meta = {
  id: 'reddit',
  displayName: 'Reddit',
  cost: 'free',
  auth: 'none',
  rateLimit: '~100 req / ~600s window per IP on .json (header-driven adaptive backoff + retry)',
};
