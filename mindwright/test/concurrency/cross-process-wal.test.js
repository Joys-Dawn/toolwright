// Cross-process WAL concurrency scenarios.
//
// SQLite's WAL mode allows many readers + one active writer at a time. The
// risk is contention past the 5s busy_timeout window. These tests verify the
// four named cases from DESIGN.md "Daemon liveness" + the plan's testing
// strategy, using real subprocess hooks against a shared per-test tmp DB.
//
// Each scenario is a separate test so a regression in one path doesn't mask
// the others.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from '../../lib/store.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PLUGIN_ROOT = resolve(__dirname, '..', '..');
const HOOKS_DIR = join(PLUGIN_ROOT, 'hooks');

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'mindwright-concur-'));
  const prev = process.env.MINDWRIGHT_PROJECT_ROOT;
  process.env.MINDWRIGHT_PROJECT_ROOT = dir;
  return {
    dir,
    cleanup() {
      if (prev === undefined) delete process.env.MINDWRIGHT_PROJECT_ROOT;
      else process.env.MINDWRIGHT_PROJECT_ROOT = prev;
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* tmp */ }
    },
  };
}

function userRec(content, t = '2026-05-13T00:00:00Z') {
  return { type: 'user', message: { content }, timestamp: t };
}
function thinkingRec(text, t = '2026-05-13T00:00:01Z') {
  return {
    type: 'assistant',
    message: { content: [{ type: 'thinking', thinking: text }] },
    timestamp: t,
  };
}
function textRec(text, t = '2026-05-13T00:00:02Z') {
  return {
    type: 'assistant',
    message: { content: [{ type: 'text', text }] },
    timestamp: t,
  };
}

function writeTranscript(dir, sessionId, recs) {
  const path = join(dir, `${sessionId}.jsonl`);
  writeFileSync(path, recs.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return path;
}

// Pre-seed the offsets row exactly as SessionStart does in production before
// any flush runs. Step 7 added a behavior-1 backstop to flushTranscript: an
// UNKNOWN session (no offsets row) has its offset defaulted to EOF so
// pre-mindwright history is not retroactively ingested. In production
// SessionStart always runs first and writes the row, so the flush no-ops the
// backstop and chunks normally. These concurrency tests drive flushes
// directly without that precursor; the behavior-1 path itself is covered by
// offset-init/transcript-flush tests. Here we exercise WAL serialization /
// pipe-down row writes, so we put each session in the tracked-from-byte-0
// steady state (row = 0 ⇒ backstop no-ops ⇒ chunk from the top).
function seedTrackedFromZero(sessionId) {
  const store = openStore();
  try {
    store.setOffset(sessionId, 0);
  } finally {
    store.close();
  }
}

function runHookSync(name, input, projectRoot) {
  return spawnSync(
    process.execPath,
    [join(HOOKS_DIR, name)],
    {
      input: JSON.stringify(input),
      encoding: 'utf8',
      env: { ...process.env, MINDWRIGHT_PROJECT_ROOT: projectRoot },
    }
  );
}

// Async/parallel version — returns a promise that resolves on subprocess exit.
function runHookAsync(name, input, projectRoot) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [join(HOOKS_DIR, name)],
      {
        env: { ...process.env, MINDWRIGHT_PROJECT_ROOT: projectRoot },
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.write(JSON.stringify(input));
    child.stdin.end();
  });
}

// ---- daemon_dies_mid_write -----------------------------------------------
//
// The daemon may die between when a hook spawned and when it tries the
// embed/rerank RPC. We do not need a live daemon to exercise this path —
// pipe-client returns `null` on connect-fail / EPIPE / timeout, and the
// hook is supposed to: (a) still complete the row writes in the same
// transaction, (b) leave embedding=NULL on the row, (c) skip retrieval.
// The test asserts those three behaviors against a no-daemon environment,
// which structurally matches the real failure mode (no listener on the
// socket = ENOENT = the same null return).

