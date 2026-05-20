// Unit tests for lib/transcript-flush.js. The helper owns the shared
// "read offset → chunk → insert + setOffset under one transaction" loop
// used by all four content-writing hooks.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../lib/store.js';
import { flushTranscript } from '../lib/transcript-flush.js';

function withStore(fn) {
  // Snapshot/restore MINDWRIGHT_PROJECT_ROOT so the env var doesn't leak.
  const prevProjectRoot = process.env.MINDWRIGHT_PROJECT_ROOT;
  const dir = mkdtempSync(join(tmpdir(), 'mindwright-flush-'));
  process.env.MINDWRIGHT_PROJECT_ROOT = dir;
  const store = openStore();
  try {
    return fn(store, dir);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
    if (prevProjectRoot === undefined) {
      delete process.env.MINDWRIGHT_PROJECT_ROOT;
    } else {
      process.env.MINDWRIGHT_PROJECT_ROOT = prevProjectRoot;
    }
  }
}

function writeTranscript(dir, recs) {
  const path = join(dir, 'transcript.jsonl');
  writeFileSync(path, recs.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return path;
}

test('flushTranscript stages chunks as pending under the calling session and advances offset atomically', () => {
  withStore((store, dir) => {
    const sessionId = 'sess-1';
    const path = writeTranscript(dir, [
      { type: 'user', message: { role: 'user', content: 'hello' } },
      {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'pondering' }] },
      },
    ]);
    // Pre-seed an offsets row so the Step-7 offset-init backstop treats this
    // as an already-tracked (steady-state) session and no-ops. setOffset(_,0)
    // is behavior-neutral for the flush (getOffset still returns 0 ⇒ chunk
    // from byte 0 exactly as pre-Step-7) — it only flips hasOffsetRow so the
    // backstop does not EOF-default an "unknown" session out from under a test
    // that is asserting chunk/offset/txn mechanics, NOT the unknown-session
    // EOF policy (that policy is covered by offset-init.test.js and the
    // backstop tests at the bottom of this file).
    store.setOffset(sessionId, 0);
    const result = flushTranscript({ store, sessionId, transcriptPath: path });
    assert.equal(result.error, undefined);
    assert.ok(result.chunks.length >= 1, 'expected at least one chunk');
    assert.ok(result.newOffset > result.prevOffset, 'offset must advance');
    // Offset persisted.
    assert.equal(store.getOffset(sessionId), result.newOffset);
    // Rows land as PENDING under the calling session, NOT in real short-term:
    // the just-flushed content is still in the agent's context, so retrieval
    // (and the cap counter) deliberately don't see it until PreCompact /
    // SessionEnd promotes it.
    assert.equal(store.countShortTermFor(sessionId), 0,
      'no real short-term rows yet — pending until promotion');
    assert.equal(store.countPendingFor(sessionId), result.chunks.length,
      'every chunk is staged in pending under this session');
  });
});

test('flushTranscript threads JSONL rec.timestamp into event_ts (NULL when absent)', () => {
  withStore((store, dir) => {
    const sessionId = 'sess-eventts';
    const eventTime = '2025-01-02T03:04:05.000Z';
    // Tracked-session pre-seed (see the first flush test) so the Step-7
    // backstop no-ops and this exercises chunk-mechanics, not EOF policy.
    const path = writeTranscript(dir, [
      // Record WITH a timestamp → its chunk's event_ts must equal it.
      {
        type: 'user',
        message: { role: 'user', content: 'hello from the past' },
        timestamp: eventTime,
      },
      // Record WITHOUT a timestamp → event_ts must be NULL (pre-change behavior).
      {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'pondering' }] },
      },
    ]);
    store.setOffset(sessionId, 0);
    const result = flushTranscript({ store, sessionId, transcriptPath: path });
    assert.equal(result.error, undefined);
    assert.equal(result.insertedIds.length, 2, 'expected one chunk per record');

    const withTs = store.fetch(result.insertedIds[0]);
    assert.equal(withTs.kind, 'cli_prompt');
    assert.equal(withTs.event_ts, eventTime,
      'a chunk from a timestamped record must carry that timestamp as event_ts');
    assert.ok(withTs.created_at && withTs.created_at !== withTs.event_ts,
      'created_at is the write time, distinct from the (older) event time');

    const noTs = store.fetch(result.insertedIds[1]);
    assert.equal(noTs.kind, 'thinking');
    assert.equal(noTs.event_ts, null,
      'a chunk from a record with no timestamp must have NULL event_ts');
  });
});

