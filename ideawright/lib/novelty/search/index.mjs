import { searchDDG } from "./ddg.mjs";
import { searchExa } from "./exa.mjs";
import { searchGitHubRepos, searchGitHubCode } from "./github.mjs";
import { searchHN } from "./hn.mjs";
import { searchNpm } from "./npm.mjs";
import { searchScholar } from "./scholar.mjs";
import { makeLimiter } from "../limiter.mjs";

const DEFAULT_TIMEOUT_MS = 15000;

const DEFAULT_HOST_CAPS = {
  ddg: 2,
  exa: 2,
  github: 2,
  hn: 4,
  npm: 4,
  scholar: 1,
};

async function timed(label, fn, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const rows = await fn(ctrl.signal);
    return { source: label, rows, error: null };
  } catch (e) {
    return { source: label, rows: [], error: e?.message || String(e) };
  } finally {
    clearTimeout(t);
  }
}

function normalizeUrl(u) {
  try {
    const parsed = new URL(u);
    parsed.hash = "";
    const drop = ["utm_source","utm_medium","utm_campaign","utm_content","utm_term","ref","ref_src","ref_url","fbclid","gclid"];
    for (const k of drop) parsed.searchParams.delete(k);
    let out = parsed.toString();
    if (out.endsWith("/")) out = out.slice(0, -1);
    return out;
  } catch {
    return u;
  }
}

function dedupRows(rows) {
  const byUrl = new Map();
  for (const r of rows) {
    const key = normalizeUrl(r.url);
    const prev = byUrl.get(key);
    if (!prev) {
      byUrl.set(key, { ...r, url: key, origins: [r.source] });
    } else if (!prev.origins.includes(r.source)) {
      prev.origins.push(r.source);
    }
  }
  return [...byUrl.values()];
}

export async function runSearchBattery(variants, options = {}) {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    limitPerSource = 8,
    hostCaps = DEFAULT_HOST_CAPS,
    sources = {},
  } = options;
  const exaEnabled = sources.exa?.enabled !== false;
  const scholarEnabled = sources.scholar?.enabled !== false;

  const limiters = {
    ddg: makeLimiter(hostCaps.ddg ?? DEFAULT_HOST_CAPS.ddg),
    exa: makeLimiter(hostCaps.exa ?? DEFAULT_HOST_CAPS.exa),
    github: makeLimiter(hostCaps.github ?? DEFAULT_HOST_CAPS.github),
    hn: makeLimiter(hostCaps.hn ?? DEFAULT_HOST_CAPS.hn),
    npm: makeLimiter(hostCaps.npm ?? DEFAULT_HOST_CAPS.npm),
    scholar: makeLimiter(hostCaps.scholar ?? DEFAULT_HOST_CAPS.scholar),
  };

  const tasks = [];
  const seenQueries = new Set();
  const enqueue = (host, label, fn) =>
    tasks.push(limiters[host](() => timed(label, fn, timeoutMs)));

  for (const v of variants) {
    const q = v.query;
    if (seenQueries.has(q)) continue;
    seenQueries.add(q);

    enqueue("ddg", `ddg[${v.strategy}]`, s => searchDDG(q, { limit: limitPerSource, signal: s }));
    if (exaEnabled) {
      enqueue("exa", `exa[${v.strategy}]`, s => searchExa(q, { limit: limitPerSource, signal: s }));
    }

    if (!v.strategy.startsWith("site:")) {
      enqueue("github", `gh-repo[${v.strategy}]`, s => searchGitHubRepos(q, { limit: limitPerSource, signal: s }));
      enqueue("github", `gh-code[${v.strategy}]`, s => searchGitHubCode(q, { limit: 4, signal: s }));
      enqueue("hn", `hn[${v.strategy}]`, s => searchHN(q, { limit: limitPerSource, signal: s }));
      enqueue("npm", `npm[${v.strategy}]`, s => searchNpm(q, { limit: limitPerSource, signal: s }));
      if (scholarEnabled) {
        enqueue("scholar", `scholar[${v.strategy}]`, s => searchScholar(q, { limit: limitPerSource, signal: s }));
      }
    }
  }

  const settled = await Promise.all(tasks);
  const queries_run = settled.map(s => s.source);
  const errors = settled.filter(s => s.error).map(s => ({ source: s.source, error: s.error }));
  const all = settled.flatMap(s => s.rows);
  const deduped = dedupRows(all);
  return { results: deduped, queries_run, errors };
}
