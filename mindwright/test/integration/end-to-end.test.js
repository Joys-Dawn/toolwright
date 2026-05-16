// End-to-end integration test.
//
// Exercises a realistic session arc without external models or a live MCP
// server:
//   1) write a synthetic JSONL transcript;
//   2) spawn session-start.js → user-prompt-submit.js → pre-tool-use.js → stop.js
//      in sequence with stdin matching the real hook input shape;
//   3) directly call drainBatch / retainFact / markSuperseded / finalizeDrain
//      from lib/consolidator.js to simulate the calling-Claude-driven dream
//      cycle (using deterministic stub embed/rerank);
//   4) call retrieve() with the stub models, assert the planted long-term
//      row is reachable.
//
// Stub models: the daemon isn't running in this test, so the hooks degrade
// to write-only mode (embedding=NULL, retrieval skipped). The dream cycle
// uses in-process stubs so retainFact can complete an embed-on-write that
// the TEMPR retrieval at the end can score against.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from '../../lib/store.js';
import {
  drainBatch,
  retainFact,
  finalizeDrain,
} from '../../lib/consolidator.js';
import { retrieve } from '../../lib/retriever.js';
import { runSeedLoop } from '../../lib/seed-loop.js';
import { shouldAutoSeed } from '../../lib/seed-trigger.js';
import { transcriptsDir as resolveTranscriptsDir } from '../../lib/paths.js';
import { CAP_EXCHANGES } from '../../lib/constants.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PLUGIN_ROOT = resolve(__dirname, '..', '..');
const HOOKS_DIR = join(PLUGIN_ROOT, 'hooks');

// -- Stub models --------------------------------------------------------------
// Deterministic so the retain → recall path is reproducible. Two distinct
// content snippets get two distinct vectors so cosine ordering is meaningful.

function makeStubEmbed() {
  return async function stubEmbed(texts) {
    return texts.map((t) => {
      const v = new Float32Array(1024);
      // Seed from a hash of the text so different inputs get different vectors.
      let h = 0;
      for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) | 0;
      for (let i = 0; i < 1024; i++) {
        // Mix in i so adjacent positions vary; mod into [-1, 1].
        const x = Math.sin(h + i * 0.7);
        v[i] = x;
      }
      // L2 normalize so cosine semantics behave.
      let n = 0;
      for (let i = 0; i < 1024; i++) n += v[i] * v[i];
      n = Math.sqrt(n) || 1;
      for (let i = 0; i < 1024; i++) v[i] /= n;
      return v;
    });
  };
}

function makeStubRerank() {
  // Always-relevant rerank — every candidate surpasses the 0.10 floor so the
  // retrieval pipeline reflects fusion ordering rather than abstaining.
  return async function stubRerank(_query, candidates) {
    return candidates.map((c, i) => 0.5 + (1 / (i + 2)) * 0.1);
  };
}

// -- Fixtures -----------------------------------------------------------------

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'mindwright-e2e-'));
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

function runHook(name, input, projectRoot, extraEnv = {}) {
  const res = spawnSync(
    process.execPath,
    [join(HOOKS_DIR, name)],
    {
      input: JSON.stringify(input),
      encoding: 'utf8',
      env: { ...process.env, MINDWRIGHT_PROJECT_ROOT: projectRoot, ...extraEnv },
    }
  );
  let parsed = {};
  try {
    parsed = JSON.parse((res.stdout || '').trim() || '{}');
  } catch {
    parsed = {};
  }
  return { status: res.status, stdout: parsed, stderr: res.stderr };
}

