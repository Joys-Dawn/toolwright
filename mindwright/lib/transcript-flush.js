// Shared transcript-flush helper: read offset → chunk new content → insert
// rows + setOffset under one transaction, owned in one place for all hooks.
//
// Returns { chunks, prevOffset, newOffset, insertedIds, error? }.
// `insertedIds` is the row ids of the just-staged pending rows; callers don't
// need to thread them anywhere (the self-echo concern is gone — pending rows
// are filtered out of every retriever's SQL) but the field stays for tests
// and ad-hoc inspection.
//
// Every chunk is staged with `pendingSessionId = sessionId`: rows are
// invisible to retrieval, drain, and cap counts until the shared
// promote-pending handler flips pending_session_id to NULL at PreCompact /
// SessionEnd, or until SessionStart's orphan sweep does it on behalf of a
// crashed session.
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
          // Stage as pending under the calling session so retrieval, drain,
          // and cap counts ignore it until the next PreCompact / SessionEnd
          // promotes it. The originating session still has this content in
          // its context window, so memory recall is unnecessary; promoting
          // only at the boundary where context is about to be lost is the
          // whole point of the staging design.
          pendingSessionId: sessionId,
        });
        // Normalize BigInt → Number so the returned ids are comparable as
        // plain numbers (Set membership, equality with retrieve() output).
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