test('flushTranscript on empty new content is a no-op', () => {
  withStore((store, dir) => {
    const sessionId = 'sess-2';
    const path = writeTranscript(dir, [
      { type: 'user', message: { role: 'user', content: 'hi' } },
    ]);
    // Tracked-session pre-seed (see the first flush test) so the Step-7
    // backstop no-ops and the first call genuinely drains, instead of the
    // backstop EOF-defaulting this as an unknown session.
    store.setOffset(sessionId, 0);
    // First call drains the file.
    flushTranscript({ store, sessionId, transcriptPath: path });
    const after = store.getOffset(sessionId);
    // Second call: nothing new.
    const result = flushTranscript({ store, sessionId, transcriptPath: path });
    assert.equal(result.error, undefined);
    assert.equal(result.chunks.length, 0);
    assert.equal(result.prevOffset, after);
    assert.equal(result.newOffset, after);
  });
});

test('flushTranscript persists toolMap when slice contains only an assistant inbox tool_use (no extractable chunks)', () => {
  // The chunker emits zero chunks for an assistant tool_use(wrightward_list_inbox)
  // block (it's not an outbound send), but it MUTATES the persisted
  // tool_use_id → name map so the matching tool_result on a later hook pass
  // can be classified. Regression bait: a future refactor that skipped
  // saveToolMap on chunks.length===0 would silently break inbox-event capture
  // because the tool_result arrives in a different hook pass than the tool_use,
  // and without the persisted map the result's tool name is unknown.
  withStore((store, dir) => {
    const sessionId = 'sess-toolmap';
    const inboxId = 'toolu_inbox_42';
    const path = writeTranscript(dir, [
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{
            type: 'tool_use',
            id: inboxId,
            name: 'mcp__plugin_wrightward_wrightward-bus__wrightward_list_inbox',
            input: {},
          }],
        },
      },
    ]);
    // Tracked-session pre-seed (see the first flush test) so the Step-7
    // backstop no-ops; this asserts offset-advance + toolMap mechanics.
    store.setOffset(sessionId, 0);
    // Precondition: no map persisted yet.
    assert.equal(store.loadToolMap(sessionId).size, 0);

    const result = flushTranscript({ store, sessionId, transcriptPath: path });
    assert.equal(result.error, undefined);
    assert.equal(result.chunks.length, 0, 'inbox tool_use produces no chunk by itself');
    assert.ok(result.newOffset > result.prevOffset, 'offset must advance past the consumed record');

    // The documented behavior: the chunker's map mutation MUST be persisted
    // so a later flushTranscript pass can classify the matching tool_result.
    // The persisted shape is the object form `{ name, input, … }` so the
    // late-arriving result can also emit a paired tool_call when applicable;
    // here the inbox tool follows the decomposition path so only the name is
    // needed.
    const persisted = store.loadToolMap(sessionId);
    assert.equal(persisted.get(inboxId)?.name,
      'mcp__plugin_wrightward_wrightward-bus__wrightward_list_inbox',
      'tool_use_id → { name, … } object must survive to the next pass');
  });
});

test('flushTranscript captures chunker errors and preserves prevOffset (never advances on chunker throw)', () => {
  // Contract: the helper never throws. If the chunker fails (corrupted file
  // mid-read, permission error, statSync error), flushTranscript must return
  // { error, newOffset === prevOffset } so the offset doesn't advance past
  // content that wasn't actually chunked — otherwise the next pass would
  // silently lose those records.
  withStore((store, dir) => {
    const sessionId = 'sess-chunker-throw';
    // Plant an existing offset of 100 so we can assert non-zero prevOffset
    // round-trips through the error path.
    store.setOffset(sessionId, 100);
    // Pass a non-string transcriptPath — fs.statSync rejects it with
    // ERR_INVALID_ARG_TYPE, which is NOT the ENOENT we tolerate, so
    // readSinceOffset rethrows and the helper catches it via its second
    // try/catch. Numeric path is the cleanest way to force a non-ENOENT
    // throw without relying on filesystem permissions that differ across OS.
    const result = flushTranscript({ store, sessionId, transcriptPath: 12345 });
    assert.ok(result.error, 'expected error field set on chunker failure');
    assert.equal(result.prevOffset, 100, 'prevOffset must be the stored offset');
    assert.equal(result.newOffset, 100,
      'newOffset must equal prevOffset on chunker failure — no silent advance');
    assert.equal(result.chunks.length, 0);
    // Offset in the DB is unchanged so the next pass re-reads from 100.
    assert.equal(store.getOffset(sessionId), 100,
      'stored offset must not advance on chunker failure');
  });
});