function writeTranscript(dir, sessionId, recs) {
  const path = join(dir, `${sessionId}.jsonl`);
  writeFileSync(path, recs.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return path;
}

// -- The test -----------------------------------------------------------------

test('end-to-end: session writes → dream → recall surfaces planted fact', async () => {
  const sb = sandbox();
  const sessionId = 'e2e-session';
  try {
    // (1) Session arc — UserPromptSubmit, then 5 PreToolUse passes, then Stop.
    // The transcript grows each step to simulate a real autonomous loop.
    const transcript = [userRec("let's refactor the auth module to use bcrypt")];
    const transcriptPath = writeTranscript(sb.dir, sessionId, transcript);

    // SessionStart sets offset to EOF and ticket.
    runHook('session-start.js', {
      session_id: sessionId,
      transcript_path: transcriptPath,
      hook_event_name: 'SessionStart',
      source: 'startup',
    }, sb.dir);

    // UserPromptSubmit writes the cli_prompt row (NULL embed; daemon down).
    runHook('user-prompt-submit.js', {
      session_id: sessionId,
      transcript_path: transcriptPath,
      hook_event_name: 'UserPromptSubmit',
      prompt: "let's refactor the auth module to use bcrypt",
    }, sb.dir);

    // Five PreToolUse passes, each appending a chunk to the transcript.
    for (let i = 0; i < 5; i++) {
      transcript.push(thinkingRec(`step ${i}: consider migration safety and existing password hashes`, `2026-05-13T00:0${i}:01Z`));
      transcript.push(textRec(`running step ${i}`, `2026-05-13T00:0${i}:02Z`));
      writeFileSync(transcriptPath, transcript.map((r) => JSON.stringify(r)).join('\n') + '\n');
      runHook('pre-tool-use.js', {
        session_id: sessionId,
        transcript_path: transcriptPath,
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
      }, sb.dir);
    }

    // Stop flushes the tail.
    runHook('stop.js', {
      session_id: sessionId,
      transcript_path: transcriptPath,
      hook_event_name: 'Stop',
      stop_hook_active: false,
    }, sb.dir);

    // Sanity — short-term should have rows now.
    const store = openStore();
    let plantedFactId;
    try {
      const shortCount = store.countShortTermFor(sessionId);
      assert.ok(shortCount >= 6, `expected ≥6 short-term rows after session arc, got ${shortCount}`);

      // (2) Dream cycle. Drive drainBatch → retainFact → finalizeDrain
      // directly (would normally come from the calling Claude session).
      const stubEmbed = makeStubEmbed();
      const stubRerank = makeStubRerank();

      const batch = drainBatch({ store, sessionId });
      assert.ok(batch.drain_id, 'drain_id must be present');
      assert.ok(Array.isArray(batch.exchanges), 'exchanges must be an array');
      assert.ok(batch.exchanges.length > 0, 'expected at least one exchange to drain');

      // Plant one durable fact pretending the calling session distilled it.
      const planted = 'The auth module must keep bcrypt cost factor at 12 for backwards compatibility with existing hashes.';
      const ex = batch.exchanges[0];
      const r = await retainFact({
        store,
        drainId: batch.drain_id,
        exchangeId: ex.exchange_id,
        content: planted,
        category: 'fact',
        scope: 'project',
        entities: ['bcrypt'],
        confidence: null,
        embed: stubEmbed,
        rerank: stubRerank,
      });
      assert.ok(r.fact_id, `retainFact must return fact_id, got ${JSON.stringify(r)}`);
      plantedFactId = r.fact_id;

      // Finalize — hard-delete the drained short-term rows.
      const final = finalizeDrain({
        store,
        drainId: batch.drain_id,
        drainCutoff: batch.drain_cutoff,
        drainCutoffId: batch.drain_cutoff_id,
        sessionId,
      });
      assert.ok(final, 'finalizeDrain must return something');
      assert.ok(final.drained_count > 0, `expected drained_count > 0, got ${final.drained_count}`);

      // (3) Recall — the planted fact must surface.
      const hits = await retrieve({
        store,
        queryText: 'how should we configure bcrypt for the auth module?',
        embed: stubEmbed,
        rerank: stubRerank,
        options: { k: 5 },
      });
      assert.ok(hits.length > 0, 'expected at least one hit from retrieve()');
      const hit = hits.find((h) => Number(h.id) === Number(plantedFactId));
      assert.ok(
        hit,
        `planted fact (id=${plantedFactId}) should be in top-K; got ids=${hits.map((h) => h.id).join(',')}`
      );
      assert.equal(hit.tier, 'long');
      assert.equal(hit.category, 'fact');
      assert.equal(hit.scope, 'project');
      assert.ok(hit.content.includes('bcrypt cost factor at 12'));
    } finally {
      store.close();
    }
  } finally {
    sb.cleanup();
  }
});

test('end-to-end: empty short-term → drainBatch returns no exchanges (no-op dream)', () => {
  const sb = sandbox();
  try {
    const store = openStore();
    try {
      const batch = drainBatch({ store, sessionId: 'never-existed' });
      assert.equal(batch.exchanges.length, 0, 'drain on empty store yields no exchanges');
    } finally {
      store.close();
    }
  } finally {
    sb.cleanup();
  }
});

test('end-to-end: cap-fire path — Stop stages the dream cue, next UPS drains it', () => {
  // Stop has no user-visible context surface (DESIGN.md:379), so the cue is
  // staged in `meta` by Stop and surfaced as additionalContext by the next
  // UserPromptSubmit firing — that's where the user sees it.
  const sb = sandbox();
  const sessionId = 'capfire';
  try {
    const transcriptPath = writeTranscript(sb.dir, sessionId, [userRec('x')]);
    // Pre-seed CAP_EXCHANGES rows so the Stop hook surfaces its cue.
    const store = openStore();
    try {
      for (let i = 0; i < CAP_EXCHANGES; i++) {
        store.insertEntry({
          tier: 'short',
          kind: 'thinking',
          content: `seed-${i}`,
          sessionId,
        });
      }
    } finally {
      store.close();
    }
    // Force the legacy nudge-staging path so this test can observe the cue.
    // The default auto-spawn path is fire-and-forget; spawn() doesn't block
    // on child failure, so without the disable flag Stop would think the
    // consolidator launched and skip the fallback nudge.
    const { stdout } = runHook('stop.js', {
      session_id: sessionId,
      transcript_path: transcriptPath,
      hook_event_name: 'Stop',
      stop_hook_active: false,
    }, sb.dir, { MINDWRIGHT_SPAWN_DISABLE: '1' });
    assert.deepEqual(stdout, {}, 'Stop emits `{}`');

    // The next user prompt drains the staged cue via UserPromptSubmit.
    const { stdout: upsOut } = runHook('user-prompt-submit.js', {
      session_id: sessionId,
      transcript_path: transcriptPath,
      hook_event_name: 'UserPromptSubmit',
      prompt: 'follow-up',
    }, sb.dir);
    assert.ok(upsOut.hookSpecificOutput, 'UPS must surface the staged cue');
    assert.match(upsOut.hookSpecificOutput.additionalContext, /cap reached/i);
    assert.match(upsOut.hookSpecificOutput.additionalContext, /\/mindwright:dream/);
  } finally {
    sb.cleanup();
  }
});

test('end-to-end: empty DB + transcript corpus → seed loop → dream → recall ranks by event-time', async () => {
  // The full bootstrap arc the foundation work exists for: a fresh empty
  // store, a pre-install transcript corpus on disk, the dedicated seed loop
  // folding it into short-term with true JSONL event-times, the EXISTING
  // hand-driven dream cycle distilling it (the harness deliberately does NOT
  // run the LLM — drainBatch/retainFact/finalizeDrain are called directly),
  // and retrieval ranking the resulting facts by when they actually happened.
  const sb = sandbox();
  const txDir = mkdtempSync(join(tmpdir(), 'mindwright-e2e-tx-'));
  try {
    // Two structurally-real transcripts about the SAME topic, far apart in
    // time. Each: a plain-string CLI user prompt (→ cli_prompt, an exchange
    // opener) + an assistant thinking block, every record with a stable uuid
    // and an ISO timestamp — exactly the shape the live chunker parses.
    const OLD_TS = '2024-02-01T00:00:00.000Z';
    const NEW_TS = '2026-05-10T00:00:00.000Z'; // a few days before the fixed NOW
    const recs = (ts, u1, u2) => [
      JSON.stringify({ type: 'user', message: { content: 'document the cache eviction policy' }, timestamp: ts, uuid: u1 }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'the cache eviction policy is LRU with a 1000-entry ceiling' }] }, timestamp: ts, uuid: u2 }),
    ].join('\n') + '\n';
    writeFileSync(join(txDir, 'e2e-old.jsonl'), recs(OLD_TS, 'u-old', 'a-old'));
    writeFileSync(join(txDir, 'e2e-new.jsonl'), recs(NEW_TS, 'u-new', 'a-new'));

    const store = openStore();
    try {
      // (1) Seed loop ingests the corpus into short-term.
      const summary = await runSeedLoop({ store, transcriptsDir: txDir });
      assert.equal(summary.transcriptsSeeded, 2, 'both pre-install transcripts seed');
      assert.ok(summary.rowsInserted >= 4, `expected ≥4 seeded rows, got ${summary.rowsInserted}`);

      const shortRows = store.db.prepare(
        `SELECT session_id, kind, event_ts, scope, source_ref
           FROM entries WHERE tier='short' AND active=1 ORDER BY id ASC`,
      ).all();
      assert.equal(shortRows.length, summary.rowsInserted);
      // (1a) Every seed row carries the originating JSONL timestamp verbatim
      // as event_ts, is scope-NULL (a raw transcript carries no role — the
      // loop never produces role:-scoped rows), and has a durable
      // <basename>:<uuid> source_ref.
      for (const r of shortRows) {
        assert.equal(r.scope, null, 'transcript seed rows must never be role-scoped');
        assert.ok(r.event_ts === OLD_TS || r.event_ts === NEW_TS,
          `event_ts must be the JSONL timestamp, got ${JSON.stringify(r.event_ts)}`);
        assert.match(r.source_ref, /^e2e-(old|new)\.jsonl:/);
      }
      assert.ok(shortRows.some((r) => r.event_ts === OLD_TS), 'the old transcript contributed rows');
      assert.ok(shortRows.some((r) => r.event_ts === NEW_TS), 'the new transcript contributed rows');

      // (2) Hand-driven dream, per seeded session.
      const stubEmbed = makeStubEmbed();
      const stubRerank = makeStubRerank();
      const planted = {};
      for (const sid of ['e2e-old', 'e2e-new']) {
        const expectTs = sid === 'e2e-old' ? OLD_TS : NEW_TS;
        const batch = drainBatch({ store, sessionId: sid });
        assert.ok(batch.exchanges.length > 0, `drain for ${sid} must yield an exchange`);
        const ex = batch.exchanges[0];

        // (2a) drainBatch surfaces event_ts on each drained row AND as the
        // exchange's representative (max) — additive payload only; the
        // (created_at,id) drain cursor is unchanged (governing invariant).
        assert.ok(ex.rows.length > 0, 'the exchange holds its drained rows');
        for (const rw of ex.rows) {
          assert.equal(rw.event_ts, expectTs, 'each drained row carries its JSONL event_ts');
        }
        assert.equal(ex.event_ts, expectTs,
          'exchange representative event_ts = max of its rows (uniform within a transcript here)');

        // (3) retainFact given that representative eventTs stamps it onto the
        // long-term row (not re-stamped to now()).
        const r = await retainFact({
          store,
          drainId: batch.drain_id,
          exchangeId: ex.exchange_id,
          content: 'The cache eviction policy is LRU with a 1000-entry ceiling.',
          category: 'fact',
          scope: 'project',
          entities: ['cache'],
          eventTs: ex.event_ts,
          embed: stubEmbed,
          rerank: stubRerank,
        });
        assert.ok(r.fact_id, `retainFact must return fact_id for ${sid}`);
        const stored = store.db.prepare('SELECT tier, event_ts FROM entries WHERE id=?').get(r.fact_id);
        assert.equal(stored.tier, 'long');
        assert.equal(stored.event_ts, expectTs,
          'retainFact stamps the originating exchange event_ts on the long-term row');

        finalizeDrain({
          store,
          drainId: batch.drain_id,
          drainCutoff: batch.drain_cutoff,
          drainCutoffId: batch.drain_cutoff_id,
          sessionId: sid,
        });
        planted[sid] = Number(r.fact_id);
      }

      // (4) Recall ranks the newer-event_ts fact ahead of the older one.
      // The two long-term facts have IDENTICAL content, so embedding, bm25,
      // and rerank are tied — the ONLY thing that can separate them is
      // recency over COALESCE(event_ts, created_at). created_at is the same
      // seed-run instant for both; event_ts is the real differentiator. A
      // fixed `now` makes the recency-boost math deterministic.
      const NOW = Date.parse('2026-05-15T00:00:00.000Z');
      const hits = await retrieve({
        store,
        queryText: 'what is the cache eviction policy?',
        embed: stubEmbed,
        rerank: stubRerank,
        now: NOW,
        options: { k: 5 },
      });
      const iNew = hits.findIndex((h) => Number(h.id) === planted['e2e-new']);
      const iOld = hits.findIndex((h) => Number(h.id) === planted['e2e-old']);
      assert.ok(iNew !== -1 && iOld !== -1,
        `both planted facts must surface; got ids=${hits.map((h) => h.id).join(',')}`);
      assert.ok(iNew < iOld,
        `newer-event_ts fact (id=${planted['e2e-new']}) must outrank older (id=${planted['e2e-old']}); order=${hits.map((h) => h.id).join(',')}`);

      // (4a) The recency-surfacing projection: retrieve()'s return literal
      // carries event_ts (NOT seed-run created_at) — the value recall-format's
      // ts= token shows the user as "when it happened".
      assert.equal(hits[iNew].event_ts, NEW_TS);
      assert.equal(hits[iOld].event_ts, OLD_TS);
    } finally {
      store.close();
    }
  } finally {
    rmSync(txDir, { recursive: true, force: true });
    sb.cleanup();
  }
});

