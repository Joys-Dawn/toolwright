// Tests for lib/seed-loop.js — the dedicated transcript-bootstrap loop.
// Fixture transcripts in a tmp dir; the loop's transcriptsDir is injected so
// the developer's real ~/.claude/projects tree is never touched.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../lib/store.js';
import { runSeedLoop } from '../lib/seed-loop.js';

async function withStore(fn) {
  const prevProjectRoot = process.env.MINDWRIGHT_PROJECT_ROOT;
  const root = mkdtempSync(join(tmpdir(), 'mindwright-seedloop-'));
  const txDir = mkdtempSync(join(tmpdir(), 'mindwright-seedloop-tx-'));
  process.env.MINDWRIGHT_PROJECT_ROOT = root;
  const store = openStore();
  try {
    return await fn(store, txDir);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(txDir, { recursive: true, force: true });
    if (prevProjectRoot === undefined) delete process.env.MINDWRIGHT_PROJECT_ROOT;
    else process.env.MINDWRIGHT_PROJECT_ROOT = prevProjectRoot;
  }
}

function rec(obj) {
  return JSON.stringify(obj);
}

// A small but structurally-real transcript: a user prompt + an assistant
// thinking block, each with a stable uuid and an ISO timestamp.
function writeTranscript(dir, sessionId, recs) {
  writeFileSync(join(dir, `${sessionId}.jsonl`), recs.map(rec).join('\n') + '\n');
}

const SESS_A = '11111111-1111-4111-8111-111111111111';
const SESS_B = '22222222-2222-4222-8222-222222222222';

function userRec(content, t, uuid) {
  return { type: 'user', message: { content }, timestamp: t, uuid };
}
function thinkingRec(text, t, uuid) {
  return {
    type: 'assistant',
    message: { content: [{ type: 'thinking', thinking: text }] },
    timestamp: t,
    uuid,
  };
}

test('runSeedLoop enumerates transcripts and seeds short rows with JSONL event_ts', async () => {
  await withStore(async (store, txDir) => {
    writeTranscript(txDir, SESS_A, [
      userRec('refactor the auth module to bcrypt', '2024-01-02T03:04:05.000Z', 'u-a-1'),
      thinkingRec('consider existing password hashes', '2024-01-02T03:04:06.000Z', 'a-a-1'),
    ]);
    writeTranscript(txDir, SESS_B, [
      userRec('add a rate limiter to the login route', '2024-02-03T04:05:06.000Z', 'u-b-1'),
    ]);

    const summary = await runSeedLoop({ store, transcriptsDir: txDir });

    assert.equal(summary.transcriptsScanned, 2);
    assert.equal(summary.transcriptsSeeded, 2);
    assert.equal(summary.skipped, 0);
    assert.ok(summary.rowsInserted >= 3, `expected ≥3 rows, got ${summary.rowsInserted}`);

    const rows = store.db.prepare(
      `SELECT tier, scope, source_ref, event_ts, content FROM entries
         WHERE tier='short' AND active=1 ORDER BY id ASC`,
    ).all();
    assert.equal(rows.length, summary.rowsInserted);

    // Every seeded row carries the originating JSONL timestamp verbatim as
    // event_ts (the chunker stores rec.timestamp unmodified, same as the live
    // flush path) and is scope-NULL (raw transcripts carry no role).
    for (const r of rows) {
      assert.equal(r.tier, 'short');
      assert.equal(r.scope, null, 'transcript seed rows must never be role-scoped');
      assert.ok(
        typeof r.event_ts === 'string' && r.event_ts.endsWith('Z'),
        `event_ts should be the JSONL ISO timestamp, got ${JSON.stringify(r.event_ts)}`,
      );
    }
    // Durable source_ref = <basename>:<uuid> (Step 4 contract), not line:<n>.
    const aRow = rows.find((r) => r.event_ts === '2024-01-02T03:04:05.000Z');
    assert.ok(aRow, 'the user-prompt row should exist with its JSONL event_ts');
    assert.equal(aRow.source_ref, `${SESS_A}.jsonl:u-a-1`);

    // No role:-scoped row was produced anywhere (explicit invariant guard).
    const roleScoped = store.db.prepare(
      `SELECT COUNT(*) n FROM entries WHERE scope LIKE 'role:%'`,
    ).get().n;
    assert.equal(roleScoped, 0);
  });
});

test('runSeedLoop skips a session that already has an offsets row (live-captured)', async () => {
  await withStore(async (store, txDir) => {
    // SESS_A simulates a live session SessionStart already advanced.
    store.setOffset(SESS_A, 4096);
    writeTranscript(txDir, SESS_A, [
      userRec('live session content — must NOT be re-seeded', '2024-01-01T00:00:00.000Z', 'u-a'),
    ]);
    writeTranscript(txDir, SESS_B, [
      userRec('genuinely pre-install transcript', '2024-01-01T00:00:01.000Z', 'u-b'),
    ]);

    const summary = await runSeedLoop({ store, transcriptsDir: txDir });

    assert.equal(summary.transcriptsScanned, 2);
    assert.equal(summary.transcriptsSeeded, 1, 'only the no-offsets transcript seeds');
    assert.equal(summary.skipped, 1);

    const aRows = store.db.prepare(
      `SELECT COUNT(*) n FROM entries WHERE session_id=? AND active=1`,
    ).get(SESS_A).n;
    assert.equal(aRows, 0, 'the live-captured session must contribute zero seed rows');
    const bRows = store.db.prepare(
      `SELECT COUNT(*) n FROM entries WHERE session_id=? AND active=1`,
    ).get(SESS_B).n;
    assert.ok(bRows >= 1);
  });
});

