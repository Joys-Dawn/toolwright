// Module A orchestrator. Exported as `runMiners({db, repoRoot})` to
// match the shape expected by scripts/ideawright.mjs.
//
// Flow:
//   1. Load config from <repoRoot>/.claude/ideawright.json (if present).
//   2. For each enabled source (concurrently): load per-source cursor, run
//      miner, get back raw pain-signal observations.
//   3. Validate each observation via Haiku (judge.mjs). Valid signals
//      become candidate ideas. The `claude -p` calls (batch AND per-item
//      fallback) across ALL sources are bounded by a single shared limiter
//      so parallel sources can't blow the 5-hour usage cap.
//   4. Insert via db.insertIdea (status='new').
//   5. Persist cursors back to the sources table (per source, only when that
//      source had zero per-item validate errors).

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import * as reddit from './reddit.mjs';
import * as hn from './hn.mjs';
import * as github from './github.mjs';
import * as arxiv from './arxiv.mjs';
import * as biorxiv from './biorxiv.mjs';
import * as pubmed from './pubmed.mjs';
import { validateSignal, validateSignalBatch } from './validator.mjs';
import { makeLimiter } from '../novelty/limiter.mjs';
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

  const config = loadConfig(repoRoot, logger);
  const defaultModel = config.llm?.model ?? null;
  const requested = sources ?? enabledSources(config);
  const activeIds = requested.filter((id) => MINERS[id]);
  const skipped = requested.filter((id) => !MINERS[id]);
  for (const id of skipped) logger.warn(`[scan] no miner implemented for "${id}", skipping`);

  const summary = {
    started_at: new Date().toISOString(),
    sources: {},
    observations: 0,
    validated: 0,
    inserted: 0,
  };

  // Real batching: how many observations are concatenated into one
  // `claude -p` validate call. The judge pipes the prompt via stdin
  // (see lib/judge.mjs) so this is bounded by token budget / latency,
  // not by Windows' CLI arg limit. coercePositiveInt guards the
  // silent-hang case (batch_size 0 → the `i += batchSize` loop never advances).
  const batchSize = coercePositiveInt(config.validate?.batch_size, 20);

  // ONE shared limiter for the whole run. Every `claude -p`-spawning call —
  // the batch validate AND each per-item fallback call (see
  // validateAndInsertBatch) — schedules through this, so total concurrent
  // `claude` processes ≤ validationConcurrency regardless of how many sources
  // are validating in parallel. Config-tunable (mirrors validate.batch_size);
  // the runMiners param is the fallback so a caller can still override.
  // coercePositiveInt guards the silent-hang case (concurrency 0 → the
  // limiter's pump never enters and the whole pipeline stalls with no log).
  const vc = coercePositiveInt(config.validate?.concurrency, validationConcurrency);
  const limit = makeLimiter(vc);

  // One source end-to-end: mine → validate+insert → cursor pin/advance.
  // miner.mine() failures are caught and returned as { id, error } so one bad
  // source can't reject the Promise.allSettled batch. NOTE: the pre-try reads
  // below (getSourceCursor / parseJson) run BEFORE the catch, so a broken db
  // CAN still reject this promise — runMiners handles that via its settled
  // `status === 'rejected'` branch (do not delete that branch as dead code).
  async function runSource(id) {
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
      return { id, error: err.message };
    }

    const obs = result.observations ?? [];

    // Each miner may export its own `validator` (e.g. capability-validator
    // for arxiv/biorxiv/pubmed). Fall back to the pain-signal validator.
    const validate = miner.validator ?? validateSignal;
    const model = perSourceCfg.llm?.model ?? defaultModel ?? null;
    const sourceModule = SUPPLY_PIPELINE.has(id) ? 'A-tech' : 'A';
    const batchValidate = _batchValidate ?? miner.batchValidator ?? validateSignalBatch;

    const { validated, inserted, errored, skipped: skippedAlreadyValidated } = await validateAndInsertBatch(
      db,
      obs,
      batchSize,
      logger,
      validate,
      { model, sourceModule, batchValidate, limit },
    );

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

    logger.info(`[scan:${id}] obs=${obs.length} validated=${validated} inserted=${inserted} errored=${errored} skipped=${skippedAlreadyValidated}`);
    return {
      id,
      observations: obs.length,
      validated,
      inserted,
      errored,
      skipped_already_validated: skippedAlreadyValidated,
    };
  }

  // Fan out all miners concurrently — independent hosts, independent rate
  // limits. allSettled keeps order aligned with activeIds and isolates a
  // single source's failure from the rest.
  const settled = await Promise.allSettled(activeIds.map((id) => runSource(id)));

  // Deterministic assembly in declared source order — no shared-counter
  // mutation during the concurrent phase.
  for (let i = 0; i < activeIds.length; i++) {
    const id = activeIds[i];
    const s = settled[i];
    if (s.status === 'rejected') {
      // runSource catches miner errors itself, so this is an unexpected
      // internal fault; surface it the same way as a miner failure.
      const msg = s.reason?.message ?? String(s.reason);
      logger.error(`[scan:${id}] miner failed: ${msg}`);
      summary.sources[id] = { error: msg };
      continue;
    }
    const r = s.value;
    if (r.error) {
      summary.sources[id] = { error: r.error };
      continue;
    }
    summary.observations += r.observations;
    summary.validated += r.validated;
    summary.inserted += r.inserted;
    summary.sources[id] = {
      observations: r.observations,
      validated: r.validated,
      inserted: r.inserted,
      errored: r.errored,
      skipped_already_validated: r.skipped_already_validated,
    };
  }

  summary.finished_at = new Date().toISOString();
  logger.info(
    `[scan] done: observations=${summary.observations} validated=${summary.validated} inserted=${summary.inserted}`,
  );
  return summary;
}

