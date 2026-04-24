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
  // Pain-centric communities
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
];

const USER_AGENT = 'ideawright/0.1 (signal-miner; contact via https://github.com/Joys-Dawn/toolwright)';

async function fetchSub(sub, beforeCursor, maxPages = 1) {
  // Incremental mode (cursor present): one page of posts NEWER than cursor.
  if (beforeCursor) {
    const url = `https://www.reddit.com/r/${sub}/new.json?limit=100&before=${beforeCursor}`;
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
    if (!res.ok) throw new Error(`reddit ${sub}: HTTP ${res.status}`);
    const data = await res.json();
    if (!data?.data?.children) throw new Error(`reddit ${sub}: unexpected shape`);
    return data.data.children.map((c) => c.data);
  }
  // Initial mode: paginate BACKWARD with `after=<fullname>` to walk older posts.
  const all = [];
  let after = null;
  for (let page = 0; page < maxPages; page++) {
    const url = `https://www.reddit.com/r/${sub}/new.json?limit=100${after ? `&after=${after}` : ''}`;
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
    if (!res.ok) throw new Error(`reddit ${sub}: HTTP ${res.status}`);
    const data = await res.json();
    const children = data?.data?.children ?? [];
    if (children.length === 0) break;
    all.push(...children.map((c) => c.data));
    after = data.data.after;
    if (!after) break;
    if (page < maxPages - 1) await sleep(1100);
  }
  return all;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
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

  for (const sub of subs) {
    const cursorKey = `reddit:${sub}`;
    try {
      const posts = await fetchSub(sub, cursors[cursorKey], maxPages);
      let newestId = null;
      for (const post of posts.slice(0, perSubCap)) {
        if (!newestId) newestId = post.name;
        const text = [post.title || '', post.selftext || ''].join('\n');
        if (!hasPainPhrase(text)) continue;
        const matches = matchPainPhrases(text);
        observations.push({
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
        });
      }
      if (newestId) updatedCursors[cursorKey] = newestId;
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