test('runSeedLoop is idempotent: a completed transcript is not re-seeded on re-run', async () => {
  await withStore(async (store, txDir) => {
    writeTranscript(txDir, SESS_A, [
      userRec('one prompt', '2024-03-03T03:03:03.000Z', 'u-1'),
      thinkingRec('one thought', '2024-03-03T03:03:04.000Z', 'a-1'),
    ]);

    const first = await runSeedLoop({ store, transcriptsDir: txDir });
    assert.equal(first.transcriptsSeeded, 1);
    const countAfterFirst = store.db.prepare(
      `SELECT COUNT(*) n FROM entries WHERE tier='short' AND active=1`,
    ).get().n;
    assert.ok(countAfterFirst >= 2);

    // Second run: the transcript's session now has an offsets row at EOF.
    const second = await runSeedLoop({ store, transcriptsDir: txDir });
    assert.equal(second.transcriptsSeeded, 0, 'nothing re-seeded');
    assert.equal(second.skipped, 1);
    assert.equal(second.rowsInserted, 0);

    const countAfterSecond = store.db.prepare(
      `SELECT COUNT(*) n FROM entries WHERE tier='short' AND active=1`,
    ).get().n;
    assert.equal(countAfterSecond, countAfterFirst, 'no duplicate seed rows');
  });
});

test('runSeedLoop bounds batches: consolidate() fires at the byte budget and on final flush', async () => {
  await withStore(async (store, txDir) => {
    // A is large (one ~12 KB user chunk), B is tiny. With a 1 KB budget A
    // alone crosses it → a budget cycle fires + accumulator resets; B's few
    // bytes stay under budget → only the final tail flush distills them.
    writeTranscript(txDir, SESS_A, [
      userRec('alpha '.repeat(2000), '2024-04-04T00:00:00.000Z', 'u-a'),
    ]);
    writeTranscript(txDir, SESS_B, [
      userRec('beta', '2024-04-04T00:00:01.000Z', 'u-b'),
    ]);

    const calls = [];
    const consolidate = async ({ store: s, reason }) => {
      assert.ok(s, 'consolidate receives the store handle');
      calls.push(reason);
    };

    const summary = await runSeedLoop({
      store,
      transcriptsDir: txDir,
      batchBudgetBytes: 1024,
      consolidate,
    });

    assert.equal(summary.transcriptsSeeded, 2);
    assert.equal(summary.consolidations, 2,
      `expected exactly 2 cycles (1 budget + 1 final), got ${summary.consolidations}`);
    assert.equal(calls.length, 2);
    assert.ok(calls.some((r) => /budget/.test(r)), 'a budget-triggered cycle ran');
    assert.ok(calls.some((r) => /final flush/.test(r)), 'the tail flush ran');
  });
});

test('runSeedLoop resumes after a mid-corpus interruption (per-transcript offsets)', async () => {
  await withStore(async (store, txDir) => {
    writeTranscript(txDir, SESS_A, [
      userRec('first transcript body', '2024-05-05T00:00:00.000Z', 'u-a'),
    ]);
    writeTranscript(txDir, SESS_B, [
      userRec('second transcript body', '2024-05-05T00:00:01.000Z', 'u-b'),
    ]);

    // Simulate a crash: consolidate throws AFTER the first transcript has
    // already committed (its insert + offset advance are atomic and done
    // before the budget callback fires).
    const boom = async () => { throw new Error('simulated interruption'); };
    await assert.rejects(
      runSeedLoop({ store, transcriptsDir: txDir, batchBudgetBytes: 1, consolidate: boom }),
      /simulated interruption/,
    );

    // Exactly one transcript committed before the throw; its offset is set.
    const seededSessions = store.db.prepare(
      `SELECT DISTINCT session_id s FROM entries WHERE tier='short' AND active=1`,
    ).all().map((r) => r.s);
    assert.equal(seededSessions.length, 1, 'one transcript committed pre-crash');
    const crashedSession = seededSessions[0];
    assert.ok(store.getOffset(crashedSession) > 0, 'its offset was advanced');

    // Re-run without the failing callback: the committed transcript is
    // skipped (offset set), the untouched one is seeded — no duplication.
    const resume = await runSeedLoop({ store, transcriptsDir: txDir });
    assert.equal(resume.skipped, 1, 'the pre-crash transcript is skipped on resume');
    assert.equal(resume.transcriptsSeeded, 1, 'the remaining transcript seeds');

    const distinctAfter = store.db.prepare(
      `SELECT COUNT(DISTINCT session_id) n FROM entries WHERE tier='short' AND active=1`,
    ).get().n;
    assert.equal(distinctAfter, 2, 'both transcripts represented exactly once');
  });
});

test('runSeedLoop returns a zeroed summary when the transcripts dir is absent', async () => {
  await withStore(async (store) => {
    const missing = join(tmpdir(), `mindwright-seedloop-missing-${process.pid}-${Date.now()}`);
    const summary = await runSeedLoop({ store, transcriptsDir: missing });
    assert.deepEqual(summary, {
      transcriptsScanned: 0,
      transcriptsSeeded: 0,
      skipped: 0,
      rowsInserted: 0,
      bytesIngested: 0,
      consolidations: 0,
    });
  });
});
