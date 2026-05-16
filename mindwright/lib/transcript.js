// Streaming JSONL reader keyed by byte offset.
//
// The chunker uses this in two modes:
//   - bootstrap pass over a full transcript (fromOffset=0)
//   - incremental tail pass from a stored per-session offset to EOF
//
// Guarantees:
//   - Missing file ⇒ { records: [], newOffset: 0 } (no throw).
//   - Truncation / rotation (fromOffset > file size) ⇒ restart from 0.
//   - Corrupted *trailing* line (no terminating \n) is not parsed AND newOffset
//     is NOT advanced past it, so a later call sees the line whole once the
//     writer flushes the rest of it.
//   - Corrupted *interior* line (fully terminated but invalid JSON) is dropped
//     silently and newOffset advances past it — single bad lines do not block
//     forward progress.

import fs from 'node:fs';

// Per-pass read cap. Hard ceiling on the single Buffer.alloc / readSync call —
// a multi-GB transcript opened with MINDWRIGHT_SEED_TRANSCRIPT=1 would
// otherwise allocate that whole range at once. With the cap, the chunker
// makes forward progress chunk-by-chunk; the next flush picks up where this
// pass left off. 16 MiB is comfortably above any single JSONL line we'd
// realistically see and small enough that the alloc + sync read fits in a
// PreToolUse hook's budget.
export const MAX_READ_PER_PASS = 16 * 1024 * 1024;

export function readSinceOffset(filepath, fromOffset, { maxReadPerPass = MAX_READ_PER_PASS } = {}) {
  let stat;
  try {
    stat = fs.statSync(filepath);
  } catch (err) {
    if (err && err.code === 'ENOENT') return { records: [], newOffset: 0 };
    throw err;
  }

  const size = stat.size;

  // Normalize offset: anything outside [0, size] means the file rotated or the
  // caller passed garbage. Either way, start from 0 — re-ingesting is cheaper
  // than dropping content.
  let from = fromOffset;
  if (typeof from !== 'number' || !Number.isFinite(from) || from < 0 || from > size) {
    from = 0;
  }

  if (from >= size) return { records: [], newOffset: size };

  const fd = fs.openSync(filepath, 'r');
  let records;
  let committedBytes;
  try {
    // Cap the read to maxReadPerPass so a multi-GB seed doesn't OOM the
    // hook. The terminated-line accounting below ensures committedBytes
    // never advances past the last '\n', so even if a partial line straddles
    // the cap, the next pass picks it up cleanly.
    const len = Math.min(size - from, maxReadPerPass);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, from);
    const text = buf.toString('utf8');

    // text.split('\n') yields fragments. If the buffer ended with '\n' the last
    // fragment is '' (terminator seen, no trailing partial). Otherwise the last
    // fragment is the partial trailing line, which we must NOT commit.
    const fragments = text.split('\n');

    records = [];
    committedBytes = 0;
    for (let i = 0; i < fragments.length; i++) {
      const frag = fragments[i];
      const isLast = i === fragments.length - 1;

      if (isLast) {
        // Either '' (file ended with \n; nothing to do) or a partial trailing
        // line we deliberately leave uncommitted.
        break;
      }

      // Interior line: fully terminated. Try to parse; on parse failure drop
      // silently but DO advance past it.
      const line = frag;
      if (line.length > 0) {
        try {
          const obj = JSON.parse(line);
          if (obj && typeof obj === 'object') records.push(obj);
        } catch {
          // Invalid JSON on a terminated line — drop and keep going.
        }
      }
      // Buffer.byteLength counts the actual UTF-8 byte length of the fragment.
      committedBytes += Buffer.byteLength(line, 'utf8') + 1; // +1 for the '\n'
    }

    // Oversized-line escape valve: we read up to the cap, saw no newline at all,
    // and there's more file beyond. A single JSONL record (giant tool result,
    // pasted file dump, pathological thinking block) is bigger than the cap.
    // Without this guard, committedBytes stays 0 and every subsequent pass
    // re-reads the same prefix forever, permanently blocking transcript
    // ingest. Advance past the cap so future passes resume after the offending
    // span — iterating skip-by-skip until the next '\n' is consumed. The
    // oversized record's content is lost (it cannot be parsed without
    // allocating its full size anyway), but ingest unblocks.
    if (committedBytes === 0 && fragments.length === 1 && len === maxReadPerPass && from + len < size) {
      process.stderr.write(
        `[mindwright/transcript] skipping ${len}-byte span starting at offset ${from}: ` +
        `no newline found within cap (oversized JSONL record). Ingest resumes after the skip.\n`
      );
      committedBytes = len;
    }
  } finally {
    fs.closeSync(fd);
  }

  return {
    records,
    newOffset: from + committedBytes,
  };
}
