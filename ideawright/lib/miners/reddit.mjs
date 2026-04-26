// Reddit signal miner.
// Uses the public .json endpoints (no auth, but requires a UA string
// and ~1 req/sec). Calls are read-only; no OAuth.

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

// Single canonical Reddit listing URL builder. `before` and `after` are
// mutually-exclusive Reddit cursor params (before = newer than, after = older).
async function fetchListing(sub, parsed, { maxPages = 1, before } = {}) {
  const { endpoint, time } = parsed;
  const all = [];
  let after = null;
  for (let page = 0; page < maxPages; page++) {
    const params = new URLSearchParams({ limit: '100' });
    if (time) params.set('t', time);
    if (after) params.set('after', after);
    if (before && page === 0) params.set('before', before);
    const url = `https://www.reddit.com/r/${sub}/${endpoint}.json?${params}`;
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
    if (!res.ok) throw new Error(`reddit ${sub}/${endpoint}${time ? `:${time}` : ''}: HTTP ${res.status}`);
    const data = await res.json();
    const children = data?.data?.children ?? [];
    if (children.length === 0) break;
    all.push(...children.map((c) => c.data));
    after = data.data.after;
    if (!after || before) break; // before-mode is single-page only
    if (page < maxPages - 1) await sleep(1100);
  }
  return all;
}

// Cold-start path: walk every seed listing, dedup by post id. A failure on
// one listing is logged and the remaining listings still run, so partial
// results from successful listings aren't discarded.
async function fetchSubColdStart(sub, parsedSeedListings, maxPages, logger) {
  const byId = new Map();
  for (let i = 0; i < parsedSeedListings.length; i++) {
    const parsed = parsedSeedListings[i];
    try {
      const posts = await fetchListing(sub, parsed, { maxPages });
      for (const p of posts) {
        if (p?.name && !byId.has(p.name)) byId.set(p.name, p);
      }
    } catch (err) {
      const tag = `${parsed.endpoint}${parsed.time ? `:${parsed.time}` : ''}`;
      logger.warn(`[reddit] ${sub}/${tag} failed: ${err.message}`);
    }
    if (i < parsedSeedListings.length - 1) await sleep(1100);
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
} = {}) {
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
        ? await fetchListing(sub, { endpoint: 'new', time: null }, { before: cursor })
        : await fetchSubColdStart(sub, seedListings, maxPages, logger);

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
      await sleep(1100);
    }
  }

  return { observations, cursors: updatedCursors };
}

export const meta = {
  id: 'reddit',
  displayName: 'Reddit',
  cost: 'free',
  auth: 'none',
  rateLimit: '~60/min per UA',
};