// -- behavior-1: auto-seed trigger relocation (Stop → SessionStart) -----------
//
// The marquee "a fresh install learns from your project's history" feature was
// a silent no-op: the gate was hosted by Stop, but Stop runs flushTranscript
// (and UserPromptSubmit/PreToolUse already flushed earlier in the same turn),
// so the empty-memory precondition could never hold by the first Stop. The fix
// relocated the gate to SessionStart — the only hook that runs before the
// turn's first flush. These two tests are the integration coverage the finding
// required: a deterministic ordering-regression guard, and the real
// SessionStart hook firing the loop end-to-end.

// Set MINDWRIGHT_CLAUDE_PROJECTS_DIR so transcriptsDir() resolves to a fixture
// tree; create the real per-project dir; restore env on cleanup (node --test
// runs every file in one process — a leak would corrupt sibling suites).
function withClaudeProjects(fn) {
  const prev = process.env.MINDWRIGHT_CLAUDE_PROJECTS_DIR;
  const cpd = mkdtempSync(join(tmpdir(), 'mindwright-e2e-cpd-'));
  process.env.MINDWRIGHT_CLAUDE_PROJECTS_DIR = cpd;
  const txDir = resolveTranscriptsDir();
  mkdirSync(txDir, { recursive: true });
  return Promise.resolve(fn(txDir)).finally(() => {
    if (prev === undefined) delete process.env.MINDWRIGHT_CLAUDE_PROJECTS_DIR;
    else process.env.MINDWRIGHT_CLAUDE_PROJECTS_DIR = prev;
    try { rmSync(cpd, { recursive: true, force: true }); } catch { /* tmp */ }
  });
}

