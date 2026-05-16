// Dedicated transcript-bootstrap loop.
//
// On a fresh install into an existing project, the user's local Claude Code
// transcripts (`~/.claude/projects/<encoded-cwd>/*.jsonl`) are a rich history
// that organic live-capture never saw. This loop folds that history into
// memory the SAME way live capture does: it chunks each pre-install transcript
// into `tier:'short', kind:'seed'` rows (durable `<basename>:<uuid>` source_ref,
// `event_ts` from each JSONL record's real `timestamp`), then lets the EXISTING
// dream cycle distill them — it does NOT reimplement distillation.
//
// It is deliberately SEPARATE from the cap-50 Stop-hook nudge: that path only
// fires when MINDWRIGHT_NUDGE!=='off' and only once short-term crosses the
// cap; a fresh empty install has zero rows so it would never bootstrap. This
// loop is its own bounded, resumable short→drain→finalize driver.
//
// Resumability & the live-capture contract (no new primitive — `offsets` only):
//   - A transcript whose session id has NO `offsets` row was never seen by
//     live capture (SessionStart sets the offset to EOF for live sessions) and
//     is genuinely pre-install → eligible to seed.
//   - A transcript whose session id already has an `offsets` row (live session,
//     or one this loop finished on a prior run) is skipped — `getOffset` > 0.
//   - Each transcript is processed atomically under ONE transaction that ends
//     by advancing that session's `offsets` row to the file's byte length. A
//     crash mid-transcript rolls the whole transcript back (no `offsets` row,
//     no committed rows) so the next run redoes exactly that file — no
//     duplication, no stranded tail. A later LIVE resume of the same session
//     continues from where seeding left off (coherent, not a collision).
//
// GOVERNING INVARIANT: `event_ts` only ever feeds recency/relevance ranking.
// This loop threads it onto seed rows (recency) but NEVER into any lifecycle
// query — drain/finalize stay on created_at, exactly as elsewhere.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chunkTranscript } from './chunker.js';
import { transcriptsDir as defaultTranscriptsDir } from './paths.js';
import { SEED_BATCH_BUDGET_BYTES, SESSION_ID_PATTERN } from './constants.js';

// Chunk each transcript in bounded line slices so a single multi-MB transcript
// never builds one giant in-memory records/chunks array. JSONL is exactly one
// record per line, so slicing on line boundaries never severs a record.
const SEED_SLICE_LINES = 500;

const JSONL_SUFFIX = '.jsonl';

