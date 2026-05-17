// Unit tests for lib/offset-init.js — the trigger-agnostic, idempotent
// per-session offset initializer that fixes behavior-1 (the EOF default +
// resumed-session warning used to live only in SessionStart, which is dormant
// on a deps-less first run, so the first deps-present flush retroactively
// ingested the whole pre-mindwright transcript).
//
// The contracts pinned here:
//   - non-opt-in unknown session  → offset := EOF (do NOT ingest history);
//     large transcript → a ~N-records resumed-session warning.
//   - fresh MINDWRIGHT_SEED_TRANSCRIPT=1 → offset stays 0 AND a value-0 row is
//     written (the latch the original session-start code omitted), with the
//     opt-in message.
//   - a row already exists → immediate no-op (the hasOffsetRow EXISTENCE
//     latch): exactly-once across entrypoints, the steady-state live-capture
//     path, AND the deliberate consequence that an already-tracked session is
//     never re-ingested by the shared helper (an idempotent re-opt-in would
//     need per-session state — out of scope for behavior-1).
//   - SILENT-BREAK GUARD (the Critical): with MINDWRIGHT_SEED_TRANSCRIPT=1 the
//     helper NEVER applies the EOF default, regardless of size — the flag can
//     never be silently defeated.
//
// A real store (openStore in a per-test sandbox) is used so hasOffsetRow /
// getOffset / setOffset are the genuine SQL, not a fake — the latch's
// value-0-row-vs-no-row distinction is the whole point and a stub would beg
// the question.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../lib/store.js';
import { initOffsetIfUnknown, countTranscriptRecords, RESUMED_SESSION_WARN_BYTES } from '../lib/offset-init.js';

let sandboxDir;
let store;
let prevProjectRoot;
let prevSeed;

beforeEach(() => {
  prevProjectRoot = process.env.MINDWRIGHT_PROJECT_ROOT;
  prevSeed = process.env.MINDWRIGHT_SEED_TRANSCRIPT;
  // Default every test to the non-opt-in world; opt-in tests set it explicitly.
  delete process.env.MINDWRIGHT_SEED_TRANSCRIPT;
  sandboxDir = mkdtempSync(join(tmpdir(), 'mw-offinit-'));
  process.env.MINDWRIGHT_PROJECT_ROOT = sandboxDir;
  store = openStore();
});

afterEach(() => {
  try { store.close(); } catch { /* already closed */ }
  try { rmSync(sandboxDir, { recursive: true, force: true }); } catch { /* gone */ }
  if (prevProjectRoot === undefined) delete process.env.MINDWRIGHT_PROJECT_ROOT;
  else process.env.MINDWRIGHT_PROJECT_ROOT = prevProjectRoot;
  if (prevSeed === undefined) delete process.env.MINDWRIGHT_SEED_TRANSCRIPT;
  else process.env.MINDWRIGHT_SEED_TRANSCRIPT = prevSeed;
});

// A transcript comfortably past RESUMED_SESSION_WARN_BYTES, with a known
// newline count so the "~N records" message is deterministic.
function writeLargeTranscript(records) {
  const path = join(sandboxDir, 'transcript.jsonl');
  const line = JSON.stringify({ type: 'user', message: { role: 'user', content: 'x'.repeat(120) } });
  writeFileSync(path, Array.from({ length: records }, () => line).join('\n') + '\n');
  return path;
}

function writeTinyTranscript(text) {
  const path = join(sandboxDir, 'tiny.jsonl');
  writeFileSync(path, text);
  return path;
}

test('non-opt-in unknown session: offset defaults to EOF and a large transcript yields a ~N-records warning', async () => {
  const records = 200;
  const path = writeLargeTranscript(records);
  const size = statSync(path).size;
  assert.ok(size > RESUMED_SESSION_WARN_BYTES, 'precondition: transcript must exceed the warn threshold');

  const r = await initOffsetIfUnknown({ store, sessionId: 's1', transcriptPath: path });

  assert.equal(r.initialized, true);
  assert.equal(store.getOffset('s1'), size, 'offset must default to EOF — pre-mindwright history is NOT ingested');
  assert.equal(store.hasOffsetRow('s1'), true, 'the decision must be latched');
  assert.match(r.message, /from before mindwright was tracking it/);
  assert.match(r.message, /~\d+ records/, 'the resumed-session warning must carry a record count');
  assert.match(r.message, new RegExp(`${records} records`), 'record count must match the transcript line count');
  assert.match(r.message, /MINDWRIGHT_SEED_TRANSCRIPT=1/, 'the warning must tell the user how to ingest it');
});

