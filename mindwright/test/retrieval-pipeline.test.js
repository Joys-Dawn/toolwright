// Tests for lib/retrieval-pipeline.js — the shared retrieve→format→dedup
// pipeline used by UserPromptSubmit and PreToolUse. This module replaces a
// ~50-line block that used to live duplicated in both hooks; pinning its
// contract here means future changes (timeout semantics, formatRecall
// prefix, dedup append) are caught by a single test surface.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../lib/store.js';
import {
  createTimeoutBudget,
  fetchRecallContext,
  emitDaemonDownWarningIfFirst,
} from '../lib/retrieval-pipeline.js';
import { INJECTED_FACT_IDS_CAP, DAEMON_DOWN_WARNING } from '../lib/constants.js';

async function withStore(fn) {
  const prevProjectRoot = process.env.MINDWRIGHT_PROJECT_ROOT;
  const dir = mkdtempSync(join(tmpdir(), 'mindwright-retrieval-pipeline-'));
  process.env.MINDWRIGHT_PROJECT_ROOT = dir;
  const store = openStore();
  try {
    return await fn(store);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
    if (prevProjectRoot === undefined) delete process.env.MINDWRIGHT_PROJECT_ROOT;
    else process.env.MINDWRIGHT_PROJECT_ROOT = prevProjectRoot;
  }
}

function unit(seed) {
  const v = new Float32Array(1024);
  for (let i = 0; i < 1024; i++) v[i] = Math.cos(seed * (i + 1));
  let n = 0;
  for (let i = 0; i < 1024; i++) n += v[i] * v[i];
  n = Math.sqrt(n);
  for (let i = 0; i < 1024; i++) v[i] /= n;
  return v;
}

const stubPipe = {
  embed: async (texts) => texts.map((t, i) => unit(t.length + i)),
  rerank: async (_q, cs) => cs.map(() => 0.9),
};

// ---------- createTimeoutBudget ----------

test('createTimeoutBudget: isTimedOut() starts false', () => {
  const { isTimedOut } = createTimeoutBudget(1000);
  assert.equal(isTimedOut(), false);
});

test('createTimeoutBudget: isTimedOut() flips true after the cap fires', async () => {
  const { timeoutPromise, isTimedOut } = createTimeoutBudget(5);
  const result = await timeoutPromise;
  assert.equal(result, '__mindwright_retrieval_timeout__');
  assert.equal(isTimedOut(), true);
});

// ---------- fetchRecallContext: empty store ----------

test('fetchRecallContext returns additionalContext=null when no rows match', async () => {
  await withStore(async (store) => {
    const { timeoutPromise, isTimedOut } = createTimeoutBudget(5000);
    const out = await fetchRecallContext({
      store,
      sessionId: 'sess-a',
      pipe: stubPipe,
      queryText: 'hello',
      queryEmbedding: unit(7),
      k: 5,
      justFlushedIds: [],
      timeoutPromise,
      isTimedOut,
    });
    assert.equal(out.additionalContext, null);
    assert.equal(out.timedOut, false);
    assert.equal(out.retrieveError, null);
    assert.equal(out.appendError, null);
  });
});

// ---------- fetchRecallContext: happy path ----------

test('fetchRecallContext on a hit returns formatted context with the Current-time prefix AND appends the emitted ids to the dedup set', async () => {
  await withStore(async (store) => {
    const id = store.insertEntry({
      tier: 'long', category: 'fact', scope: 'project', kind: 'fact',
      content: 'a fact the retriever will surface', sessionId: 'sess-b',
      embedding: unit(7),
    });
    const { timeoutPromise, isTimedOut } = createTimeoutBudget(5000);
    const out = await fetchRecallContext({
      store,
      sessionId: 'sess-b',
      pipe: stubPipe,
      queryText: 'fact retriever surface',
      queryEmbedding: unit(7),
      k: 5,
      justFlushedIds: [],
      timeoutPromise,
      isTimedOut,
    });
    assert.ok(typeof out.additionalContext === 'string' && out.additionalContext.length > 0,
      `expected non-empty additionalContext, got: ${JSON.stringify(out)}`);
    assert.match(out.additionalContext, /Current time: \d{4}-\d{2}-\d{2}/,
      'must prefix the formatted recall with an ISO Current-time line');
    assert.match(out.additionalContext, /mindwright recall/);

    // Dedup append happened — the just-emitted id is now in the session set.
    const injected = store.getInjectedFactIds('sess-b');
    assert.ok(injected.map(Number).includes(Number(id)),
      `expected emitted id ${id} to be appended to injected_fact_ids, got: ${JSON.stringify(injected)}`);
  });
});