// Run the bootstrap loop.
//
//   store              required — open Store handle.
//   transcriptsDir     where the *.jsonl live; defaults to paths.transcriptsDir()
//                      (env-overridable via MINDWRIGHT_CLAUDE_PROJECTS_DIR for tests).
//   batchBudgetBytes   cumulative un-consolidated short-row bytes that trigger
//                      one consolidate() between transcripts. Default tunable
//                      constant SEED_BATCH_BUDGET_BYTES.
//   consolidate        optional async ({ store, reason }) => void. The
//                      "(consolidator distills)" step — drives the EXISTING
//                      drain→retain→finalize cycle. Injected so this module
//                      stays pure/testable and the LLM work lives where it
//                      already lives (the dream skill / hand-driven in tests).
//                      When omitted, the loop only ingests; the Step-11
//                      auto-spawned /mindwright:dream drains via its normal
//                      pipeline.
//
// Returns a summary: { transcriptsScanned, transcriptsSeeded, skipped,
//                      rowsInserted, bytesIngested, consolidations }.
export async function runSeedLoop({
  store,
  transcriptsDir = defaultTranscriptsDir(),
  batchBudgetBytes = SEED_BATCH_BUDGET_BYTES,
  consolidate = null,
} = {}) {
  const summary = {
    transcriptsScanned: 0,
    transcriptsSeeded: 0,
    skipped: 0,
    rowsInserted: 0,
    bytesIngested: 0,
    consolidations: 0,
  };

  let entries;
  try {
    entries = readdirSync(transcriptsDir);
  } catch (e) {
    // No transcript tree for this project (the common case on a brand-new
    // machine) — nothing to bootstrap, not an error.
    if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return summary;
    throw e;
  }

  // Deterministic order so a resumed run revisits files in the same sequence
  // and tests are stable.
  const files = entries
    .filter((n) => n.endsWith(JSONL_SUFFIX))
    .sort();

  let accumulated = 0; // un-consolidated short bytes since the last consolidate

  for (const name of files) {
    const sessionId = name.slice(0, -JSONL_SUFFIX.length);
    // Defensive: only treat well-formed `<sessionId>.jsonl` as a transcript.
    // sessionId flows into offsets/insertEntry as a bound param (not a path),
    // but matching the project-wide pattern keeps junk files out of the loop.
    if (!SESSION_ID_PATTERN.test(sessionId)) continue;

    summary.transcriptsScanned++;

    // Cheap pre-check: a non-zero offset means already-seen (live-capture
    // touched it, or a prior run finished it). Genuinely pre-install
    // transcripts have no offsets row → getOffset returns 0. This read is
    // kept ONLY to know which files are candidates to attempt at all — the
    // authoritative re-check happens INSIDE the BEGIN IMMEDIATE transaction
    // below, exactly as lib/store.js#runMigrations does for the identical
    // cross-process check-then-act race.
    if (store.getOffset(sessionId) > 0) {
      summary.skipped++;
      continue;
    }

    const filePath = join(transcriptsDir, name);
    let raw;
    let byteLen;
    try {
      // Read once, as a Buffer, and derive the offset from the EXACT bytes
      // read — never from a separate statSync taken before the read. An
      // eligible transcript (no offsets row) is not guaranteed dead: it can
      // be a session that was already running when mindwright was installed
      // and is still appending. A size captured before readFileSync would
      // under-count if the file grows in that gap — the loop would chunk the
      // whole grown `raw` but record the smaller pre-read size, so a later
      // live resume re-reads [staleSize, EOF] and double-inserts the tail.
      // buf.length is precisely the bytes we read and chunked, so the
      // recorded offset and the ingested content can never disagree (and no
      // UTF-8 round-trip ambiguity, unlike Buffer.byteLength on the decoded
      // string for a record with replacement chars).
      const buf = readFileSync(filePath);
      byteLen = buf.length;
      if (byteLen === 0) { summary.skipped++; continue; }
      raw = buf.toString('utf8');
    } catch {
      // Unreadable / raced-away transcript — skip it, never crash the whole
      // bootstrap over one bad file.
      summary.skipped++;
      continue;
    }

    const lines = raw.split(/\r?\n/).filter((l) => l.length > 0);

    // One transaction per transcript under BEGIN IMMEDIATE: every chunk
    // insert AND the final offset advance commit together or not at all
    // (crash mid-file → full rollback → redone whole next run, no orphan
    // rows), AND the write lock is acquired at BEGIN so a second
    // concurrently-spawned seed loop cannot interleave between the offset
    // re-check and the inserts. The auto-trigger
    // (hooks/session-start.js#main → lib/seed-trigger.js#maybeAutoSeed) has no
    // single-flight: two SessionStarts in the same fresh project before the
    // first seeded row commits both pass shouldAutoSeed (memory still empty)
    // and both detach a seed loop. Without BEGIN IMMEDIATE + an in-txn offset
    // re-read, both
    // observe getOffset()==0 for the same transcript and double-insert it.
    // This is the SAME primitive lib/store.js#runMigrations and
    // lib/consolidator.js#drainBatch use for the same race — not a new lock.
    const txn = store.db.transaction(() => {
      // Source-of-truth re-check: a peer seed loop may have committed this
      // transcript while we were blocked on the write lock. If so it is
      // already represented — insert nothing, signal the skip.
      if (store.getOffset(sessionId) > 0) {
        return { raced: true, fileRows: 0, fileBytes: 0 };
      }
      const toolMap = new Map(); // tool_use_id → name, session-scoped
      let fileRows = 0;
      let fileBytes = 0;
      for (let i = 0; i < lines.length; i += SEED_SLICE_LINES) {
        const slice = lines.slice(i, i + SEED_SLICE_LINES);
        const chunks = chunkTranscript(slice, toolMap, { sourceFile: name });
        for (const c of chunks) {
          store.insertEntry({
            tier: 'short',
            kind: c.kind,
            content: c.content,
            sourceRef: c.source_ref,
            sessionId,
            // True historical event time from the JSONL record (chunker sets
            // c.timestamp from rec.timestamp; null for records without one,
            // e.g. bus events). Recency-only per the governing invariant.
            // Scope stays NULL (short-tier) — raw transcripts carry no
            // reconstructable role, so the loop never produces role:-scoped
            // rows; the consolidator assigns user/project scope at distill.
            eventTs: c.timestamp ?? null,
          });
          fileRows++;
          fileBytes += Buffer.byteLength(c.content, 'utf8');
        }
      }
      // Advance this session's offset by exactly the bytes we read and
      // chunked (buf.length, captured from the read itself — no stat→read
      // gap). Coherent with live capture: a later live resume of this very
      // session continues from precisely past what we ingested, never
      // re-reading a tail the seed loop already inserted.
      store.setOffset(sessionId, byteLen);
      return { raced: false, fileRows, fileBytes };
    });
    // .immediate() → BEGIN IMMEDIATE: take the write lock at BEGIN so the
    // in-txn getOffset re-read never races a peer's uncommitted inserts.
    const { raced, fileRows, fileBytes } = txn.immediate();

    if (raced) {
      summary.skipped++;
      continue;
    }

    summary.transcriptsSeeded++;
    summary.rowsInserted += fileRows;
    summary.bytesIngested += fileBytes;
    accumulated += fileBytes;

    // Bound short-term: once enough un-consolidated content has piled up,
    // run one drain→distill→finalize cycle before continuing so short-term
    // never holds the whole corpus. Boundary is between transcripts (each is
    // atomic) — never mid-transcript.
    if (consolidate && accumulated >= batchBudgetBytes) {
      await consolidate({ store, reason: 'seed-loop batch budget reached' });
      summary.consolidations++;
      accumulated = 0;
    }
  }

  // Flush the tail: distill whatever was seeded after the last budget cycle.
  if (consolidate && accumulated > 0 && summary.transcriptsSeeded > 0) {
    await consolidate({ store, reason: 'seed-loop final flush' });
    summary.consolidations++;
  }

  return summary;
}
