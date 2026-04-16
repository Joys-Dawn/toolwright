// Module A orchestrator. Exported as `runMiners({db, repoRoot})` to
// match the shape expected by scripts/ideawright.mjs.
//
// Flow:
//   1. Load config from <repoRoot>/.claude/ideawright.json (if present).
//   2. For each enabled source: load per-source cursor, run miner, get
//      back raw pain-signal observations.
//   3. Validate each observation via Haiku (judge.mjs). Valid signals
//      become candidate ideas.
//   4. Insert via db.insertIdea (status='new').
//   5. Persist cursors back to the sources table.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import * as reddit from './reddit.mjs';
import * as hn from './hn.mjs';
import * as github from './github.mjs';
import * as arxiv from './arxiv.mjs';
import * as biorxiv from './biorxiv.mjs';
import * as pubmed from './pubmed.mjs';
import { validateSignal, validateSignalBatch } from './validator.mjs';
import { computeId, getSourceCursor, insertIdea, setSourceCursor } from '../db.mjs';

export const MINERS = { reddit, hn, github, arxiv, biorxiv, pubmed };

// Miners whose signals are capability-driven (Pipeline 2: new papers / tools
// / datasets → speculative product ideas) rather than pain-driven. Used to
// pick the default source_module tag when a miner doesn't specify one.
const SUPPLY_PIPELINE = new Set(['arxiv', 'biorxiv', 'pubmed']);

const DEFAULT_CONFIG = {
  sources: {
    reddit: { enabled: true },
    hn: { enabled: true },
    github: { enabled: true },
    arxiv: { enabled: true },
    biorxiv: { enabled: true },
    pubmed: { enabled: true },
  },
};

export async function runMiners({
  db,
  repoRoot = process.cwd(),
  sources,
  perSourceLimit,
  validationConcurrency = 3,
  logger = console,
  _batchValidate,
} = {}) {
  if (!db) throw new Error('runMiners: db is required');

  const config = loadConfig(repoRoot);
  const defaultModel = config.llm?.model ?? null;
  const activeIds = (sources ?? enabledSources(config)).filter((id) => MINERS[id]);
  const skipped = (sources ?? enabledSources(config)).filter((id) => !MINERS[id]);
  for (const id of skipped) logger.warn(`[scan] no miner implemented for "${id}", skipping`);

  const summary = {
    started_at: new Date().toISOString(),
    sources: {},
    observations: 0,
    validated: 0,
    inserted: 0,
  };

  for (const id of activeIds) {
    const miner = MINERS[id];
    const cursorRow = getSourceCursor(db, id);
    const cursorsIn = parseJson(cursorRow?.notes) ?? {};
    const perSourceCfg = config.sources?.[id] ?? {};

    logger.info(`[scan:${id}] start`);
    let result;
    try {
      const opts = { cursors: cursorsIn, logger, config: perSourceCfg };
      if (perSourceLimit) {
        opts.maxPostsPerSub = perSourceLimit;
        opts.maxPerQuery = perSourceLimit;
      }
      result = await miner.mine(opts);
    } catch (err) {
      logger.error(`[scan:${id}] miner failed: ${err.message}`);
      summary.sources[id] = { error: err.message };
      continue;
    }

    const obs = result.observations ?? [];
    summary.observations += obs.length;

    // Each miner may export its own `validator` (e.g. capability-validator
    // for arxiv/biorxiv/pubmed). Fall back to the pain-signal validator.
    const validate = miner.validator ?? validateSignal;
    const model = perSourceCfg.llm?.model ?? defaultModel ?? null;
    const sourceModule = SUPPLY_PIPELINE.has(id) ? 'A-tech' : 'A';

    const batchSize = config.novelty?.batch_size ?? 10;
    const batchValidate = _batchValidate ?? miner.batchValidator ?? validateSignalBatch;
    const { validated, inserted } = await validateAndInsertBatch(
      db,
      obs,
      batchSize,
      logger,
      validate,
      { model, sourceModule, batchValidate },
    );
    summary.validated += validated;
    summary.inserted += inserted;

    setSourceCursor(db, id, {
      last_seen_id: null,
      notes: JSON.stringify(result.cursors ?? {}),
    });

    summary.sources[id] = { observations: obs.length, validated, inserted };
    logger.info(`[scan:${id}] obs=${obs.length} validated=${validated} inserted=${inserted}`);
  }

  summary.finished_at = new Date().toISOString();
  logger.info(
    `[scan] done: observations=${summary.observations} validated=${summary.validated} inserted=${summary.inserted}`,
  );
  return summary;
}

function loadConfig(repoRoot) {
  const path = join(repoRoot, '.claude', 'ideawright.json');
  if (!existsSync(path)) return DEFAULT_CONFIG;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    return DEFAULT_CONFIG;
  }
}

function enabledSources(config) {
  const out = [];
  for (const [id, cfg] of Object.entries(config.sources ?? {})) {
    if (cfg?.enabled !== false) out.push(id);
  }
  return out;
}

async function validateAndInsertBatch(db, observations, batchSize, logger, validate, opts = {}) {
  const state = { validated: 0, inserted: 0 };
  const batchFn = opts.batchValidate ?? validateSignalBatch;
  // Chunk observations into batches and send one LLM call per batch
  for (let i = 0; i < observations.length; i += batchSize) {
    const batch = observations.slice(i, i + batchSize);
    let verdicts;
    try {
      // Use batch validator (single claude -p call for the whole batch)
      verdicts = await batchFn(batch, { model: opts.model });
    } catch (err) {
      logger.warn(`[validate] batch ${i}-${i + batch.length} failed: ${err.message}, falling back to per-item`);
      // Fallback: validate individually so one bad item doesn't lose the whole batch
      verdicts = await Promise.all(
        batch.map(async (o) => {
          try { return await validate(o, { model: opts.model }); }
          catch { return { idea: null }; }
        }),
      );
    }

    for (let j = 0; j < batch.length; j++) {
      const verdict = verdicts[j];
      if (!verdict?.idea) continue;
      state.validated += 1;
      const idea = toIdea(verdict, batch[j], opts.sourceModule);
      try {
        const res = insertIdea(db, idea);
        if (res.inserted) state.inserted += 1;
      } catch (err) {
        logger.warn(`[insert] ${idea.title}: ${err.message}`);
      }
    }
  }
  return state;
}

function toIdea(verdict, obs, sourceModule = 'A') {
  const i = verdict.idea;
  const codeUrl = obs.code_url ?? null;
  const sourceUrls = codeUrl ? [obs.source_url, codeUrl] : [obs.source_url];
  return {
    id: computeId(i.title, i.target_user ?? ''),
    title: i.title,
    summary: i.summary,
    target_user: i.target_user,
    category: i.category,
    emerging_tech: i.emerging_tech ?? null,
    pain_evidence: [
      {
        source_url: obs.source_url,
        quote: obs.quote,
        pain_score_0_10: verdict.pain_score_0_10,
        engagement: obs.engagement,
        ...(codeUrl ? { code_url: codeUrl } : {}),
      },
    ],
    source_urls: sourceUrls,
    source_module: sourceModule,
    note: `miner=${obs.source}`,
  };
}

function parseJson(s) {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