test('daemon_dies_mid_write: hook completes its write with embedding=NULL when pipe is dead', async () => {
  const sb = sandbox();
  const sessionId = 'wal-die-mid';
  try {
    const transcriptPath = writeTranscript(sb.dir, sessionId, [
      userRec('hello'),
      thinkingRec('x'.repeat(2500)), // large thinking block — would normally trigger retrieval via the novelty gate
    ]);
    seedTrackedFromZero(sessionId);
    const res = await runHookAsync('pre-tool-use.js', {
      session_id: sessionId,
      transcript_path: transcriptPath,
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: {},
    }, sb.dir);
    assert.equal(res.code, 0, `hook exit=${res.code} stderr=${res.stderr}`);

    const store = openStore();
    try {
      // Under pending-staging, flushed chunks land as PENDING (invisible to
      // countShortTermFor by design). The contract is still "chunks land"
      // — just in the pending bucket until PreCompact/SessionEnd promotes.
      const count = store.countPendingFor(sessionId);
      assert.ok(count >= 2, `chunks must still write under pipe-down (pending); got ${count}`);
      // Every freshly-inserted row for this session must have NO entry in
      // vec_index — i.e. embedding was deferred because the daemon was
      // unreachable. We query directly because pendingEmbedSweep returns
      // {id, content} without session_id. tier='short' covers pending rows
      // too (pending is a flag on top of the short tier, not a separate tier).
      const rows = store.db.prepare(`
        SELECT e.id, v.rowid AS vec_rowid
          FROM entries e
          LEFT JOIN vec_index v ON v.rowid = e.id
         WHERE e.tier = 'short' AND e.session_id = ?
      `).all(sessionId);
      const withVec = rows.filter((r) => r.vec_rowid !== null);
      assert.equal(
        withVec.length, 0,
        `all rows for this session must have embedding=NULL; instead ${withVec.length}/${rows.length} have vec_index entries`,
      );
    } finally {
      store.close();
    }
  } finally {
    sb.cleanup();
  }
});

// ---- two_hooks_race_offsets ----------------------------------------------
//
// Two PreToolUse hooks of the SAME session fire near-simultaneously. WAL
// serializes the writes; each grabs the current offset, writes its chunks,
// and bumps to its newOffset. Because they read the SAME starting offset
// and chunk the SAME transcript snapshot, the worst case is that the second
// writer no-ops on offset (offset is already at EOF) and inserts duplicate
// rows. We assert: (a) both subprocesses exit 0, (b) the final offset is at
// EOF (no smaller), (c) rows are present (we tolerate duplicates — DESIGN.md
// "Synchronization" calls this out as a brief over-write that consolidation
// drains away cheaply; the invariant is that offset never goes BACKWARDS).

test('two_hooks_race_offsets: offset advances monotonically when two hooks race on the same session', async () => {
  const sb = sandbox();
  const sessionId = 'wal-race';
  try {
    const transcriptPath = writeTranscript(sb.dir, sessionId, [
      userRec('hello'),
      thinkingRec('alpha'),
      textRec('beta'),
    ]);
    // Pre-init offset to 0 so both hooks see the same starting point.
    const store0 = openStore();
    try { store0.setOffset(sessionId, 0); } finally { store0.close(); }

    const fileSize = (await import('node:fs')).statSync(transcriptPath).size;

    const input = {
      session_id: sessionId,
      transcript_path: transcriptPath,
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: {},
    };
    const [r1, r2] = await Promise.all([
      runHookAsync('pre-tool-use.js', input, sb.dir),
      runHookAsync('pre-tool-use.js', input, sb.dir),
    ]);
    assert.equal(r1.code, 0, `hook1 exit=${r1.code} stderr=${r1.stderr}`);
    assert.equal(r2.code, 0, `hook2 exit=${r2.code} stderr=${r2.stderr}`);

    const store = openStore();
    try {
      const finalOffset = store.getOffset(sessionId);
      assert.equal(finalOffset, fileSize, `offset should be at EOF; got ${finalOffset}/${fileSize}`);
      // Under pending-staging, racing hooks both write into the PENDING
      // bucket. countShortTermFor filters pending out; the contract being
      // pinned (no row drops, bounded overshoot) is on total chunked rows,
      // which is countPendingFor here.
      const count = store.countPendingFor(sessionId);
      // Two hooks race over a 3-record transcript. Worst case: both hooks
      // see offset=0 and each writes all 3 records → 6 rows. Anything below
      // 3 means a record was dropped; anything above 6 means a regression
      // is re-chunking the same transcript range multiple times within one
      // hook run (e.g., loop that doesn't advance offset before re-reading).
      // The original assertion was one-sided (`>=3`) which let a 30-row
      // re-chunk regression slip through. Per DESIGN.md "Synchronization":
      // "a brief overshoot is harmless" — consolidation drains the oldest 70%
      // — but "overshoot" is bounded by hook-count × record-count.
      assert.ok(count >= 3 && count <= 6,
        `expected 3-6 rows after race (3 records × ≤2 hooks); got ${count}`);
    } finally {
      store.close();
    }
  } finally {
    sb.cleanup();
  }
});

