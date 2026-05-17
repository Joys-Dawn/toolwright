// Shared transcript-flush helper. The five hook scripts all need the same
// "read offset → chunk new content → insert rows + setOffset under one
// transaction" pattern. Owning that loop in one place means a future change
// (new chunk field, retry policy, per-row metadata) touches one file
// instead of four.
//
// Returns:
//   { chunks, prevOffset, newOffset, insertedIds, error? }
//
// `insertedIds` is the list of row ids the chunker just wrote — UPS and
// PreToolUse pass it to retrieve() as `excludeIds` so the just-flushed
// cli_prompt / thinking can't echo back as their own recall candidate (see
// retriever.js's excludeIds note for the failure mode).
//
// On any failure the function never throws — it sets `error` so the caller
// can log + emit the hook's no-op `{}` envelope and exit cleanly. Hooks
// should NOT crash the session over a flush failure.

import { chunkStreaming } from './chunker.js';
import { initOffsetIfUnknown } from './offset-init.js';
import { logHookError } from './hook-log.js';

export function flushTranscript({ store, sessionId, transcriptPath }) {
  // Trigger-agnostic offset-init backstop (behavior-1). MUST run before the
  // getOffset() below: SessionStart is dormant on a deps-less first run, so on
  // the documented fresh-install flow it never made the offset decision — and
  // without this the first deps-present flush would see getOffset()===0 and
  // chunk the ENTIRE pre-mindwright transcript into short-term. initOffsetIfUnknown
  // commits its setOffset SYNCHRONOUSLY (every write is before its single
  // await — see its synchronous-core contract), so the offset is already
  // correct on the getOffset() line even though flushTranscript is sync and
  // does not await here; the returned Promise carries only the best-effort
  // resumed-session notice. Idempotent via the hasOffsetRow existence latch ⇒
  // an immediate no-op on every already-tracked session ⇒ byte-identical to
  // pre-Step-7 on the steady-state live-capture path. FULLY GUARDED: a backstop
  // failure must NEVER crash the flush — the never-throws → {error} contract is
  // this helper's load-bearing promise to all five hook callers. (An async
  // fn surfaces a sync throw as a rejected Promise, not a sync throw, so the
  // .then onRejected is what actually swallows e.g. a fake/missing-method
  // store; the try/catch is belt-and-suspenders.)
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
    // The map is loaded outside the write transaction (read-only here) and
    // mutated by chunkStreaming. It is persisted inside the transaction so
    // the offset advance and the new tool_use_ids land or roll back together
    // — any future tool_result lookup either sees both the advance and the
    // names, or sees neither and gets re-read from the same offset next pass.
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
    // Even with no chunks, the chunker may have learned tool_use_ids that
    // were the only useful content in this slice (e.g. assistant emitted
    // tool_use(list_inbox) and nothing else new). Persist if the map grew.
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
          // Provenance time from the JSONL record (chunker sets c.timestamp
          // from rec.timestamp; null for records without one, e.g. bus
          // events). For live capture the drift vs created_at is seconds —
          // harmless — but threading it now means the seed loop, which
          // reuses this same chunk→insert path, carries true historical
          // event time instead of collapsing every row to seed-run time.
          eventTs: c.timestamp ?? null,
        });
        // Normalize BigInt → Number so callers can use a Set without
        // having to special-case bigints (BigInts and Numbers compare false
        // in Set membership even for the same value).
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