test('flushTranscript returns error from writeTx (insertedIds=[], chunks preserved for diagnostics)', () => {
  // The write transaction is the second failure surface. On throw, the helper
  // returns the chunks the chunker produced (so a caller logging diagnostics
  // can see what would have been inserted) but insertedIds=[] because the
  // transaction rolled back. A downstream consumer that ignores `error` and
  // uses chunks.length as a proxy for insertedIds.length would corrupt the
  // recall excludeIds set; the test pins that contract.
  const fakeStore = {
    getOffset: () => 0,
    loadToolMap: () => new Map(),
    saveToolMap: () => {},
    // db.transaction(fn) returns a function that throws on call — better-sqlite3's
    // shape but with a forced failure inside the txn body.
    db: {
      transaction: () => () => { throw new Error('boom-tx'); },
    },
    insertEntry: () => 1,
    setOffset: () => {},
  };
  // Real transcript file so chunkStreaming actually produces chunks.
  const dir = mkdtempSync(join(tmpdir(), 'mindwright-flush-tx-'));
  try {
    const path = join(dir, 'transcript.jsonl');
    writeFileSync(path,
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'pondering' }] },
      }) + '\n',
    );
    const result = flushTranscript({ store: fakeStore, sessionId: 'sess-tx', transcriptPath: path });
    assert.ok(result.error, 'expected error field set on writeTx failure');
    assert.match(result.error.message, /boom-tx/);
    assert.ok(result.chunks.length >= 1,
      'chunks must be preserved for diagnostics even when txn fails');
    assert.deepEqual(result.insertedIds, [],
      'insertedIds MUST be empty on rollback so callers do not assume chunks.length === insertedIds.length');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('flushTranscript normalizes BigInt insertedIds to Number (so Set membership in excludeIds works)', () => {
  // Regression bait: hooks/pre-tool-use.js and hooks/user-prompt-submit.js
  // pass result.insertedIds into retrieve() as excludeIds, used as a Set
  // membership filter. BigInt(42) !== Number(42) in a Set — without the
  // insertedIds BigInt→Number normalization in flushTranscript, a just-flushed
  // cli_prompt/thinking row could echo back as its own recall candidate once
  // the rowid passes 2^32 (or
  // any time better-sqlite3's safeIntegers / largeBigInt path returns
  // a BigInt). The normalization is silent defense; a missing test means
  // a refactor that drops it would not be caught.
  withStore((store, dir) => {
    const sessionId = 'sess-bigint';
    const path = writeTranscript(dir, [
      { type: 'user', message: { role: 'user', content: 'hello' } },
      {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'pondering' }] },
      },
    ]);
    // Tracked-session pre-seed (see the first flush test) so the Step-7
    // backstop no-ops and chunks are actually produced for the BigInt path.
    store.setOffset(sessionId, 0);

    // Wrap store.insertEntry to return BigInt instead of Number — simulates
    // better-sqlite3's safeIntegers mode or a rowid past 2^32.
    const realInsert = store.insertEntry.bind(store);
    let counter = 0;
    store.insertEntry = function bigIntInsertEntry(args) {
      const realId = realInsert(args);
      counter += 1;
      // Return a BigInt slightly above the real id so DB integrity is preserved
      // for any downstream reads, but the helper's normalization branch is
      // exercised on the value the caller actually sees.
      return BigInt(realId);
    };

    const result = flushTranscript({ store, sessionId, transcriptPath: path });
    assert.equal(result.error, undefined);
    assert.ok(result.insertedIds.length > 0, 'expected at least one inserted id');
    assert.equal(counter, result.insertedIds.length, 'precondition: stub was called');
    for (const id of result.insertedIds) {
      assert.equal(typeof id, 'number',
        `insertedIds must be Number, got typeof=${typeof id} value=${id}`);
    }
  });
});

test('flushTranscript returns error (not throw) when store operations fail', () => {
  // The contract: the helper NEVER throws. On error it returns an `error`
  // field so the caller can log + emit `{}` and exit cleanly.
  const fakeStore = {
    getOffset: () => { throw new Error('boom-getOffset'); },
    db: { transaction: () => () => {} },
    insertEntry: () => {},
    setOffset: () => {},
  };
  const result = flushTranscript({
    store: fakeStore,
    sessionId: 'sess-3',
    transcriptPath: 'irrelevant.jsonl',
  });
  assert.ok(result.error, 'expected error field set');
  assert.match(result.error.message, /boom-getOffset/);
});