test('non-opt-in unknown session, small transcript (≤ warn bytes): EOF default, latched, but NO message', async () => {
  const path = writeTinyTranscript('{"a":1}\n{"b":2}\n');
  const size = statSync(path).size;
  assert.ok(size > 0 && size <= RESUMED_SESSION_WARN_BYTES);

  const r = await initOffsetIfUnknown({ store, sessionId: 's-small', transcriptPath: path });

  assert.equal(r.initialized, true);
  assert.equal(r.message, null, 'a short fresh transcript needs no resumed-session warning');
  assert.equal(store.getOffset('s-small'), size, 'still EOF-defaulted');
  assert.equal(store.hasOffsetRow('s-small'), true, 'still latched (exactly-once)');
});

test('fresh + MINDWRIGHT_SEED_TRANSCRIPT=1: offset stays 0, a value-0 row IS written (the latch), opt-in message', async () => {
  process.env.MINDWRIGHT_SEED_TRANSCRIPT = '1';
  const path = writeLargeTranscript(50);
  const size = statSync(path).size;

  const r = await initOffsetIfUnknown({ store, sessionId: 's-optin', transcriptPath: path });

  assert.equal(r.initialized, true);
  assert.equal(store.getOffset('s-optin'), 0, 'opt-in leaves the offset at 0 so the next flush chunks from the top');
  assert.equal(
    store.hasOffsetRow('s-optin'),
    true,
    'the original session-start code wrote NO row here — the latch fix MUST write a value-0 row',
  );
  assert.match(r.message, /MINDWRIGHT_SEED_TRANSCRIPT=1 — ingesting prior transcript \(\d+ bytes\)/);
  assert.match(r.message, new RegExp(`\\(${size} bytes\\)`));
});

test('SILENT-BREAK GUARD: with SEED=1 the helper NEVER applies the EOF default, even for a huge transcript', async () => {
  // The Critical: EOF-defaulting an opt-in session would silently skip the
  // very history the flag exists to ingest. size ≫ warn would, without the
  // guard, take the EOF/warn branch — assert it does NOT.
  process.env.MINDWRIGHT_SEED_TRANSCRIPT = '1';
  const path = writeLargeTranscript(500);
  const size = statSync(path).size;
  assert.ok(size > RESUMED_SESSION_WARN_BYTES);

  const r = await initOffsetIfUnknown({ store, sessionId: 's-guard', transcriptPath: path });

  assert.equal(store.getOffset('s-guard'), 0, 'offset MUST stay 0 — never EOF when opting in');
  assert.notEqual(store.getOffset('s-guard'), size, 'the EOF default must not have run');
  assert.match(r.message, /ingesting prior transcript/, 'opt-in message, NOT the "history skipped" warning');
  assert.doesNotMatch(r.message, /from before mindwright was tracking it/);
});

test('a row already exists → immediate no-op: initialized:false, message:null, offset untouched (the latch / steady state)', async () => {
  store.setOffset('s-tracked', 777); // a genuinely tracked session
  const path = writeLargeTranscript(100);

  const r = await initOffsetIfUnknown({ store, sessionId: 's-tracked', transcriptPath: path });

  assert.deepEqual(r, { initialized: false, message: null });
  assert.equal(store.getOffset('s-tracked'), 777, 'an already-tracked offset is never touched (zero live-capture regression)');
});

test('a row already exists is a no-op EVEN with SEED=1 (documented: the shared helper never re-ingests a tracked session)', async () => {
  // The deliberate consequence of the existence latch (interpretation chosen
  // for behavior-1): the original SessionStart "opt-in + already tracked →
  // reset to 0 + re-ingest" path is NOT replicated, because that reset is an
  // unbounded re-ingest loop when run from the per-flush backstop. Pinned so
  // the behavior change is intentional and visible, not an accident.
  process.env.MINDWRIGHT_SEED_TRANSCRIPT = '1';
  store.setOffset('s-tracked-optin', 5000);
  const path = writeLargeTranscript(100);

  const r = await initOffsetIfUnknown({ store, sessionId: 's-tracked-optin', transcriptPath: path });

  assert.deepEqual(r, { initialized: false, message: null });
  assert.equal(store.getOffset('s-tracked-optin'), 5000, 'NOT reset to 0 — the latch subsumes the old re-opt-in path');
});

