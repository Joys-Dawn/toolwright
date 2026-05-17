// Trigger-agnostic, idempotent per-session transcript offset initializer.
//
// WHY THIS EXISTS (behavior-1): the "default an unknown session's offset to
// current EOF (so we don't retroactively ingest pre-mindwright history) and
// warn the user unless MINDWRIGHT_SEED_TRANSCRIPT=1" decision used to live
// ONLY in hooks/session-start-impl.js. SessionStart is dormant on a deps-less
// first run (the hook-shim split keeps the native impl behind the readiness
// gate), so on the documented fresh-install flow the decision never ran — and
// the FIRST deps-present flush then saw getOffset()===0 and chunked the entire
// pre-mindwright transcript into short-term. The fix: extract the decision
// here so BOTH SessionStart (eager) and the first transcript flush (backstop)
// can run it, idempotently, regardless of which entrypoint first sees the
// session.
//
// THE LATCH (the subtle part): getOffset() returns 0 for BOTH "no row" and "a
// row whose last_read_byte is deliberately 0" (a fresh MINDWRIGHT_SEED_TRANSCRIPT
// session). Gating on getOffset()===0 would therefore re-fire every flush and
// silently re-emit the opt-in message forever. We gate on store.hasOffsetRow()
// (existence, not value): the initializer writes an offsets row on EVERY branch
// it can take — including an explicit setOffset(sid,0) on the fresh-opt-in
// branch, which the original session-start code did NOT do — so after the
// first call hasOffsetRow() is true and the gate never re-fires. Exactly-once
// by construction: no double-warn, no re-ingest loop, and zero behavior change
// on the steady-state (already-tracked, row present) live-capture path, which
// the gate turns into an immediate no-op.
//
// Because the gate is hasOffsetRow(), a session that ALREADY has a row is a
// no-op here. That subsumes the original session-start "non-opt-in + already
// tracked → do nothing" steady-state path (preserved exactly) AND the original
// "opt-in + already tracked → reset to 0 and re-ingest" path. The latter is
// deliberately NOT replicated: it resets the offset to 0 every time it runs,
// which is safe exactly once (SessionStart runs once per session) but is an
// unbounded re-ingest loop when run from the per-flush backstop. The existence
// latch is what makes the shared, multi-entrypoint helper safe; an idempotent
// "re-opt-in an already-tracked session" would need separate per-session state
// and is out of scope for behavior-1. /mindwright:dream + a fresh session
// remain the way to re-ingest an already-tracked transcript.
//
// HARD DEP-FREE RULE: node:fs builtins + a `store` param ONLY. This module is
// reached from lib/transcript-flush.js (itself reached from the hook impls)
// and from hooks/session-start-impl.js; it must never pull a native dep.

import { existsSync, statSync, createReadStream } from 'node:fs';

// Any prior transcript longer than this triggers the "first time meeting a
// resumed session" warning. A handful of empty turns produces less than this;
// anything past it is meaningful prior conversation. (Relocated verbatim from
// hooks/session-start-impl.js together with countTranscriptRecords.)
export const RESUMED_SESSION_WARN_BYTES = 4096;

// Count newline-delimited records in a JSONL transcript. Streams the file so
// we don't allocate a multi-MB buffer for what is conceptually a single
// integer — this helper only fires when size > RESUMED_SESSION_WARN_BYTES, so
// the transcripts it sees are always at least 4 KB and frequently much larger.
// Best-effort: any read failure resolves to null and the warning falls back to
// bytes only. (Relocated verbatim from hooks/session-start-impl.js; the only
// importers were that file and test/count-transcript-records.test.js.)
export function countTranscriptRecords(transcriptPath) {
  return new Promise((resolve) => {
    let n = 0;
    let settled = false;
    const stream = createReadStream(transcriptPath);
    stream.on('data', (chunk) => {
      for (let i = 0; i < chunk.length; i++) {
        if (chunk[i] === 0x0a) n++;
      }
    });
    stream.on('end', () => {
      if (!settled) { settled = true; resolve(n); }
    });
    stream.on('error', () => {
      if (!settled) { settled = true; resolve(null); }
    });
  });
}