// ---- daemon_writer_vs_hook_reader ----------------------------------------
//
// One process writes (sweeper-style: backfill embeddings on existing rows)
// while another concurrently reads (retrieval-style: SELECT against
// vec_index + fts). Past the 5s busy_timeout SQLite would error. We
// simulate the contention pattern with two in-process Store instances
// in the same Node process — better-sqlite3 connections are independent
// and use OS-level file locks just like cross-process would.

test('daemon_writer_vs_hook_reader: concurrent writer + reader does not SQLITE_BUSY past the busy_timeout', async () => {
  // The contract this test pins is "no SQLITE_BUSY error from either side
  // under the configured 5s busy_timeout" — NOT "the whole workload runs
  // in under 5s". A previous version asserted wall-clock elapsed < 5000ms,
  // which flaked on slow CI (shared VM, IO contention, paging) without
  // any actual busy_timeout firing. The fix: catch SQLITE_BUSY explicitly
  // on every operation and fail only on that, plus a generous overall cap
  // on the loop so a true hang doesn't run the test forever.
  const sb = sandbox();
  const sessionId = 'wal-rw';
  try {
    // Seed enough rows that a SELECT has work to do.
    const seedStore = openStore();
    let rowIds = [];
    try {
      for (let i = 0; i < 50; i++) {
        const id = seedStore.insertEntry({
          tier: 'short',
          kind: 'thinking',
          content: `seed-${i}`,
          sessionId,
        });
        rowIds.push(id);
      }
    } finally {
      seedStore.close();
    }

    // Open two independent connections — equivalent to separate OS processes
    // for SQLite's locking model.
    const writer = openStore();
    const reader = openStore({ readonly: true });
    // The contract: NO SQLITE_BUSY in either loop. We track explicit busy
    // events instead of indirectly inferring them from wall-clock time.
    const busyEvents = [];
    function isSqliteBusyError(e) {
      // better-sqlite3 maps SQLITE_BUSY to err.code === 'SQLITE_BUSY' AND
      // the message includes 'database is locked' for one variant. Match
      // either — the contract is "no busy at all", not a specific code path.
      const msg = (e && e.message) || '';
      const code = (e && e.code) || '';
      return code === 'SQLITE_BUSY' || /database is locked/i.test(msg);
    }
    try {
      // Generous overall cap. On a comfortable runner this exits in <100ms;
      // on a slow CI it might take a few seconds. The cap exists only so
      // a true deadlock doesn't hang the test forever — it is NOT what we
      // assert on for pass/fail. SQLite's busy_timeout is 5000ms so any
      // contention that would have errored has had ample time to fire by
      // 30000ms.
      const HARD_CAP_MS = 30_000;
      const start = Date.now();
      let writerDone = false;
      const writerWork = (async () => {
        for (const id of rowIds) {
          try {
            writer.db.prepare("UPDATE entries SET content = content || '+w' WHERE id = ?").run(id);
          } catch (e) {
            if (isSqliteBusyError(e)) busyEvents.push({ side: 'writer', err: e.message });
            else throw e;
          }
          await new Promise((r) => setImmediate(r));
        }
        writerDone = true;
      })();
      const readerWork = (async () => {
        let n = 0;
        while (!writerDone && Date.now() - start < HARD_CAP_MS) {
          try {
            const rows = reader.bm25Search('seed', 10);
            n += rows.length;
          } catch (e) {
            if (isSqliteBusyError(e)) busyEvents.push({ side: 'reader', err: e.message });
            else throw e;
          }
          await new Promise((r) => setImmediate(r));
        }
        return n;
      })();
      const [_, readerN] = await Promise.all([writerWork, readerWork]);
      const elapsedMs = Date.now() - start;

      // Primary contract: NO SQLITE_BUSY events.
      assert.deepEqual(busyEvents, [],
        `expected zero SQLITE_BUSY events from either side under the 5s busy_timeout; ` +
        `got: ${JSON.stringify(busyEvents)}`);
      assert.equal(writerDone, true, 'writer must have completed all 50 updates');
      // Reader got at least some rows DURING the writer's run (proves it
      // was concurrent, not blocked).
      assert.ok(readerN > 0, `reader saw zero rows — likely blocked by writer`);
      // Slow-regression guard. Steady-state is <100ms; even loaded CI
      // finishes well under 5s. A budget of 10s catches a regression that
      // would otherwise silently push this test into the 20-30s range
      // (where HARD_CAP_MS is the only thing keeping it from running
      // forever) without flaking on a genuinely slow runner. The cap is
      // intentionally well below HARD_CAP_MS so a hang is still detected
      // by the loop guard above.
      assert.ok(elapsedMs < 10_000,
        `WAL writer+reader test took ${elapsedMs}ms — expected <10s on any sane runner; ` +
        `a regression has slowed the contention loop significantly`);
    } finally {
      reader.close();
      writer.close();
    }
  } finally {
    sb.cleanup();
  }
});