// ---------- fetchRecallContext: dedup excludes prior-injected ----------

test('fetchRecallContext honors prior-injected fact ids — re-running the same query returns null when its sole candidate is already in the dedup set', async () => {
  await withStore(async (store) => {
    const id = store.insertEntry({
      tier: 'long', category: 'fact', scope: 'project', kind: 'fact',
      content: 'the only retrievable fact', sessionId: 'sess-c',
      embedding: unit(7),
    });
    // Plant the fact's id in the session's injected set BEFORE the call —
    // simulates a prior hook firing that already surfaced this row.
    store.appendInjectedFactIds('sess-c', [Number(id)], INJECTED_FACT_IDS_CAP);

    const { timeoutPromise, isTimedOut } = createTimeoutBudget(5000);
    const out = await fetchRecallContext({
      store,
      sessionId: 'sess-c',
      pipe: stubPipe,
      queryText: 'retrievable fact',
      queryEmbedding: unit(7),
      k: 5,
      justFlushedIds: [],
      timeoutPromise,
      isTimedOut,
    });
    assert.equal(out.additionalContext, null,
      'previously-injected ids must be excluded from retrieval; no candidate ⇒ no context');
  });
});

// ---------- fetchRecallContext: timedOut surfaces in result ----------

test('fetchRecallContext reports timedOut=true when the overall budget expires before retrieve completes', async () => {
  await withStore(async (store) => {
    // Plant a row so retrieve() would have something to return given enough time.
    store.insertEntry({
      tier: 'long', category: 'fact', scope: 'project', kind: 'fact',
      content: 'never reached', sessionId: 'sess-d',
      embedding: unit(7),
    });
    // 1ms budget — retrieve() can't complete before the cap fires.
    const { timeoutPromise, isTimedOut } = createTimeoutBudget(1);
    // Wait for the budget to actually expire before calling so isTimedOut
    // flips reliably regardless of scheduling.
    await timeoutPromise;
    const out = await fetchRecallContext({
      store,
      sessionId: 'sess-d',
      pipe: stubPipe,
      queryText: 'q',
      queryEmbedding: unit(7),
      k: 5,
      justFlushedIds: [],
      timeoutPromise,
      isTimedOut,
    });
    assert.equal(out.timedOut, true);
    assert.equal(out.additionalContext, null);
  });
});

// ---------- emitDaemonDownWarningIfFirst ----------

test('emitDaemonDownWarningIfFirst returns null on an empty sessionId without touching the store', () => {
  // Defense against a hook that called the helper before SessionStart bound a
  // sessionId. Reaching into the store with sessionId='' would land a
  // meta:daemon_down_warned: row keyed off the empty string — once present, no
  // future caller could ever clear it because we never run SessionStart with
  // an empty session id either. Guard short-circuits before any store call.
  let touched = false;
  const probeStore = {
    wasDaemonDownWarned: () => { touched = true; return false; },
    markDaemonDownWarned: () => { touched = true; },
  };
  assert.equal(emitDaemonDownWarningIfFirst(probeStore, ''), null,
    'empty sessionId must return null without warning');
  assert.equal(emitDaemonDownWarningIfFirst(probeStore, null), null,
    'null sessionId must return null without warning');
  assert.equal(emitDaemonDownWarningIfFirst(probeStore, undefined), null,
    'undefined sessionId must return null without warning');
  assert.equal(touched, false,
    'falsy sessionId must short-circuit before any store interaction');
});

test('emitDaemonDownWarningIfFirst swallows store-side throws and returns null', () => {
  // The helper is called from inside the UPS/PreToolUse hooks; a throw here
  // would crash the hook subprocess and block the turn. Best-effort contract:
  // if the store layer is unhealthy (DB locked, schema drift, sweeper holds
  // exclusive lock), we silently degrade — the warning was never load-bearing
  // and "no warning shown" is strictly no worse than today's behavior.
  const throwingStore = {
    wasDaemonDownWarned: () => { throw new Error('DB locked'); },
    // Should never be called once the read throws — flag it loudly if it is
    // so a future refactor that reorders the calls is forced to update the
    // contract here too.
    markDaemonDownWarned: () => { throw new Error('mark must not be called'); },
  };
  assert.equal(emitDaemonDownWarningIfFirst(throwingStore, 'sess-x'), null,
    'a throw from wasDaemonDownWarned must be swallowed and return null');
});

