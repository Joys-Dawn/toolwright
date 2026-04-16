// bioRxiv signal miner (Pipeline 2: supply-driven).
// Uses api.biorxiv.org — JSON, no auth.
// Endpoint shape: /details/<server>/<from-date>/<to-date>/<cursor>
// server = "biorxiv" (bio sciences) or "medrxiv" (medical).
//
// Filters by category (subject) since bioRxiv's broad firehose is mostly
// wet-lab work that doesn't map to code-only products.

export { validateCapability as validator, validateCapabilityBatch as batchValidator } from './capability-validator.mjs';

const BASE = 'https://api.biorxiv.org';
const USER_AGENT = 'ideawright/0.1 (capability-miner)';

// Subjects where a paper tends to describe a method/algorithm/dataset that a
// solo dev could build a product around. Excludes wet-lab-only categories.
const DEFAULT_CATEGORIES = [
  'bioinformatics',
  'systems biology',
  'synthetic biology',
  'genomics',
  'genetics',
  'epidemiology',
  'neuroscience',
  'scientific communication and education',
];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function ymd(d) {
  return d.toISOString().slice(0, 10);
}

export function categoryMatches(paperCategory, wanted) {
  if (!paperCategory) return false;
  const pc = paperCategory.toLowerCase().trim();
  return wanted.some((c) => pc === c.toLowerCase() || pc.includes(c.toLowerCase()));
}

async function fetchPage(server, fromDate, toDate, cursor) {
  const url = `${BASE}/details/${server}/${fromDate}/${toDate}/${cursor}`;
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`biorxiv: HTTP ${res.status}`);
  const data = await res.json();
  if (!data?.collection) throw new Error('biorxiv: unexpected response shape');
  return data;
}

export async function mine({
  cursors = {},
  logger = console,
  config = {},
  lookbackDays = 14,
  maxPerRun = 300,
} = {}) {
  const server = config.server === 'medrxiv' ? 'medrxiv' : 'biorxiv';
  const wantedCategories = Array.isArray(config.categories) && config.categories.length > 0
    ? config.categories
    : DEFAULT_CATEGORIES;

  const cursorKey = `${server}:last_doi_date`;
  const now = new Date();
  const lookback = lookbackDays * 86400000;
  const fromDate = ymd(new Date(now.getTime() - lookback));
  const toDate = ymd(now);
  const sinceDate = cursors[cursorKey] ?? fromDate;

  const observations = [];
  const updatedCursors = { ...cursors };
  let newestDate = sinceDate;
  let pageCursor = 0;
  let fetched = 0;
  const seenDois = new Set();

  while (fetched < maxPerRun) {
    let data;
    try {
      data = await fetchPage(server, fromDate, toDate, pageCursor);
    } catch (err) {
      logger.warn(`[biorxiv] page ${pageCursor} failed: ${err.message}`);
      break;
    }
    const papers = data.collection ?? [];
    if (papers.length === 0) break;

    for (const p of papers) {
      fetched += 1;
      if (!p.doi || seenDois.has(p.doi)) continue;
      seenDois.add(p.doi);

      const paperDate = p.date ?? '';
      if (paperDate && paperDate > newestDate) newestDate = paperDate;
      if (paperDate && paperDate < sinceDate) continue;

      if (!categoryMatches(p.category, wantedCategories)) continue;
      if (p.version && String(p.version) !== '1') continue; // new preprints only, skip revisions

      const doi = p.doi;
      const abstract = p.abstract ?? '';
      observations.push({
        source: server,
        source_query: p.category,
        source_url: `https://www.biorxiv.org/content/${doi}v${p.version ?? '1'}`,
        title: (p.title ?? '').trim(),
        quote: abstract.slice(0, 1800),
        pain_matches: [],
        author: firstAuthor(p.authors),
        authors: splitAuthors(p.authors),
        categories: [p.category],
        engagement: {
          category: p.category,
          version: p.version,
          type: p.type,
          doi,
        },
        created_at: p.date ?? null,
        raw_id: `biorxiv:${doi}`,
      });
    }

    const next = Number(data?.messages?.[0]?.cursor ?? NaN);
    const totalCount = Number(data?.messages?.[0]?.count ?? NaN);
    if (!Number.isFinite(next) || fetched >= totalCount) break;
    pageCursor = next;
    await sleep(500);
  }

  updatedCursors[cursorKey] = newestDate;
  return { observations, cursors: updatedCursors };
}

function splitAuthors(s) {
  if (!s || typeof s !== 'string') return [];
  return s.split(/;|,\s+and\s+|\s*&\s*/).map((x) => x.trim()).filter(Boolean);
}

function firstAuthor(s) {
  const list = splitAuthors(s);
  return list[0] ?? null;
}

export const meta = {
  id: 'biorxiv',
  displayName: 'bioRxiv / medRxiv',
  cost: 'free',
  auth: 'none',
  rateLimit: 'unstated; be polite',
  pipeline: 'supply',
};