// Initialize the offset for a session mindwright has never made a decision for,
// returning { initialized, message }. `message` (string|null) is the exact
// additionalContext line SessionStart used to build inline — callers surface
// it however they already surface context (SessionStart: additionalContext;
// the flush backstop: best-effort log).
//
// SYNCHRONOUS-CORE CONTRACT: every store.setOffset() write happens BEFORE the
// single `await` (countTranscriptRecords, only for the size>WARN message).
// An async function runs its body synchronously up to the first await, so a
// SYNCHRONOUS caller (lib/transcript-flush.js) that does NOT await this still
// gets the offset committed before it reads getOffset() on the next line —
// only the returned message Promise resolves later (and the flush path treats
// the message as best-effort). Do not move a setOffset below the await.
export async function initOffsetIfUnknown({ store, sessionId, transcriptPath }) {
  // ---- synchronous correctness core (completes before any await) ----
  // typeof guard precedes existsSync: in production transcriptPath is always a
  // string (the hook payload's transcript_path) or absent, but the flush
  // backstop is also exercised with a deliberately non-string path (a test
  // forces the chunker's statSync to throw ERR_INVALID_ARG_TYPE that way). A
  // non-string can't be a valid path, so the backstop must no-op and let the
  // chunker reject it exactly as it did pre-Step-7 — and passing a non-string
  // to existsSync is deprecated (DEP0187) and slated to throw in a future Node.
  if (!sessionId || typeof transcriptPath !== 'string' || !transcriptPath || !existsSync(transcriptPath)) {
    return { initialized: false, message: null };
  }
  // The existence latch. A row already exists ⇒ mindwright has already made an
  // offset decision for this session (SessionStart ran, or an earlier flush
  // backstop ran, or it is genuinely tracked). Idempotent no-op — this is also
  // the steady-state live-capture path, byte-identical to pre-Step-7.
  if (store.hasOffsetRow(sessionId)) {
    return { initialized: false, message: null };
  }
  let size;
  try {
    size = statSync(transcriptPath).size;
  } catch {
    // stat failed — leave the session uninitialized; a later pass retries.
    return { initialized: false, message: null };
  }
  const optIn = process.env.MINDWRIGHT_SEED_TRANSCRIPT === '1';

  // SILENT-BREAK GUARD: the opt-in check precedes — and returns before — the
  // EOF-default below, so MINDWRIGHT_SEED_TRANSCRIPT=1 can NEVER be silently
  // defeated by EOF-skipping the very history the flag exists to ingest.
  if (optIn && size > 0) {
    // Fresh opt-in: leave the offset at 0 so the next flush chunks the whole
    // file from the top — but WRITE the row (the original session-start code
    // wrote none here, which is exactly why the latch did not hold). getOffset
    // returns 0 whether the row is absent or present-with-value-0, so
    // chunk-from-0 is preserved; the only new effect is the latch reads true.
    store.setOffset(sessionId, 0);
    return {
      initialized: true,
      message: `MINDWRIGHT_SEED_TRANSCRIPT=1 — ingesting prior transcript (${size} bytes) on next tool call`,
    };
  }

  if (size === 0) {
    // Empty transcript, not opting in: nothing to skip, but still latch so the
    // backstop is exactly-once (EOF here is 0 anyway).
    store.setOffset(sessionId, 0);
    return { initialized: true, message: null };
  }

  // Non-opt-in, unknown session: default to current EOF so we do NOT
  // retroactively ingest pre-mindwright history (the behavior-1 fix).
  store.setOffset(sessionId, size);
  if (size <= RESUMED_SESSION_WARN_BYTES) {
    // No message for the silent fresh-session case — initializing the offset
    // to EOF is internal bookkeeping with no value to Claude or the user.
    return { initialized: true, message: null };
  }
  // ---- only past here is async; the offset is ALREADY committed above ----
  // Resumed session mindwright is meeting for the first time. Be explicit so
  // the user knows their pre-existing history was deliberately skipped and how
  // to ingest it. Record count gives a much better intuition than raw bytes.
  const recordCount = await countTranscriptRecords(transcriptPath);
  const sizeDesc = recordCount == null ? `${size} bytes` : `${size} bytes / ~${recordCount} records`;
  return {
    initialized: true,
    message:
      `note: this transcript already contains ${sizeDesc} from before mindwright was tracking it. ` +
      `Set MINDWRIGHT_SEED_TRANSCRIPT=1 and restart this session to ingest the prior content; ` +
      `otherwise only new turns from here on are chunked into short-term.`,
  };
}
