// Hacker News signal miner via Algolia search API.
// Free, no auth, no hard rate limit documented (be polite).
// Docs: https://hn.algolia.com/api

import { matchPainPhrases } from './pain-regex.mjs';

const BASE = 'https://hn.algolia.com/api/v1';

// Queries that tend to surface pain comments. Each runs as a separate
// search_by_date call against comments, scoped to the last N days.
const PAIN_QUERIES = [
  '"i wish there was"',
  '"why is there no"',
  '"why isn\'t there"',
  '"someone should build"',
  '"is there a tool for"',
  '"i would pay for"',
  '"frustrated with"',
  '"every tool i tried"',
];

async function searchComments(query, sinceTs) {
  const params = new URLSearchParams({
    query,
    tags: 'comment',
    hitsPerPage: '100',
    numericFilters: `created_at_i>${sinceTs}`,
  });
  const res = await fetch(`${BASE}/search_by_date?${params}`);
  if (!res.ok) throw new Error(`hn algolia: HTTP ${res.status}`);
  const data = await res.json();
  return data.hits ?? [];
}

export async function mine({ cursors = {}, lookbackDays = 14, logger = console } = {}) {
  const observations = [];
  const updatedCursors = { ...cursors };
  const now = Math.floor(Date.now() / 1000);
  const sinceTs = Math.max(
    cursors['hn:last_ts'] ?? 0,
    now - lookbackDays * 86400,
  );

  let newestTs = sinceTs;
  const seen = new Set();

  for (const q of PAIN_QUERIES) {
    try {
      const hits = await searchComments(q, sinceTs);
      for (const hit of hits) {
        const id = hit.objectID;
        if (seen.has(id)) continue;
        seen.add(id);
        if (hit.created_at_i > newestTs) newestTs = hit.created_at_i;
        const text = hit.comment_text || '';
        const matches = matchPainPhrases(stripHtml(text));
        if (matches.length === 0) continue;
        observations.push({
          source: 'hn',
          source_query: q,
          source_url: `https://news.ycombinator.com/item?id=${id}`,
          title: hit.story_title ?? '(comment)',
          quote: matches[0].excerpt,
          pain_matches: matches.map((m) => m.match),
          author: hit.author,
          engagement: {
            points: hit.points ?? null,
            story_title: hit.story_title,
          },
          created_at: new Date(hit.created_at_i * 1000).toISOString(),
          raw_id: id,
        });
      }
    } catch (err) {
      logger.warn(`[hn] query "${q}" failed: ${err.message}`);
    }
  }

  updatedCursors['hn:last_ts'] = newestTs;
  return { observations, cursors: updatedCursors };
}

function stripHtml(s) {
  if (!s) return '';
  return s
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

export const meta = {
  id: 'hn',
  displayName: 'Hacker News (Algolia)',
  cost: 'free',
  auth: 'none',
  rateLimit: 'none documented',
};
