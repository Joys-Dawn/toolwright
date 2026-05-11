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
import {
  computeId,
  getSourceCursor,
  insertIdea,
  insertRawObservation,
  markRawObservationError,
  markRawObservationValidated,
  setSourceCursor,
  touchSourceLastRun,
} from '../db.mjs';

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

    // Real batching: how many observations are concatenated into one
    // `claude -p` validate call. The judge pipes the prompt via stdin
    // (see lib/judge.mjs) so this is bounded by token budget / latency,
    // not by Windows' CLI arg limit.
    const batchSize = config.validate?.batch_size ?? 20;
    const batchValidate = _batchValidate ?? miner.batchValidator ?? validateSignalBatch;
    const { validated, inserted, errored, skipped: skippedAlreadyValidated } = await validateAndInsertBatch(
      db,
      obs,
      batchSize,
      logger,
      validate,
      { model, sourceModule, batchValidate },
    );
    summary.validated += validated;
    summary.inserted += inserted;

    // Cursor advancement policy: only advance when this source had ZERO
    // per-item validation errors. If even one signal failed (likely the
    // 5-hour Claude usage cap), keep the cursor where it was so the next
    // run re-mines those signals once the cap resets. The raw_observations
    // table also retains them, so they're recoverable either way. Always
    // record a heartbeat (last_run_at) so operators can see when a source
    // was last attempted, even when it never advances.
    if (errored > 0) {
      touchSourceLastRun(db, id);
      logger.warn(
        `[scan:${id}] keeping cursor unchanged: ${errored} per-item validate errors `
        + `(likely upstream rate limit). Next run will re-mine.`
      );
    } else {
      setSourceCursor(db, id, {
        last_seen_id: null,
        notes: JSON.stringify(result.cursors ?? {}),
      });
    }

    summary.sources[id] = {
      observations: obs.length,
      validated,
      inserted,
      errored,
      skipped_already_validated: skippedAlreadyValidated,
    };
    logger.info(`[scan:${id}] obs=${obs.length} validated=${validated} inserted=${inserted} errored=${errored} skipped=${skippedAlreadyValidated}`);
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
  const state = { validated: 0, inserted: 0, errored: 0, skipped: 0 };
  const batchFn = opts.batchValidate ?? validateSignalBatch;

  // Persist every raw observation BEFORE validation. If validation later
  // fails (e.g., usage cap) the signal is still recoverable. Existing rows
  // already validated in a prior run carry `validated=true` so we skip them
  // here — recovery + re-mine no longer wastes LLM tokens re-judging them.
  const inserts = observations.map((o) => insertRawObservation(db, o));
  const pending = [];
  for (let i = 0; i < observations.length; i++) {
    const ins = inserts[i];
    if (!ins) continue;
    if (ins.validated) {
      state.skipped += 1;
      continue;
    }
    pending.push({ obs: observations[i], rawId: ins.id });
  }

  // Chunk observations into batches and send one LLM call per batch
  for (let i = 0; i < pending.length; i += batchSize) {
    const batch = pending.slice(i, i + batchSize);
    let verdicts;
    try {
      // Use batch validator (single claude -p call for the whole batch)
      verdicts = await batchFn(batch.map((b) => b.obs), { model: opts.model });
    } catch (err) {
      logger.warn(`[validate] batch ${i}-${i + batch.length} failed: ${err.message}, falling back to per-item`);
      // Fallback: validate individually so one bad item doesn't lose the whole batch
      verdicts = await Promise.all(
        batch.map(async ({ obs }) => {
          try { return await validate(obs, { model: opts.model }); }
          catch (e) {
            logger.warn(`[validate] per-item ${obs.source}/${obs.source_url ?? '<no-url>'} failed: ${e.message}`);
            return { idea: null, _error: e.message };
          }
        }),
      );
    }

    for (let j = 0; j < batch.length; j++) {
      const verdict = verdicts[j];
      const { obs, rawId } = batch[j];
      if (!verdict) {
        // Batch returned fewer entries than inputs (truncated output or
        // non-array wrapped to length 1). Treat as error so cursor pins
        // and the obs is retried next run instead of silently lost.
        state.errored += 1;
        markRawObservationError(db, rawId, 'batch returned no entry for this index');
        logger.warn(`[validate] batch missing entry at index ${i + j} for ${obs.source}/${obs.source_url ?? '<no-url>'}`);
        continue;
      }
      if (verdict._error) {
        state.errored += 1;
        markRawObservationError(db, rawId, verdict._error);
        continue;
      }
      if (!verdict.idea) {
        // Validation succeeded but the judge said "not a real need" — stamp
        // it as validated (with no idea_id) so we don't re-judge it next run.
        markRawObservationValidated(db, rawId, null);
        continue;
      }
      state.validated += 1;
      const idea = toIdea(verdict, obs, opts.sourceModule);
      try {
        const res = insertIdea(db, idea);
        if (res.inserted) state.inserted += 1;
        markRawObservationValidated(db, rawId, idea.id);
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