test('behavior-1 regression: the auto-seed gate passes at SessionStart-time but is false after the first live flush (proves it must be SessionStart-hosted, not Stop-hosted)', async () => {
  const sb = sandbox();
  const sessionId = 'b1-current-session';
  try {
    await withClaudeProjects((txDir) => {
      // A genuinely pre-install transcript (a DIFFERENT session id → no
      // offsets row → eligible to seed).
      writeTranscript(txDir, 'b1-pre-install', [
        userRec('pre-install: document the retry backoff', '2024-01-02T03:04:05.000Z'),
      ]);

      // (1) The SessionStart observation point: memory is genuinely empty, so
      //     the gate passes — this is the only point it CAN pass.
      let store = openStore();
      try {
        assert.equal(
          shouldAutoSeed(store, sessionId, txDir), true,
          'fresh empty install + a pre-install transcript → gate must pass at SessionStart',
        );
      } finally { store.close(); }

      // (2) The turn's first live flush. UserPromptSubmit writes a cli_prompt
      //     short row — exactly what happens before the first Stop (PreToolUse
      //     and Stop's own flush write still more). This is the REAL hook.
      const liveTranscript = writeTranscript(sb.dir, sessionId, [userRec('do the work')]);
      runHook('user-prompt-submit.js', {
        session_id: sessionId,
        transcript_path: liveTranscript,
        hook_event_name: 'UserPromptSubmit',
        prompt: 'do the work',
      }, sb.dir);

      // (3) Post-flush: the original Stop-hosted gate would be evaluated HERE
      //     and could never fire — the exact silent no-op behavior-1 named.
      //     SessionStart evaluated it at (1), before this write — the fix.
      store = openStore();
      try {
        assert.ok(store.countByTier().short > 0, 'the live flush populated short-term');
        assert.equal(
          shouldAutoSeed(store, sessionId, txDir), false,
          'after the first flush the gate is false — a Stop-hosted gate could never have fired',
        );
      } finally { store.close(); }
    });
  } finally {
    sb.cleanup();
  }
});

