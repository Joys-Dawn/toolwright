#!/usr/bin/env node
import { openDb, statusCounts, listTopRanked } from '../lib/index.mjs';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const [, , cmd, ...rest] = process.argv;
const repoRoot = process.env.IDEAWRIGHT_REPO_ROOT ?? process.cwd();

const DEFAULTS = {
  llm: {
    // Model used for all LLM judge calls (pain validator + capability validator).
    // Override per-source under sources.<name>.llm.model.
    model: 'claude-haiku-4-5-20251001',
  },
  sources: {
    // Pipeline 1 — demand-driven (pain signals)
    reddit: {
      enabled: true,
      // Pages per sub on first scan (each page = ~100 posts).
      max_pages: 10,
      // Hard cap of posts per sub regardless of pages. null = no cap.
      max_posts_per_sub: null,
      // Override the built-in 16 idea/pain subreddits with your own list.
      // Leave null to use the defaults.
      subreddits: null,
    },
    hn: {
      enabled: true,
      // First-scan lookback window (days). After that, the cursor takes over.
      lookback_days: 60,
      // Max comments per pain query (Algolia hard cap is 1000).
      max_per_query: 100,
      // Override the built-in 8 pain phrases with your own list. null = defaults.
      queries: null,
    },
    github: {
      enabled: true,
      // First-scan lookback window (days).
      lookback_days: 14,
      // Issues per query (GitHub search hard cap is 100/page).
      max_per_query: 50,
      // Override the built-in 3 issue queries with your own list. null = defaults.
      queries: null,
    },
    // Pipeline 2 — supply-driven (new capabilities)
    arxiv: {
      enabled: true,
      categories: ['cs.AI', 'cs.LG', 'cs.CL', 'cs.CV', 'cs.IR', 'cs.DB', 'cs.SE', 'cs.HC', 'stat.ML', 'q-bio.QM'],
      require_code_url: false,
      // First-scan lookback window (days).
      lookback_days: 14,
      // Max papers fetched per category.
      max_per_query: 50,
    },
    biorxiv: {
      enabled: true,
      server: 'biorxiv',
      categories: ['bioinformatics', 'systems biology', 'synthetic biology', 'genomics', 'genetics', 'neuroscience'],
      // First-scan lookback window (days).
      lookback_days: 14,
      // Max papers fetched per scan across all pages of the bioRxiv API.
      max_per_run: 300,
    },
    pubmed: {
      enabled: true,
      // First-scan lookback window (days).
      lookback_days: 14,
      // PMIDs fetched per query (NCBI esearch retmax).
      max_per_query: 100,
      // Override the built-in 3 PubMed queries with your own list. null = defaults.
      queries: null,
    },
  },
  novelty: {
    novel_max: 2,
    niche_max: 5,
    competitor_overlap: 0.6,
    batch_size: 10,
    // Competitor classification is a simple yes/no judgement — Haiku handles
    // it well at ~10x the speed of Opus. Override to use the global
    // `llm.model` if you want Opus here too.
    llm: { model: 'claude-haiku-4-5-20251001' },
    // Search sources for novelty verification. Each can be toggled off.
    // Exa requires EXA_API_KEY env var; Scholar uses SEMANTIC_SCHOLAR_API_KEY
    // (optional — works without it at lower rate limit).
    sources: {
      exa: { enabled: true },
      github: { enabled: true },
      hn: { enabled: true },
      npm: { enabled: true },
      scholar: { enabled: true },
    },
  },
  feasibility: {
    require_code_only: true,
    require_no_capital: true,
    require_no_private_data: true,
  },
  weights: { pain: 0.3, novelty: 0.4, feasibility: 0.3 },
  digest: { top_n: 10 },
};

function loadConfig() {
  const path = join(repoRoot, '.claude', 'ideawright.json');
  if (!existsSync(path)) return DEFAULTS;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    console.error(`[ideawright] failed to parse config (${path}): ${e.message} — using defaults`);
    return DEFAULTS;
  }
}

async function main() {
  switch (cmd) {
    case 'status': return statusCmd();
    case 'config-init': return configInit(rest.includes('--force'));
    case 'scan': return runScan();
    case 'vet': return runVet();
    case 'daily': return runDaily();
    default:
      console.error('usage: ideawright <status|scan|vet|daily|config-init>');
      process.exit(1);
  }
}

function statusCmd() {
  const db = openDb({ repoRoot });
  const counts = statusCounts(db);
  const promoted = listTopRanked(db, 10);
  const out = {
    counts: Object.fromEntries(counts.map(r => [r.status, r.n])),
    top_promoted: promoted.map(({ id, title, target_user, composite_rank, novelty, feasibility }) => ({
      id, title, target_user, composite_rank,
      novelty_verdict: novelty?.verdict ?? null,
      feasibility_verdict: feasibility?.verdict ?? null,
    })),
  };
  console.log(JSON.stringify(out, null, 2));
  db.close();
}

function configInit(force) {
  const path = join(repoRoot, '.claude', 'ideawright.json');
  if (existsSync(path) && !force) {
    console.error(`${path} exists — pass --force to overwrite`);
    process.exit(1);
  }
  mkdirSync(join(repoRoot, '.claude'), { recursive: true });
  writeFileSync(path, JSON.stringify(DEFAULTS, null, 2));
  console.log(`Wrote ${path}`);
}

async function runScan({ db: externalDb } = {}) {
  const { runMiners } = await safeImport('../lib/miners/runner.mjs', 'miners');
  const db = externalDb ?? openDb({ repoRoot });
  try {
    const summary = await runMiners({ db, repoRoot });
    if (summary !== undefined) console.log(JSON.stringify(summary, null, 2));
  } finally { if (!externalDb) db.close(); }
}

async function runVet({ db: externalDb } = {}) {
  const { runNoveltyPass } = await safeImport('../lib/novelty/runner.mjs', 'novelty');
  const config = loadConfig();
  const n = { ...DEFAULTS.novelty, ...(config.novelty ?? {}) };
  const thresholds = {
    novelMax: n.novel_max,
    nicheMax: n.niche_max,
    competitorOverlap: n.competitor_overlap,
  };
  const model = n.llm?.model ?? config.llm?.model ?? null;
  const db = externalDb ?? openDb({ repoRoot });
  try {
    const sources = { ...DEFAULTS.novelty.sources, ...(n.sources ?? {}) };
    const runOpts = {
      db,
      batchSize: n.batch_size,
      thresholds,
      sources,
    };
    if (model) runOpts.model = model;
    const summary = await runNoveltyPass(runOpts);
    if (summary !== undefined) console.log(JSON.stringify(summary, null, 2));
  } finally { if (!externalDb) db.close(); }
}

async function runDaily() {
  const db = openDb({ repoRoot });
  try {
    await runScan({ db });
    await runVet({ db });
    const { runOrchestration } = await safeImport('../lib/orchestration/runner.mjs', 'orchestration');
    await runOrchestration({ db, repoRoot });
  } finally { db.close(); }
}

async function safeImport(spec, label) {
  try {
    return await import(new URL(spec, import.meta.url).href);
  } catch (e) {
    if (e.code === 'ERR_MODULE_NOT_FOUND') {
      console.error(`ideawright: ${label} module not yet built (${spec}). See ideawright/README.md.`);
      process.exit(2);
    }
    throw e;
  }
}

main().catch(e => { console.error(e); process.exit(1); });
