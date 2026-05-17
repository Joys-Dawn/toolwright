// Idempotent per-session transcript offset initializer. Defaults an unknown
// session to current EOF (don't retroactively ingest pre-mindwright history)
// unless MINDWRIGHT_SEED_TRANSCRIPT=1.
//
// Gate on store.hasOffsetRow() (existence), NOT getOffset()===0: getOffset()
// returns 0 for both "no row" and "a deliberately-0 seed session", so a
// value gate would re-fire every flush. Every branch writes a row, so the
// existence gate fires exactly once.
//
// HARD DEP-FREE RULE: node:fs builtins + a `store` param ONLY.

import { existsSync, statSync, createReadStream } from 'node:fs';

// Prior transcript longer than this triggers the resumed-session warning.
export const RESUMED_SESSION_WARN_BYTES = 4096;

// Streamed so we don't allocate a multi-MB buffer for a single integer.
// Best-effort: any read failure resolves null and the warning falls back to bytes.
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

// Initialize the offset for a never-decided session, returning
// { initialized, message }.
//
// SYNCHRONOUS-CORE CONTRACT: every store.setOffset() write happens BEFORE the
// single `await`, so a synchronous caller that does NOT await this still gets
// the offset committed before its next getOffset(). Do not move a setOffset
// below the await.
export async function initOffsetIfUnknown({ store, sessionId, transcriptPath }) {
  // typeof guard precedes existsSync: passing a non-string to existsSync is
  // deprecated (DEP0187) and slated to throw in a future Node.
  if (!sessionId || typeof transcriptPath !== 'string' || !transcriptPath || !existsSync(transcriptPath)) {
    return { initialized: false, message: null };
  }
  // Existence latch: a row already exists ⇒ decision already made.
  if (store.hasOffsetRow(sessionId)) {
    return { initialized: false, message: null };
  }
  let size;
  try {
    size = statSync(transcriptPath).size;
  } catch {
    // stat failed — leave uninitialized; a later pass retries.
    return { initialized: false, message: null };
  }
  const optIn = process.env.MINDWRIGHT_SEED_TRANSCRIPT === '1';

  // Opt-in check precedes the EOF-default so seeding can't be silently
  // defeated by EOF-skipping the history it exists to ingest.
  if (optIn && size > 0) {
    // Leave offset at 0 (chunk from the top) but WRITE the row to latch.
    store.setOffset(sessionId, 0);
    return {
      initialized: true,
      message: `MINDWRIGHT_SEED_TRANSCRIPT=1 — ingesting prior transcript (${size} bytes) on next tool call`,
    };
  }

  if (size === 0) {
    // Empty transcript, not opting in: nothing to skip, but still latch.
    store.setOffset(sessionId, 0);
    return { initialized: true, message: null };
  }

  // Non-opt-in unknown session: default to EOF so we do NOT retroactively
  // ingest pre-mindwright history.
  store.setOffset(sessionId, size);
  if (size <= RESUMED_SESSION_WARN_BYTES) {
    return { initialized: true, message: null };
  }
  // Offset already committed above; only past here is async. Warn that
  // pre-existing history was skipped and how to ingest it.
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