// Coerce an untrusted-config number to a usable positive integer. config is
// raw JSON.parse output (loadConfig, no schema), so a missing, non-numeric,
// zero, or negative value must not reach makeLimiter or the `i += batchSize`
// loop in validateAndInsertBatch — either would silently hang runMiners with
// no error or log (a limiter whose pump never enters, or a loop that never
// advances). Any non-finite or < 1 value falls back to `fallback`.
function coercePositiveInt(raw, fallback) {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback;
}

function loadConfig(repoRoot, logger = console) {
  const path = join(repoRoot, '.claude', 'ideawright.json');
  if (!existsSync(path)) return DEFAULT_CONFIG;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    // Never silently swallow this: a JSON typo here reverts EVERY tunable
    // (rate limits, validate.concurrency/batch_size, enabled sources, model)
    // to defaults — the operator would see only default behavior with no
    // clue why. Warn loudly, then fall back.
    logger.warn(
      `[scan] ignoring malformed .claude/ideawright.json (${err.message}); using defaults`,
    );
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
  // Shared concurrency gate for every `claude -p`-spawning call. Defaults to
  // an identity pass-through so a direct caller without a limiter is
  // unaffected; runMiners always supplies the real shared limiter.
  const limit = opts.limit ?? ((fn) => fn());

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
      // Batch validator (single claude -p call for the whole batch), gated
      // by the shared limiter. On rejection the limiter frees the slot
      // BEFORE this throws (see limiter.mjs), so the per-item fallback below
      // schedules fresh limiter tasks — non-nested, no deadlock.
      verdicts = await limit(() => batchFn(batch.map((b) => b.obs), { model: opts.model }));
    } catch (err) {
      logger.warn(`[validate] batch ${i}-${i + batch.length} failed: ${err.message}, falling back to per-item`);
      // Fallback: validate individually so one bad item doesn't lose the
      // whole batch. Each per-item call ALSO spawns `claude` (via
      // validate→callJudge), so it must go through the SAME shared limiter —
      // otherwise the fallback (which fires on the usage-cap condition)
      // fans out batchSize×sources concurrent processes.
      verdicts = await Promise.all(
        batch.map(async ({ obs }) => {
          try { return await limit(() => validate(obs, { model: opts.model })); }
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
