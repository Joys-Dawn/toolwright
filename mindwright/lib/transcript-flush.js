// Shared transcript-flush helper: read offset → chunk new content → insert
// rows + setOffset under one transaction, owned in one place for all hooks.
//
// Returns { chunks, prevOffset, newOffset, insertedIds, error? }.
// `insertedIds` is passed to retrieve() as excludeIds so just-flushed content
// can't echo back as its own recall candidate.
//
// NEVER throws — sets `error` so the caller emits its `{}` no-op. A flush
// failure must not crash the session.

import { chunkStreaming } from './chunker.js';
import { initOffsetIfUnknown } from './offset-init.js';
import { logHookError } from './hook-log.js';

export function flushTranscript({ store, sessionId, transcriptPath }) {
  // Offset-init backstop. MUST run before getOffset(): SessionStart is dormant
  // on a deps-less first run, so without this the first deps-present flush
  // would see offset 0 and chunk the ENTIRE pre-mindwright transcript.
  // initOffsetIfUnknown commits its setOffset synchronously, so the offset is
  // correct on the getOffset() line even though we don't await here; the
  // Promise carries only the best-effort notice. Idempotent via the
  // hasOffsetRow latch. Fully guarded — a backstop failure must never break
  // the never-throws contract (an async fn surfaces a sync throw as a
  // rejected Promise, so the .then onRejected is what actually swallows it;
  // the try/catch is belt-and-suspenders).
  try {
    const p = initOffsetIfUnknown({ store, sessionId, transcriptPath });
    if (p && typeof p.then === 'function') {
      p.then(
        (r) => {
          if (r && r.message) {
            try { logHookError('transcript-flush', 'offset-init notice', r.message); } catch { /* stderr gone */ }
          }
        },
        () => { /* notice is best-effort; the correctness setOffset already committed synchronously */ },
      );
    }
  } catch {
    /* backstop is best-effort; the flush proceeds from whatever offset exists */
  }

  let prevOffset = 0;
  let toolMap;
  try {
    prevOffset = store.getOffset(sessionId);
    // Loaded read-only here, mutated by chunkStreaming, persisted inside the
    // write transaction so the offset advance and the tool_use_ids land or
    // roll back together.
    toolMap = store.loadToolMap(sessionId);
  } catch (e) {
    return { chunks: [], prevOffset: 0, newOffset: 0, error: e };
  }

  let chunks;
  let newOffset;
  try {
    const out = chunkStreaming(transcriptPath, prevOffset, toolMap);
    chunks = out.chunks;
    newOffset = out.newOffset;
  } catch (e) {
    return { chunks: [], prevOffset, newOffset: prevOffset, error: e };
  }

  if (chunks.length === 0 && newOffset === prevOffset) {
    // No chunks, but the chunker may have learned tool_use_ids — persist them.
    try {
      store.saveToolMap(sessionId, toolMap);
    } catch {
      // best-effort — saveToolMap failure shouldn't crash the hook
    }
    return { chunks, prevOffset, newOffset, insertedIds: [] };
  }

  const insertedIds = [];
  try {
    const writeTx = store.db.transaction(() => {
      for (const c of chunks) {
        const id = store.insertEntry({
          tier: 'short',
          kind: c.kind,
          content: c.content,
          sourceRef: c.source_ref,
          sessionId,
          // Provenance time from the JSONL record (null for records without
          // one); lets the seed loop carry true historical event time
          // instead of collapsing every row to seed-run time.
          eventTs: c.timestamp ?? null,
        });
        // Normalize BigInt → Number so callers can use a Set (BigInt and
        // Number compare false in Set membership even for equal values).
        insertedIds.push(typeof id === 'bigint' ? Number(id) : id);
      }
      store.setOffset(sessionId, newOffset);
      store.saveToolMap(sessionId, toolMap);
    });
    writeTx();
  } catch (e) {
    return { chunks, prevOffset, newOffset, insertedIds: [], error: e };
  }

  return { chunks, prevOffset, newOffset, insertedIds };
}
