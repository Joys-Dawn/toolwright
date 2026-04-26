// arXiv signal miner (Pipeline 2: supply-driven).
// Uses export.arxiv.org/api/query — Atom XML, no auth.
// Rate limit: 1 request per 3s per API policy.
//
// Emits one observation per recent paper. Detects a `code_url` when the
// abstract or links contain a GitHub/GitLab/HuggingFace URL — the
// capability validator uses this as a strong positive signal.

export { validateCapability as validator, validateCapabilityBatch as batchValidator } from './capability-validator.mjs';

const DEFAULT_CATEGORIES = [
  'cs.AI', 'cs.LG', 'cs.CL', 'cs.CV', 'cs.IR', 'cs.DB', 'cs.SE', 'cs.HC',
  'stat.ML',
  'q-bio.QM', 'q-bio.BM',
];

const BASE = 'http://export.arxiv.org/api/query';
const USER_AGENT = 'ideawright (capability-miner; contact via https://github.com/Joys-Dawn/toolwright)';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function parseAtomFeed(xml) {
  const entries = [];
  const entryRe = /<entry>([\s\S]*?)<\/entry>/g;
  let m;
  while ((m = entryRe.exec(xml))) {
    entries.push(parseEntry(m[1]));
  }
  return entries;
}

function parseEntry(block) {
  const id = textTag(block, 'id') ?? '';
  const arxivId = id.replace(/^https?:\/\/arxiv\.org\/abs\//, '').trim();
  const title = collapse(textTag(block, 'title'));
  const summary = collapse(textTag(block, 'summary'));
  const published = textTag(block, 'published');
  const updated = textTag(block, 'updated');
  const authorMatches = [...block.matchAll(/<author>[\s\S]*?<name>([^<]+)<\/name>[\s\S]*?<\/author>/g)];
  const authors = authorMatches.map((x) => x[1].trim());
  const primary = block.match(/<arxiv:primary_category[^>]*term="([^"]+)"/);
  const allCategoriesRaw = [...block.matchAll(/<category[^>]*term="([^"]+)"/g)];
  const categories = allCategoriesRaw.map((x) => x[1]);
  const linkMatches = [...block.matchAll(/<link[^>]*href="([^"]+)"[^>]*>/g)];
  const links = linkMatches.map((x) => x[1]);

  const codeUrl = detectCodeUrl(summary, links);

  return {
    arxivId,
    title,
    summary,
    published,
    updated,
    authors,
    primaryCategory: primary ? primary[1] : (categories[0] ?? null),
    categories,
    links,
    codeUrl,
  };
}

function textTag(block, tag) {
  const m = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`));
  return m ? m[1].trim() : null;
}

function collapse(s) {
  if (!s) return '';
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

export function detectCodeUrl(abstract, links = []) {
  const CODE_HOSTS = /https?:\/\/(?:github\.com|gitlab\.com|bitbucket\.org|huggingface\.co|codeberg\.org|sourceforge\.net|paperswithcode\.com)\/[^\s<>"'()]+/i;
  if (abstract) {
    const m = abstract.match(CODE_HOSTS);
    if (m) return m[0].replace(/[.,;:)\]]+$/, '');
  }
  for (const l of links) {
    if (CODE_HOSTS.test(l)) return l;
  }
  return null;
}

async function queryCategory(cat, maxResults) {
  const params = new URLSearchParams({
    search_query: `cat:${cat}`,
    sortBy: 'submittedDate',
    sortOrder: 'descending',
    max_results: String(maxResults),
  });
  const url = `${BASE}?${params}`;
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`arxiv ${cat}: HTTP ${res.status}`);
  const xml = await res.text();
  return parseAtomFeed(xml);
}

export async function mine({
  cursors = {},
  logger = console,
  config = {},
  maxPerQuery,
  _sleepMs,
} = {}) {
  const observations = [];
  const updatedCursors = { ...cursors };
  const cats = Array.isArray(config.categories) && config.categories.length > 0
    ? config.categories
    : DEFAULT_CATEGORIES;
  const requireCode = config.require_code_url === true;
  const lookbackDays = Number(config.lookback_days) > 0 ? Number(config.lookback_days) : 14;
  const effectiveMaxPerQuery = maxPerQuery ?? config.max_per_query ?? 50;
  const interCategorySleepMs = _sleepMs ?? 8000;

  for (let i = 0; i < cats.length; i++) {
    const cat = cats[i];
    const cursorKey = `arxiv:${cat}`;
    const sinceIso = cursors[cursorKey] ?? new Date(Date.now() - lookbackDays * 86400000).toISOString();
    let newestIso = sinceIso;

    try {
      const entries = await queryCategory(cat, effectiveMaxPerQuery);
      for (const e of entries) {
        if (e.published && e.published > newestIso) newestIso = e.published;
        if (e.published && e.published <= sinceIso) continue;
        if (requireCode && !e.codeUrl) continue;

        observations.push({
          source: 'arxiv',
          source_query: `cat:${cat}`,
          source_url: `https://arxiv.org/abs/${e.arxivId}`,
          title: e.title,
          quote: e.summary.slice(0, 1800),
          pain_matches: [],
          author: e.authors[0] ?? null,
          authors: e.authors,
          code_url: e.codeUrl,
          categories: e.categories,
          engagement: {
            primary_category: e.primaryCategory,
            has_code_link: !!e.codeUrl,
            link_count: e.links.length,
          },
          created_at: e.published,
          updated_at: e.updated,
          raw_id: `arxiv:${e.arxivId}`,
        });
      }
      updatedCursors[cursorKey] = newestIso;
    } catch (err) {
      logger.warn(`[arxiv] ${cat} failed: ${err.message}`);
    }
    // Politeness gap between categories per arXiv's 1 req / 3s API policy.
    // Skip after the last category — no point sleeping before returning.
    if (i < cats.length - 1) await sleep(interCategorySleepMs);
  }

  return { observations, cursors: updatedCursors };
}

export const meta = {
  id: 'arxiv',
  displayName: 'arXiv',
  cost: 'free',
  auth: 'none',
  rateLimit: '1 req / 3s per arXiv API policy',
  pipeline: 'supply',
};