// ---- second_peer_writes --------------------------------------------------
//
// Two peer sessions (different session_id) write concurrently. WAL allows
// many readers + one writer; the OS-level lock serializes the two writers.
// We assert both sets of rows land tagged with their own session_id.
//
// We exercise this with two independent in-process `Store` instances rather
// than two subprocess hooks: better-sqlite3 opens a fresh OS connection per
// `new Database()`, which contends on the same file lock that two real
// processes would — so we still test WAL serialization on the SQLite layer.
// The subprocess+stdin path is already covered by two_hooks_race_offsets
// above, and removing it here eliminates a stdin-pipe race that flakes
// rarely on Windows under heavy parallel-test-runner load (the subprocess
// can exit 0 having read partial stdin and emitted {} before writing).

test('second_peer_writes: two peer sessions writing concurrently both land with correct session_id', async () => {
  const sb = sandbox();
  try {
    const transcriptA = writeTranscript(sb.dir, 'peerA', [
      userRec('peer-a question'),
      thinkingRec('alpha-think'),
    ]);
    const transcriptB = writeTranscript(sb.dir, 'peerB', [
      userRec('peer-b question'),
      thinkingRec('beta-think'),
    ]);

    // Pre-open one store to ensure migrations have run BEFORE the two peers
    // race. Without this both peer connections might attempt the first
    // migration on a fresh DB simultaneously — the migration race is itself
    // already covered by other tests; we don't need to re-litigate it here.
    const initStore = openStore();
    initStore.close();

    // Both peers are tracked-from-0 (the production SessionStart precondition);
    // without this Step 7's behavior-1 backstop would default each unknown
    // session to EOF and neither flush would chunk anything.
    seedTrackedFromZero('peerA');
    seedTrackedFromZero('peerB');

    const { flushTranscript } = await import('../../lib/transcript-flush.js');

    const storeA = openStore();
    const storeB = openStore();
    let outA, outB;
    try {
      // Kick off both flushes effectively concurrently. better-sqlite3
      // operations are synchronous, but Promise scheduling interleaves the
      // two `flushTranscript` calls so each acquires/releases the SQLite
      // write lock independently — same contention pattern as two OS
      // processes, no subprocess pipe between them.
      [outA, outB] = await Promise.all([
        (async () => flushTranscript({ store: storeA, sessionId: 'peerA', transcriptPath: transcriptA }))(),
        (async () => flushTranscript({ store: storeB, sessionId: 'peerB', transcriptPath: transcriptB }))(),
      ]);
    } finally {
      try { storeA.close(); } catch { /* */ }
      try { storeB.close(); } catch { /* */ }
    }

    assert.ok(!outA.error, `peerA flush errored: ${outA.error && outA.error.message}`);
    assert.ok(!outB.error, `peerB flush errored: ${outB.error && outB.error.message}`);

    const store = openStore();
    try {
      // Under pending-staging, flushTranscript writes to PENDING (not real
      // short-term). The cross-session contract is unchanged: each peer's
      // rows must land tagged with its own session_id — we just look in the
      // pending bucket now.
      const countA = store.countPendingFor('peerA');
      const countB = store.countPendingFor('peerB');
      assert.ok(countA >= 2, `peerA pending rows expected ≥2; got ${countA}`);
      assert.ok(countB >= 2, `peerB pending rows expected ≥2; got ${countB}`);
      // Spot-check that the content under each session is from THAT session's transcript.
      const rowsA = store.db.prepare(
        "SELECT content FROM entries WHERE session_id=? AND tier='short'"
      ).all('peerA');
      const rowsB = store.db.prepare(
        "SELECT content FROM entries WHERE session_id=? AND tier='short'"
      ).all('peerB');
      assert.ok(rowsA.some((r) => r.content.includes('peer-a') || r.content.includes('alpha')),
        'peerA must have its own content');
      assert.ok(rowsB.some((r) => r.content.includes('peer-b') || r.content.includes('beta')),
        'peerB must have its own content');
    } finally {
      store.close();
    }
  } finally {
    sb.cleanup();
  }
});