// --- Step-7: the trigger-agnostic offset-init backstop -------------------
// behavior-1: SessionStart is dormant on a deps-less first run, so the FIRST
// deps-present flush would (pre-Step-7) see getOffset()===0 and chunk the
// entire pre-mindwright transcript. flushTranscript now runs initOffsetIfUnknown
// BEFORE reading the offset. These pin: the EOF-default actually skips history,
// exactly-once across flushes (incl. the SEED=1 + empty-transcript regression
// the plan's Critical names), the steady-state no-op is byte-identical, and a
// backstop failure can never crash the flush.

function withSeed(value, fn) {
  const prev = process.env.MINDWRIGHT_SEED_TRANSCRIPT;
  if (value === undefined) delete process.env.MINDWRIGHT_SEED_TRANSCRIPT;
  else process.env.MINDWRIGHT_SEED_TRANSCRIPT = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.MINDWRIGHT_SEED_TRANSCRIPT;
    else process.env.MINDWRIGHT_SEED_TRANSCRIPT = prev;
  }
}

test('backstop: an UNKNOWN non-opt-in session does NOT chunk pre-existing history (behavior-1 fix)', () => {
  withStore((store, dir) => {
    withSeed(undefined, () => {
      const sessionId = 'sess-unknown';
      // A small (< RESUMED_SESSION_WARN_BYTES) content transcript: the helper
      // is fully synchronous on this path (no countTranscriptRecords await),
      // so the EOF setOffset is guaranteed committed before flush reads it.
      const path = writeTranscript(dir, [
        { type: 'user', message: { role: 'user', content: 'pre-mindwright history that must NOT be ingested' } },
        { type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'old' }] } },
      ]);
      assert.equal(store.hasOffsetRow(sessionId), false, 'precondition: a genuinely unknown session');

      const result = flushTranscript({ store, sessionId, transcriptPath: path });

      assert.equal(result.error, undefined);
      assert.equal(result.chunks.length, 0, 'the backstop EOF-defaulted the offset → no pre-existing history chunked');
      assert.ok(result.prevOffset > 0, 'flush read the backstop-committed EOF offset, not 0');
      assert.equal(store.getOffset(sessionId), result.prevOffset, 'offset is the EOF the backstop set');
      assert.equal(store.hasOffsetRow(sessionId), true, 'the decision is latched');
      assert.equal(store.countShortTermFor(sessionId), 0, 'zero rows: history was skipped, not ingested');
    });
  });
});

test('backstop: multi-flush is exactly-once (second flush re-runs the backstop as a no-op, history still skipped)', () => {
  withStore((store, dir) => {
    withSeed(undefined, () => {
      const sessionId = 'sess-unknown-twice';
      const path = writeTranscript(dir, [
        { type: 'user', message: { role: 'user', content: 'history' } },
      ]);

      const first = flushTranscript({ store, sessionId, transcriptPath: path });
      const offsetAfterFirst = store.getOffset(sessionId);

      const second = flushTranscript({ store, sessionId, transcriptPath: path });

      assert.equal(first.error, undefined);
      assert.equal(second.error, undefined);
      assert.equal(first.chunks.length, 0);
      assert.equal(second.chunks.length, 0, 'second flush still chunks nothing');
      assert.equal(store.getOffset(sessionId), offsetAfterFirst, 'offset stable across flushes (latch holds)');
      assert.equal(store.countShortTermFor(sessionId), 0, 'history never ingested on any flush');
    });
  });
});