test('empty transcript (size 0), non-opt-in: latches with setOffset(0), initialized:true, no message', async () => {
  const path = writeTinyTranscript('');
  assert.equal(statSync(path).size, 0);

  const r = await initOffsetIfUnknown({ store, sessionId: 's-empty', transcriptPath: path });

  assert.equal(r.initialized, true);
  assert.equal(r.message, null);
  assert.equal(store.getOffset('s-empty'), 0);
  assert.equal(store.hasOffsetRow('s-empty'), true, 'even an empty transcript must latch so the backstop is exactly-once');
});

test('empty transcript (size 0) + SEED=1: still just latches at 0 with no opt-in message (nothing to ingest)', async () => {
  process.env.MINDWRIGHT_SEED_TRANSCRIPT = '1';
  const path = writeTinyTranscript('');

  const r = await initOffsetIfUnknown({ store, sessionId: 's-empty-optin', transcriptPath: path });

  assert.equal(r.initialized, true);
  assert.equal(r.message, null, 'opt-in on an empty transcript has nothing to ingest → no message (matches original)');
  assert.equal(store.getOffset('s-empty-optin'), 0);
  assert.equal(store.hasOffsetRow('s-empty-optin'), true);
});

test('guards: no sessionId / missing transcript → {initialized:false, message:null} and no row written', async () => {
  const path = writeLargeTranscript(100);

  const noSession = await initOffsetIfUnknown({ store, sessionId: '', transcriptPath: path });
  assert.deepEqual(noSession, { initialized: false, message: null });

  const missing = await initOffsetIfUnknown({
    store,
    sessionId: 's-missing',
    transcriptPath: join(sandboxDir, 'does-not-exist.jsonl'),
  });
  assert.deepEqual(missing, { initialized: false, message: null });
  assert.equal(store.hasOffsetRow('s-missing'), false, 'a missing transcript must not latch — a later pass retries');
});

test('exactly-once (non-opt-in): the second call is a no-op and the offset is unchanged between calls', async () => {
  const path = writeLargeTranscript(150);
  const size = statSync(path).size;

  const first = await initOffsetIfUnknown({ store, sessionId: 's-once', transcriptPath: path });
  assert.equal(first.initialized, true);
  assert.equal(store.getOffset('s-once'), size);

  const second = await initOffsetIfUnknown({ store, sessionId: 's-once', transcriptPath: path });
  assert.deepEqual(second, { initialized: false, message: null }, 'the latch prevents re-init / re-warn');
  assert.equal(store.getOffset('s-once'), size, 'offset unchanged across the duplicate call');
});

test('exactly-once (fresh-opt-in): the value-0 latch row stops a second call re-emitting the opt-in message', async () => {
  // The plan Critical: the previously-rowless fresh-opt-in branch now writes a
  // value-0 row, so flush #2..#N (and the empty/whitespace-transcript case
  // where flushTranscript returns before its own setOffset) do NOT re-fire.
  process.env.MINDWRIGHT_SEED_TRANSCRIPT = '1';
  const path = writeLargeTranscript(40);

  const first = await initOffsetIfUnknown({ store, sessionId: 's-once-optin', transcriptPath: path });
  assert.equal(first.initialized, true);
  assert.match(first.message, /ingesting prior transcript/);
  assert.equal(store.getOffset('s-once-optin'), 0);

  const second = await initOffsetIfUnknown({ store, sessionId: 's-once-optin', transcriptPath: path });
  assert.deepEqual(second, { initialized: false, message: null }, 'no repeated opt-in message; latch held by the value-0 row');
  assert.equal(store.getOffset('s-once-optin'), 0, 'offset never moved to EOF — the flag is not silently broken');
});

test('countTranscriptRecords is re-exported from offset-init and counts newline-delimited records', async () => {
  // The relocation boundary: its full branch behavior is pinned by the
  // relocated test/count-transcript-records.test.js; here just prove the new
  // module surface exposes it and the happy path is intact.
  const path = writeTinyTranscript('{"a":1}\n{"b":2}\n{"c":3}\n');
  assert.equal(await countTranscriptRecords(path), 3);
});
