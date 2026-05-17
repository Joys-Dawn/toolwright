// Streaming JSONL reader keyed by byte offset (bootstrap pass or incremental
// tail pass). Guarantees:
//   - Missing file ⇒ { records: [], newOffset: 0 } (no throw).
//   - fromOffset > size (truncation/rotation) ⇒ restart from 0.
//   - Corrupted *trailing* line (no \n): not parsed, newOffset NOT advanced —
//     a later call sees it whole once the writer flushes the rest.
//   - Corrupted *interior* line (terminated, invalid JSON): dropped, newOffset
//     advances — single bad lines don't block forward progress.

import fs from 'node:fs';

// Per-pass read cap on the single Buffer.alloc/readSync, so a multi-GB seeded
// transcript doesn't allocate the whole range at once; progress is chunk-by-
// chunk. 16 MiB is above any realistic JSONL line and fits a hook's budget.
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

  // Offset outside [0, size] ⇒ rotation/garbage; restart from 0 (re-ingesting
  // is cheaper than dropping content).
  let from = fromOffset;
  if (typeof from !== 'number' || !Number.isFinite(from) || from < 0 || from > size) {
    from = 0;
  }

  if (from >= size) return { records: [], newOffset: size };

  const fd = fs.openSync(filepath, 'r');
  let records;
  let committedBytes;
  try {
    // Capped so a multi-GB seed doesn't OOM the hook; committedBytes never
    // passes the last '\n', so a line straddling the cap is picked up next pass.
    const len = Math.min(size - from, maxReadPerPass);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, from);
    const text = buf.toString('utf8');

    // Last fragment is '' (buffer ended with '\n') or a partial trailing line
    // we must NOT commit.
    const fragments = text.split('\n');

    records = [];
    committedBytes = 0;
    for (let i = 0; i < fragments.length; i++) {
      const frag = fragments[i];
      const isLast = i === fragments.length - 1;

      if (isLast) {
        // '' or a partial trailing line — leave uncommitted.
        break;
      }

      // Interior line: terminated. Parse failure drops silently but DOES
      // advance past it.
      const line = frag;
      if (line.length > 0) {
        try {
          const obj = JSON.parse(line);
          if (obj && typeof obj === 'object') records.push(obj);
        } catch {
          // Invalid JSON on a terminated line — drop and keep going.
        }
      }
      committedBytes += Buffer.byteLength(line, 'utf8') + 1; // +1 for the '\n'
    }

    // Oversized-line escape valve: cap hit, no newline, more file beyond ⇒ a
    // single record exceeds the cap. Without this committedBytes stays 0 and
    // every pass re-reads the same prefix forever. Advance past the cap
    // (content lost — unparseable without its full size — but ingest unblocks).
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