test('backstop CRITICAL: fresh + SEED=1 + empty transcript — value-0 latch, no re-fire, offset NEVER moved to EOF', () => {
  // The exact regression the plan's Critical names: zero chunks ⇒ flushTranscript
  // returns at the chunks.length===0 && newOffset===prevOffset branch BEFORE
  // its own setOffset, so ONLY the backstop's value-0 row is the latch. If the
  // latch were value-based (getOffset===0) instead of existence-based it would
  // re-fire every flush and the flag would be silently broken by a later EOF.
  withStore((store, dir) => {
    withSeed('1', () => {
      const sessionId = 'sess-seed-empty';
      const path = join(dir, 'empty.jsonl');
      writeFileSync(path, ''); // size 0 — deterministically zero chunks

      const first = flushTranscript({ store, sessionId, transcriptPath: path });
      assert.equal(first.error, undefined);
      assert.equal(first.chunks.length, 0);
      assert.equal(store.hasOffsetRow(sessionId), true, 'the backstop wrote the value-0 latch row');
      assert.equal(store.getOffset(sessionId), 0, 'opt-in: offset stays 0');

      // Several more flushes must NOT re-fire and must NEVER move the offset
      // to EOF (which would silently defeat MINDWRIGHT_SEED_TRANSCRIPT=1).
      for (let i = 0; i < 3; i++) {
        const r = flushTranscript({ store, sessionId, transcriptPath: path });
        assert.equal(r.error, undefined);
        assert.equal(store.getOffset(sessionId), 0, `flush #${i + 2}: offset MUST still be 0 (flag not silently broken)`);
      }
    });
  });
});

test('backstop: fresh + SEED=1 + content — the flag IS honored (history ingested from byte 0), then idempotent', () => {
  withStore((store, dir) => {
    withSeed('1', () => {
      const sessionId = 'sess-seed-content';
      const path = writeTranscript(dir, [
        { type: 'user', message: { role: 'user', content: 'prior content the user explicitly opted to ingest' } },
        { type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'recalled' }] } },
      ]);

      const first = flushTranscript({ store, sessionId, transcriptPath: path });
      assert.equal(first.error, undefined);
      assert.ok(first.chunks.length >= 1, 'SEED=1 honored: the backstop left offset 0 so the flush ingests from the top');
      assert.equal(first.prevOffset, 0, 'opt-in offset is 0, NOT EOF — the silent-break guard at the integration level');
      // flushTranscript always stages rows as pending; the "ingested" check
      // hits countPendingFor, not countShortTermFor. Promotion (PreCompact /
      // SessionEnd) is what would move these into real short-term.
      assert.ok(store.countPendingFor(sessionId) >= 1, 'prior content was actually staged in pending');

      const second = flushTranscript({ store, sessionId, transcriptPath: path });
      assert.equal(second.error, undefined);
      assert.equal(second.chunks.length, 0, 'idempotent: nothing new on the second flush (latch + advanced offset)');
    });
  });
});

test('backstop: an already-tracked session is byte-identical to pre-Step-7 (zero live-capture regression)', () => {
  withStore((store, dir) => {
    withSeed(undefined, () => {
      const sessionId = 'sess-tracked';
      // A genuinely tracked session: a row already exists (value 0 here so the
      // chunk-from-0 mechanics are observable). The backstop MUST no-op — proven
      // by prevOffset still being 0 (an unknown session would have had the
      // backstop overwrite it with EOF before the flush read it).
      store.setOffset(sessionId, 0);
      const path = writeTranscript(dir, [
        { type: 'user', message: { role: 'user', content: 'live turn' } },
        { type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'live' }] } },
      ]);

      const result = flushTranscript({ store, sessionId, transcriptPath: path });

      assert.equal(result.error, undefined);
      assert.equal(result.prevOffset, 0, 'backstop no-op on a tracked session: offset NOT EOF-defaulted');
      assert.ok(result.chunks.length >= 1, 'chunked from 0 exactly as pre-Step-7 — live capture unchanged');
      assert.ok(result.newOffset > 0, 'offset advances normally');
    });
  });
});

test('backstop: a throwing offset-init (latch failure) is swallowed — the flush still returns, never crashes', () => {
  // The never-throws → {error} contract is load-bearing for all five hook
  // callers. A backstop failure must be fully isolated: the flush proceeds
  // from whatever offset exists and returns normally (not even an `error`).
  const fakeStore = {
    hasOffsetRow: () => { throw new Error('latch boom'); },
    getOffset: () => 0,
    loadToolMap: () => new Map(),
    saveToolMap: () => {},
    db: { transaction: (fn) => () => fn() },
    insertEntry: () => 1,
    setOffset: () => {},
  };
  const dir = mkdtempSync(join(tmpdir(), 'mindwright-flush-backstop-'));
  try {
    const path = join(dir, 'transcript.jsonl');
    writeFileSync(path,
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'pondering' }] },
      }) + '\n',
    );

    const result = flushTranscript({ store: fakeStore, sessionId: 'sess-backstop-throw', transcriptPath: path });

    assert.equal(result.error, undefined, 'a backstop throw must NOT surface as a flush error');
    assert.ok(result.chunks.length >= 1, 'the flush completed normally despite the backstop failing');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