test('behavior-1: the real SessionStart hook fires the transcript-bootstrap loop on a fresh empty install (and skips the live session)', async () => {
  const sb = sandbox();
  const sessionId = 'b1-live-session';
  try {
    await withClaudeProjects(async (txDir) => {
      // Pre-install corpus — a DIFFERENT session, durable uuid so the loop's
      // <basename>:<uuid> source_ref is an unambiguous "the loop did this".
      writeFileSync(
        join(txDir, 'b1-pre-install.jsonl'),
        JSON.stringify({
          type: 'user',
          message: { content: 'pre-install prompt about the cache layer' },
          timestamp: '2024-03-04T05:06:07.000Z',
          uuid: 'pre-1',
        }) + '\n',
      );
      // The current live session's OWN transcript lives in the same dir (as
      // Claude Code really lays it out). SessionStart sets its offset to EOF,
      // so the loop must SKIP it — never double-ingest live content.
      const liveTranscript = writeTranscript(sb.dir, sessionId, [userRec('current live work')]);
      writeTranscript(txDir, sessionId, [userRec('current live work')]);

      // Real SessionStart hook. Seed-loop seam ENABLED (we want the real
      // detached loop); MINDWRIGHT_SPAWN_DISABLE=1 so its consolidate no-ops
      // (no real `claude --bg`) — the seed rows still land during ingest.
      const { status } = runHook('session-start.js', {
        session_id: sessionId,
        transcript_path: liveTranscript,
        hook_event_name: 'SessionStart',
        source: 'startup',
      }, sb.dir, { MINDWRIGHT_SPAWN_DISABLE: '1' });
      assert.equal(status, 0, 'SessionStart must exit cleanly');

      // The loop is detached/fire-and-forget — poll the DB (bounded) for its
      // committed rows. The pre-install transcript's durable source_ref is the
      // signal it was the loop, not live capture.
      const deadline = Date.now() + 15000;
      let seeded = [];
      while (Date.now() < deadline) {
        const store = openStore();
        try {
          seeded = store.db.prepare(
            `SELECT source_ref FROM entries
               WHERE tier='short' AND active=1
                 AND source_ref LIKE 'b1-pre-install.jsonl:%'`,
          ).all();
        } finally { store.close(); }
        if (seeded.length > 0) break;
        await new Promise((r) => setTimeout(r, 200));
      }
      assert.ok(
        seeded.length > 0,
        'the real SessionStart hook must trigger the seed loop → the pre-install transcript is folded into short-term',
      );

      // The live session was marked live by SessionStart's offset write and
      // must never be seed-ingested (no rows sourced from its transcript).
      const store = openStore();
      try {
        const liveSeeded = store.db.prepare(
          `SELECT COUNT(*) n FROM entries WHERE source_ref LIKE ?`,
        ).get(`${sessionId}.jsonl:%`).n;
        assert.equal(liveSeeded, 0, 'the current live session must never be seed-ingested');
      } finally { store.close(); }
    });
  } finally {
    sb.cleanup();
  }
});
