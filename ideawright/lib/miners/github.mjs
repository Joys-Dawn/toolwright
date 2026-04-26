// GitHub signal miner. Targets issues that indicate unmet need:
//   - `is:issue state:closed reason:not-planned` on popular repos
//     (maintainer rejected → open door for a separate tool)
//   - `is:issue label:"help wanted"` with no assignee
//   - `is:issue label:"wontfix"` with high reaction count
//
// Uses the REST search API. 30 req/min unauth, 5000/hr with GITHUB_TOKEN.

const BASE = 'https://api.github.com';

const ISSUE_QUERIES = [
  // Widely-used repos, rejected-not-planned issues
  'is:issue is:closed reason:"not planned" comments:>5 sort:updated-desc',
  // Help-wanted with engagement
  'is:issue is:open label:"help wanted" no:assignee comments:>3 sort:updated-desc',
  // Wontfix with traction
  'is:issue label:wontfix reactions:>10 sort:updated-desc',
];

function headers() {
  const h = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'ideawright-signal-miner',
  };
  const token = process.env.GITHUB_TOKEN;
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

async function searchIssues(query, page = 1, perPage = 50) {
  const params = new URLSearchParams({
    q: query,
    per_page: String(perPage),
    page: String(page),
  });
  const res = await fetch(`${BASE}/search/issues?${params}`, { headers: headers() });
  if (res.status === 403) {
    throw new Error('github search rate-limited (30/min auth, 10/min unauth — SEARCH pool is separate from the 5000/hr core pool)');
  }
  if (!res.ok) throw new Error(`github: HTTP ${res.status}`);
  return res.json();
}

export async function mine({
  cursors = {},
  logger = console,
  config = {},
  maxPerQuery,
} = {}) {
  const observations = [];
  const updatedCursors = { ...cursors };
  const queries = Array.isArray(config.queries) && config.queries.length > 0
    ? config.queries
    : ISSUE_QUERIES;
  const lookbackDays = Number(config.lookback_days) > 0 ? Number(config.lookback_days) : 14;
  const effectiveMaxPerQuery = maxPerQuery ?? config.max_per_query ?? 50;
  const seenIds = new Set();
  const sinceIso = cursors['github:last_ts'] ?? new Date(Date.now() - lookbackDays * 86400000).toISOString();
  let newestIso = sinceIso;

  for (const q of queries) {
    try {
      const data = await searchIssues(q, 1, Math.min(effectiveMaxPerQuery, 100));
      for (const item of (data.items ?? []).slice(0, effectiveMaxPerQuery)) {
        if (seenIds.has(item.id)) continue;
        seenIds.add(item.id);
        if (item.updated_at > newestIso) newestIso = item.updated_at;
        if (item.updated_at <= sinceIso) continue;

        const body = (item.body || '').slice(0, 1500);
        const reactionCount = Object.values(item.reactions || {}).reduce(
          (sum, v) => (typeof v === 'number' ? sum + v : sum),
          0,
        );

        observations.push({
          source: 'github',
          source_query: q,
          source_url: item.html_url,
          title: item.title,
          quote: body || item.title,
          pain_matches: [],
          author: item.user?.login ?? null,
          engagement: {
            comments: item.comments ?? 0,
            reactions: reactionCount,
            state: item.state,
            state_reason: item.state_reason ?? null,
            labels: (item.labels || []).map((l) => (typeof l === 'string' ? l : l.name)),
          },
          created_at: item.created_at,
          updated_at: item.updated_at,
          raw_id: String(item.id),
        });
      }
    } catch (err) {
      logger.warn(`[github] query failed (${q.slice(0, 40)}…): ${err.message}`);
    }
  }

  updatedCursors['github:last_ts'] = newestIso;
  return { observations, cursors: updatedCursors };
}

export const meta = {
  id: 'github',
  displayName: 'GitHub Issues',
  cost: 'free',
  auth: 'GITHUB_TOKEN recommended (still search-limited)',
  // GitHub Search API pool — separate from the 5000/hr core pool and much stricter.
  rateLimit: '10/min unauth, 30/min auth',
};
