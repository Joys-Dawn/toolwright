// PubMed signal miner (Pipeline 2: supply-driven).
// Uses NCBI E-utilities — public, no auth required.
// Rate limit: 3 req/s without API key; 10 req/s with NCBI_API_KEY env.
//
// Two-step flow:
//   1. esearch.fcgi → PMIDs matching a query filtered to recent pubdate
//   2. efetch.fcgi  → abstracts for those PMIDs in one batch (XML)
//
// Default queries target papers that describe a software/algorithm/method
// likely to enable a code-only product.

import { createHash } from 'node:crypto';

export { validateCapability as validator } from './capability-validator.mjs';

const BASE = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';
const USER_AGENT = 'ideawright/0.1 (capability-miner)';

const DEFAULT_QUERIES = [
  '(algorithm[Title] OR software[Title] OR tool[Title] OR framework[Title]) AND hasabstract[Filter]',
  '(machine learning[Title] OR deep learning[Title] OR neural network[Title]) AND hasabstract[Filter]',
  '(open source[Title/Abstract] AND (software[Title/Abstract] OR tool[Title/Abstract])) AND hasabstract[Filter]',
];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function rateSleepMs() {
  return process.env.NCBI_API_KEY ? 110 : 350;
}

function ymdSlash(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}/${m}/${day}`;
}

async function esearch(term, fromDate, toDate, retmax) {
  const params = new URLSearchParams({
    db: 'pubmed',
    term,
    retmode: 'json',
    retmax: String(retmax),
    sort: 'pub_date',
    datetype: 'pdat',
    mindate: fromDate,
    maxdate: toDate,
  });
  if (process.env.NCBI_API_KEY) params.set('api_key', process.env.NCBI_API_KEY);
  const res = await fetch(`${BASE}/esearch.fcgi?${params}`, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`pubmed esearch: HTTP ${res.status}`);
  const data = await res.json();
  return data?.esearchresult?.idlist ?? [];
}

async function efetch(pmids) {
  if (pmids.length === 0) return [];
  const params = new URLSearchParams({
    db: 'pubmed',
    id: pmids.join(','),
    retmode: 'xml',
    rettype: 'abstract',
  });
  if (process.env.NCBI_API_KEY) params.set('api_key', process.env.NCBI_API_KEY);
  const res = await fetch(`${BASE}/efetch.fcgi?${params}`, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`pubmed efetch: HTTP ${res.status}`);
  const xml = await res.text();
  return parsePubmedXml(xml);
}

export function parsePubmedXml(xml) {
  const out = [];
  const articleRe = /<PubmedArticle>([\s\S]*?)<\/PubmedArticle>/g;
  let m;
  while ((m = articleRe.exec(xml))) {
    const block = m[1];
    const pmid = textTag(block, 'PMID');
    const title = decode(collapse(textTag(block, 'ArticleTitle') ?? ''));
    const abstractParts = [...block.matchAll(/<AbstractText[^>]*>([\s\S]*?)<\/AbstractText>/g)];
    const abstract = decode(collapse(abstractParts.map((x) => x[1]).join(' ')));
    const pubDate = extractPubDate(block);
    const journal = decode(collapse(textTag(block, 'Title') ?? ''));
    const authorMatches = [...block.matchAll(/<Author[^>]*>([\s\S]*?)<\/Author>/g)];
    const authors = authorMatches.map((a) => {
      const last = textTag(a[1], 'LastName') ?? '';
      const first = textTag(a[1], 'ForeName') ?? textTag(a[1], 'Initials') ?? '';
      return `${first} ${last}`.trim();
    }).filter(Boolean);

    out.push({ pmid, title, abstract, pubDate, journal, authors });
  }
  return out;
}

function textTag(block, tag) {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`);
  const m = block.match(re);
  return m ? m[1] : null;
}

function collapse(s) {
  return String(s).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function decode(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function extractPubDate(block) {
  const yM = block.match(/<PubDate>[\s\S]*?<Year>(\d{4})<\/Year>/);
  const mM = block.match(/<PubDate>[\s\S]*?<Month>([^<]+)<\/Month>/);
  const dM = block.match(/<PubDate>[\s\S]*?<Day>(\d{1,2})<\/Day>/);
  if (!yM) return null;
  const months = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
                   jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };
  const raw = (mM?.[1] ?? '01').trim().toLowerCase().slice(0, 3);
  const mm = months[raw] ?? (mM && /^\d+$/.test(mM[1]) ? String(mM[1]).padStart(2, '0') : '01');
  const dd = dM ? String(dM[1]).padStart(2, '0') : '01';
  return `${yM[1]}-${mm}-${dd}`;
}

export async function mine({
  cursors = {},
  logger = console,
  config = {},
  lookbackDays = 14,
  maxPerQuery = 100,
} = {}) {
  const queries = Array.isArray(config.queries) && config.queries.length > 0
    ? config.queries
    : DEFAULT_QUERIES;
  const now = new Date();
  const fromDate = ymdSlash(new Date(now.getTime() - lookbackDays * 86400000));
  const toDate = ymdSlash(now);

  const observations = [];
  const updatedCursors = { ...cursors };
  const seenPmids = new Set();

  for (const term of queries) {
    const cursorKey = `pubmed:${hashQuery(term)}`;
    const sinceDate = cursors[cursorKey] ?? fromDate.replace(/\//g, '-');
    let newestDate = sinceDate;

    let pmids;
    try {
      pmids = await esearch(term, fromDate, toDate, maxPerQuery);
    } catch (err) {
      logger.warn(`[pubmed] esearch failed (${term.slice(0, 40)}…): ${err.message}`);
      continue;
    }

    const fresh = pmids.filter((id) => !seenPmids.has(id));
    fresh.forEach((id) => seenPmids.add(id));
    if (fresh.length === 0) {
      await sleep(rateSleepMs());
      continue;
    }

    await sleep(rateSleepMs());

    let articles;
    try {
      articles = await efetch(fresh);
    } catch (err) {
      logger.warn(`[pubmed] efetch failed: ${err.message}`);
      await sleep(rateSleepMs());
      continue;
    }

    for (const a of articles) {
      if (!a.pmid) continue;
      const pubDate = a.pubDate ?? '';
      if (pubDate && pubDate > newestDate) newestDate = pubDate;
      if (pubDate && pubDate < sinceDate) continue;
      if (!a.abstract) continue;

      observations.push({
        source: 'pubmed',
        source_query: term,
        source_url: `https://pubmed.ncbi.nlm.nih.gov/${a.pmid}/`,
        title: a.title,
        quote: a.abstract.slice(0, 1800),
        pain_matches: [],
        author: a.authors[0] ?? null,
        authors: a.authors,
        engagement: {
          journal: a.journal,
          pmid: a.pmid,
        },
        created_at: pubDate || null,
        raw_id: `pubmed:${a.pmid}`,
      });
    }

    updatedCursors[cursorKey] = newestDate;
    await sleep(rateSleepMs());
  }

  return { observations, cursors: updatedCursors };
}

function hashQuery(q) {
  return createHash('sha256').update(q).digest('hex').slice(0, 12);
}

export const meta = {
  id: 'pubmed',
  displayName: 'PubMed',
  cost: 'free',
  auth: 'NCBI_API_KEY optional (3 req/s unauth, 10 req/s auth)',
  rateLimit: '3 req/s without key, 10 req/s with key',
  pipeline: 'supply',
};
