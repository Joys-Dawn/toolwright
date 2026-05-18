// Dedicated transcript-bootstrap loop, invoked by the /mindwright:seed-from-repo
// script (NOT any auto-trigger). Folds the user's local pre-install Claude Code
// transcripts into memory the SAME way live capture does: chunks each into
// `tier:'short'` rows then lets the existing dream cycle distill them.
//
// Resumability & the live-capture contract (no new primitive — `offsets` only):
//   - A session id with NO `offsets` row was never seen by live capture and is
//     genuinely pre-install → eligible to seed.
//   - A session id that already has an `offsets` row is skipped (getOffset > 0).
//   - Each transcript is processed atomically under ONE transaction that ends
//     by advancing that session's `offsets` row to the file's byte length. A
//     crash mid-transcript rolls the whole transcript back so the next run
//     redoes exactly that file — no duplication, no stranded tail. A later
//     live resume of the same session continues from where seeding left off.
//
// GOVERNING INVARIANT: `event_ts` only ever feeds recency/relevance ranking.
// This loop threads it onto seed rows but NEVER into any lifecycle query —
// drain/finalize stay on created_at, as elsewhere.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chunkTranscript } from './chunker.js';
import { transcriptsDir as defaultTranscriptsDir } from './paths.js';
import { SEED_BATCH_BUDGET_BYTES, SESSION_ID_PATTERN } from './constants.js';

// Bounded line slices so a single multi-MB transcript never builds one giant
// in-memory array. JSONL is one record per line, so line-boundary slicing
// never severs a record.
const SEED_SLICE_LINES = 500;

const JSONL_SUFFIX = '.jsonl';

// Run the bootstrap loop.
//
//   store              required — open Store handle.
//   transcriptsDir     where the *.jsonl live (env-overridable via
//                      MINDWRIGHT_CLAUDE_PROJECTS_DIR for tests).
//   batchBudgetBytes   un-consolidated short-row bytes that trigger one
//                      consolidate() between transcripts.
//   consolidate        optional async ({ store, reason }) => void driving the
//                      existing drain→retain→finalize cycle. Injected so this
//                      module stays pure/testable. When omitted the loop only
//                      ingests; a later dream pass drains via its pipeline.
//
// Returns a summary: { transcriptsScanned, transcriptsSeeded, skipped,
//                      rowsInserted, bytesIngested, consolidations }.
//   maxBytesPerInvocation  optional cap on bytes ingested in ONE call. When
//                      set, the loop stops at the next transcript boundary
//                      once this much has been ingested and reports
//                      stoppedEarly:true so the caller can re-invoke (offsets
//                      make it resumable). null → unbounded (legacy callers /
//                      tests). This is what keeps a manual seed incremental:
//                      one /mindwright:seed-from-repo handles a digestible
//                      slice, the user re-runs for the next.
export async function runSeedLoop({
  store,
  transcriptsDir = defaultTranscriptsDir(),
  batchBudgetBytes = SEED_BATCH_BUDGET_BYTES,
  consolidate = null,
  maxBytesPerInvocation = null,
} = {}) {
  const summary = {
    transcriptsScanned: 0,
    transcriptsSeeded: 0,
    skipped: 0,
    rowsInserted: 0,
    bytesIngested: 0,
    consolidations: 0,
    stoppedEarly: false,
  };

  let entries;
  try {
    entries = readdirSync(transcriptsDir);
  } catch (e) {
    // No transcript tree — nothing to bootstrap, not an error.
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
    // Only treat well-formed `<sessionId>.jsonl` as a transcript — keeps junk
    // files out of the loop.
    if (!SESSION_ID_PATTERN.test(sessionId)) continue;

    summary.transcriptsScanned++;

    // Cheap pre-check: a non-zero offset means already-seen. The
    // authoritative re-check happens INSIDE the BEGIN IMMEDIATE transaction
    // below (same cross-process check-then-act race as store#runMigrations).
    if (store.getOffset(sessionId) > 0) {
      summary.skipped++;
      continue;
    }

    const filePath = join(transcriptsDir, name);
    let raw;
    let byteLen;
    try {
      // Derive the offset from the EXACT bytes read, never a separate statSync
      // before the read: an eligible transcript may be a still-appending live
      // session, and a pre-read size would under-count if it grows in the gap,
      // so a later live resume would double-insert the tail. buf.length also
      // avoids the UTF-8 round-trip ambiguity of Buffer.byteLength on the
      // decoded string.
      const buf = readFileSync(filePath);
      byteLen = buf.length;
      if (byteLen === 0) { summary.skipped++; continue; }
      raw = buf.toString('utf8');
    } catch {
      // Unreadable / raced-away — skip, never crash the bootstrap.
      summary.skipped++;
      continue;
    }

    const lines = raw.split(/\r?\n/).filter((l) => l.length > 0);

    // One transaction per transcript under BEGIN IMMEDIATE: every chunk insert
    // AND the final offset advance commit together or not at all (crash
    // mid-file → full rollback → redone whole next run, no orphan rows), AND
    // the write lock is acquired at BEGIN so a second concurrently-run seed
    // loop cannot interleave between the offset re-check and the inserts and
    // double-insert the same transcript. Same primitive store#runMigrations
    // and consolidator#drainBatch use — not a new lock.
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
            // True historical event time (recency-only per the governing
            // invariant); null for records without one. Scope stays NULL —
            // the consolidator assigns scope at distill.
            eventTs: c.timestamp ?? null,
          });
          fileRows++;
          fileBytes += Buffer.byteLength(c.content, 'utf8');
        }
      }
      // Advance the offset by exactly the bytes we read (buf.length, no
      // stat→read gap) so a later live resume continues past what we ingested.
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

    // Bound short-term: drain→distill→finalize once enough un-consolidated
    // content piled up so it never holds the whole corpus. Boundary is
    // between transcripts (each atomic) — never mid-transcript.
    if (consolidate && accumulated >= batchBudgetBytes) {
      await consolidate({ store, reason: 'seed-loop batch budget reached' });
      summary.consolidations++;
      accumulated = 0;
    }

    // Per-invocation cap: stop at this transcript boundary once enough has
    // been ingested. Each transcript commits atomically with its offset
    // advance, so a later run resumes cleanly at the first un-offset
    // transcript. stoppedEarly tells the skill to re-invoke until a run
    // ingests nothing (the terminal "all transcripts done" signal).
    if (maxBytesPerInvocation && summary.bytesIngested >= maxBytesPerInvocation) {
      summary.stoppedEarly = true;
      break;
    }
  }

  // Flush the tail: distill whatever was seeded after the last budget cycle.
  if (consolidate && accumulated > 0 && summary.transcriptsSeeded > 0) {
    await consolidate({ store, reason: 'seed-loop final flush' });
    summary.consolidations++;
  }

  return summary;
}