test('emitDaemonDownWarningIfFirst is idempotent: emits once per session, then null', () => {
  // The latch is per-session — a fresh boot should warn again (SessionStart
  // clears the meta row), but within a single session we never re-emit. Stub
  // store toggles wasDaemonDownWarned from false→true after the first call,
  // mirroring lib/store.js#markDaemonDownWarned's real meta-row write.
  let warned = false;
  const fakeStore = {
    wasDaemonDownWarned: () => warned,
    markDaemonDownWarned: () => { warned = true; },
  };
  assert.equal(emitDaemonDownWarningIfFirst(fakeStore, 'sess-l'), DAEMON_DOWN_WARNING,
    'first call must emit the canonical warning string');
  assert.equal(warned, true, 'first call must flip the latch');
  assert.equal(emitDaemonDownWarningIfFirst(fakeStore, 'sess-l'), null,
    'second call must return null (idempotent)');
});

// ---------- fetchRecallContext: retrieveError ----------

test('fetchRecallContext does not crash when a precomputed query embedding is supplied and the pipe rerank throws — retrieveError stays null', async () => {
  await withStore(async (store) => {
    const { timeoutPromise, isTimedOut } = createTimeoutBudget(5000);
    // queryEmbedding is precomputed, so retrieve() never calls pipe.embed
    // (retriever.js only embeds when qEmb is falsy). The four retrievers run
    // against an empty store → fused list empty → retrieve() returns [] and
    // never reaches the rerank call, so pipe.rerank's throw is moot. This
    // pins the "no hits, no crash, retrieveError null" contract — it does
    // NOT exercise the retrieveError-populated branch (see the next test).
    const brokenPipe = {
      embed: async () => { throw new Error('boom-embed'); },
      rerank: async () => { throw new Error('boom-rerank'); },
    };
    const out = await fetchRecallContext({
      store,
      sessionId: 'sess-e',
      pipe: brokenPipe,
      queryText: 'q',
      queryEmbedding: unit(7),
      k: 5,
      justFlushedIds: [],
      timeoutPromise,
      isTimedOut,
    });
    assert.equal(out.additionalContext, null);
    assert.equal(out.timedOut, false);
    assert.equal(out.retrieveError, null,
      'retrieve() returns [] on an empty store without throwing, so retrieveError must stay null');
    assert.equal(out.appendError, null);
  });
});

test('fetchRecallContext populates retrieveError when retrieve() throws (query-embed path)', async () => {
  await withStore(async (store) => {
    const { timeoutPromise, isTimedOut } = createTimeoutBudget(5000);
    // Force the genuine throw path: NO precomputed embedding + a pipe.embed
    // that throws. retriever.js:79-82 calls `embed([queryText])` to derive
    // qEmb, and that throw is NOT caught inside retrieve() — it propagates
    // out and fetchRecallContext's catch must surface it as retrieveError
    // (not crash the calling hook). This is the branch the previous test's
    // name used to over-promise.
    const embedThrow = new Error('boom-embed-uncaught');
    const throwingEmbedPipe = {
      embed: async () => { throw embedThrow; },
      rerank: async () => [],
    };
    const out = await fetchRecallContext({
      store,
      sessionId: 'sess-e2',
      pipe: throwingEmbedPipe,
      queryText: 'q-needs-embedding',
      queryEmbedding: null, // <- forces retrieve() to call pipe.embed
      k: 5,
      justFlushedIds: [],
      timeoutPromise,
      isTimedOut,
    });
    assert.equal(out.additionalContext, null,
      'a thrown retrieve() yields no recall context');
    assert.equal(out.timedOut, false);
    assert.equal(out.appendError, null);
    assert.ok(out.retrieveError instanceof Error,
      `retrieveError must be the propagated Error; got ${out.retrieveError}`);
    assert.equal(out.retrieveError.message, 'boom-embed-uncaught',
      'retrieveError must carry the original throw, not a wrapped/generic error');
  });
});
