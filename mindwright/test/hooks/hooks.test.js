// Tests for the 5 hook scripts. Each one is spawned as a subprocess with
// synthetic stdin JSON; we assert (a) it returns a non-zero JSON envelope on
// stdout (always — Claude Code requires {} at minimum), (b) DB side effects,
// and (c) the PreToolUse retrieval gate's named cases.
//
// The pipe-client is intentionally NOT mocked: with no live daemon the
// embed/rerank calls return null and the hook degrades to write-only. That's
// exactly the path we want to exercise — model machinery has its own tests.
// Live-daemon retrieval is covered by the end-to-end integration test.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, statSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from '../../lib/store.js';
import {
  CAP_EXCHANGES,
  SAFETY_NET_DAYS,
  CONSOLIDATOR_COMPLETION_GRACE_MS,
} from '../../lib/constants.js';
import { deriveHandle } from '../../lib/handles.js';

// All Stop-hook tests in this file exercise the fallback nudge-staging path,
// not the auto-spawn path. Setting MINDWRIGHT_SPAWN_DISABLE=1 makes every
// hook subprocess (which inherits parent env via runHook) skip the spawn
// branch and stage the pending nudge. Tests of the spawn path itself live
// elsewhere and explicitly clear this var. We snapshot+restore around the
// suite so the mutation does not leak into sibling test files when node
// --test runs everything in the same process.
let prevSpawnDisable;
before(() => {
  prevSpawnDisable = process.env.MINDWRIGHT_SPAWN_DISABLE;
  process.env.MINDWRIGHT_SPAWN_DISABLE = '1';
});
after(() => {
  if (prevSpawnDisable === undefined) delete process.env.MINDWRIGHT_SPAWN_DISABLE;
  else process.env.MINDWRIGHT_SPAWN_DISABLE = prevSpawnDisable;
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PLUGIN_ROOT = resolve(__dirname, '..', '..');
const HOOKS_DIR = join(PLUGIN_ROOT, 'hooks');

function setupIsolatedRoot({ withModelCache = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mindwright-hooks-'));
  const homeDir = mkdtempSync(join(tmpdir(), 'mindwright-home-'));
  const cacheDir = mkdtempSync(join(tmpdir(), 'mindwright-cache-'));
  const prev = process.env.MINDWRIGHT_PROJECT_ROOT;
  const prevCache = process.env.MINDWRIGHT_MODEL_CACHE_DIR;
  const prevSock = process.env.MINDWRIGHT_MODEL_DAEMON_SOCK;
  const prevDaemonDisable = process.env.MINDWRIGHT_MODEL_DAEMON_DISABLE;
  // Set parent-process env so verify-side openStore() lands in the same dir
  // as the hook subprocess's openStore().
  process.env.MINDWRIGHT_PROJECT_ROOT = dir;
  // Pin the embedder probe (embedderCached → modelCacheDir) to a throwaway
  // dir for BOTH this process and every runHook child (inherited via
  // ...process.env), so the now-populated real dev-tree model-cache can never
  // leak in and flip embedderCached() true during the not-cached assertions.
  // Default: plant the transformers.js <org>/<name> embedder repo so
  // SessionStart's not-cached hint does NOT fire during unrelated assertions;
  // tests that specifically exercise the missing-model hint opt out with
  // withModelCache:false (cacheDir stays empty → embedderCached() is false).
  process.env.MINDWRIGHT_MODEL_CACHE_DIR = cacheDir;
  if (withModelCache) {
    mkdirSync(join(cacheDir, 'Xenova', 'bge-m3'), { recursive: true });
  }
  // Isolate the MACHINE-WIDE model daemon (same parent-env-inheritance trick).
  // On win32 modelDaemonSocketPath() is the FIXED, homedir-independent pipe
  // `\\.\pipe\mindwright-modeld-v1`, so a HOME redirect does NOT isolate it:
  // without this override a hook subprocess connects to whatever real daemon
  // is live on the dev box, gets real embeddings, and the daemon-down
  // assertions can never be satisfied (and a stray ensureModelDaemon() respawn
  // would leak a detached machine-global node process out of the test run).
  // Point the socket at a path with no listener (connect fails fast → embed
  // returns null → the degrade path the hooks are unit-tested for) and
  // hard-disable the lazy respawn — the canonical daemon-isolation idiom (see
  // daemon-pipe.test.mjs / _cli-harness.mjs).
  process.env.MINDWRIGHT_MODEL_DAEMON_SOCK = join(cacheDir, 'no-daemon-here.sock');
  process.env.MINDWRIGHT_MODEL_DAEMON_DISABLE = '1';
  return {
    dir,
    homeDir,
    cleanup() {
      if (prev === undefined) delete process.env.MINDWRIGHT_PROJECT_ROOT;
      else process.env.MINDWRIGHT_PROJECT_ROOT = prev;
      if (prevCache === undefined) delete process.env.MINDWRIGHT_MODEL_CACHE_DIR;
      else process.env.MINDWRIGHT_MODEL_CACHE_DIR = prevCache;
      if (prevSock === undefined) delete process.env.MINDWRIGHT_MODEL_DAEMON_SOCK;
      else process.env.MINDWRIGHT_MODEL_DAEMON_SOCK = prevSock;
      if (prevDaemonDisable === undefined) delete process.env.MINDWRIGHT_MODEL_DAEMON_DISABLE;
      else process.env.MINDWRIGHT_MODEL_DAEMON_DISABLE = prevDaemonDisable;
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* tmp */ }
      try { rmSync(homeDir, { recursive: true, force: true }); } catch { /* tmp */ }
      try { rmSync(cacheDir, { recursive: true, force: true }); } catch { /* tmp */ }
    },
  };
}

function runHook(name, input, projectRoot, homeDir = null, extraEnv = {}) {
  const env = { ...process.env, MINDWRIGHT_PROJECT_ROOT: projectRoot, ...extraEnv };
  if (homeDir) {
    // Redirect Node's homedir() in the child so the Claude transcript/
    // native-memory dirs under ~/.claude stay under a tmp we control. HOME
    // (POSIX) + USERPROFILE (Windows) covers both. The model cache and the
    // machine-wide model daemon are isolated separately (and unconditionally)
    // via MINDWRIGHT_MODEL_CACHE_DIR / MINDWRIGHT_MODEL_DAEMON_SOCK.
    env.HOME = homeDir;
    env.USERPROFILE = homeDir;
  }
  const res = spawnSync(
    process.execPath,
    [join(HOOKS_DIR, name)],
    {
      input: JSON.stringify(input),
      encoding: 'utf8',
      env,
    }
  );
  // stdout MUST be a single newline-terminated JSON object — the harness
  // tolerates malformed but for our hooks we always emit {}.
  const stdout = res.stdout.trim();
  let parsed = {};
  try {
    parsed = JSON.parse(stdout);
  } catch {
    // hook crashed before emitting JSON
  }
  return { status: res.status, stdout: parsed, stderr: res.stderr };
}

function writeTranscript(dir, sessionId, recs) {
  const path = join(dir, `${sessionId}.jsonl`);
  const body = recs.map((r) => JSON.stringify(r)).join('\n') + '\n';
  writeFileSync(path, body);
  return path;
}

// Pre-seed the offsets row exactly as SessionStart does in production before
// any mid-session hook fires. Step 7 added a behavior-1 backstop to
// flushTranscript: an UNKNOWN session (no offsets row) has its offset
// defaulted to EOF so pre-mindwright history is not retroactively ingested.
// In production SessionStart always runs first and writes the row, so
// mid-session hooks no-op the backstop and flush normally. These tests run a
// mid-session hook in isolation; without this the backstop would (correctly)
// eat the offset to EOF and the hook would chunk nothing. The behavior-1 path
// itself is covered by offset-init/transcript-flush tests — here we exercise
// the hooks' own chunk-and-flush machinery, so we put the session in the
// tracked-from-byte-0 steady state (row = 0 ⇒ backstop no-ops ⇒ chunk from
// the top, byte-identical to pre-Step-7).
function seedTrackedFromZero(sessionId) {
  const store = openStore();
  try {
    store.setOffset(sessionId, 0);
  } finally {
    store.close();
  }
}

// Mechanical setup shared by the three behavior-5 reconcile tests: seed the
// project past CAP_EXCHANGES as PENDING rows, then run one PreCompact with
// auto-spawn enabled (a fake `claude` binary so spawnConsolidator succeeds
// and persists the consolidator_for record with last_spawn, but no real
// dream runs → no consolidations row). Cap-fire moved from Stop to
// PreCompact/SessionEnd under the pending-staging design — the trigger fires
// at the promotion boundary, not on every Stop. Asserts the post-spawn
// state and returns the pieces each test needs to drive its own scenario
// (backdate the lease, record a consolidation, etc.). Scenario-specific
// manipulation stays inline in the tests (DAMP) — only this boilerplate is
// extracted.
//
// Returns `stopInput`/`stopEnv` for tests that then drive Stop (where
// reconcile lives) AFTER priming the FIRED+last_spawn state at PreCompact.
function primeAutoSpawnedConsolidator(dir, sessionId) {
  const transcriptPath = writeTranscript(dir, sessionId, [userRec('x')]);
  const fakeBin = process.platform === 'win32'
    ? process.execPath
    : (() => {
        const p = join(dir, `fake-claude-${sessionId}.sh`);
        writeFileSync(p, `#!/bin/sh\necho fake-sid-${sessionId}\nexit 0\n`, 'utf8');
        chmodSync(p, 0o755);
        return p;
      })();
  let store = openStore();
  try {
    // Seed CAP_EXCHANGES rows as PENDING for this session. PreCompact will
    // promote them all in one go, the cap will cross at promotion, and
    // promote-pending.js will fire the spawn.
    for (let i = 0; i < CAP_EXCHANGES; i++) {
      store.insertEntry({
        tier: 'short', kind: 'thinking',
        content: `seed ${i}`, sessionId, pendingSessionId: sessionId,
      });
    }
  } finally { store.close(); }

  const input = {
    session_id: sessionId,
    transcript_path: transcriptPath,
    hook_event_name: 'PreCompact',
    trigger: 'manual',
  };
  // Clear the suite-wide MINDWRIGHT_SPAWN_DISABLE=1 so the spawn path runs.
  const spawnEnv = { MINDWRIGHT_SPAWN_DISABLE: '', MINDWRIGHT_SPAWN_FAKE: fakeBin };

  runHook('pre-compact.js', input, dir, null, spawnEnv);

  // After PreCompact: pending rows promoted, cap crossed, spawn fired, state
  // FIRED. The Stop reconcile path will be exercised by the caller using the
  // stopInput/stopEnv pair.
  const stopInput = {
    session_id: sessionId,
    transcript_path: transcriptPath,
    hook_event_name: 'Stop',
    stop_hook_active: false,
  };

  const handle = deriveHandle(sessionId);
  store = openStore();
  try {
    const rec = store.getConsolidatorFor(handle);
    assert.ok(rec && rec.last_spawn,
      'precondition: auto-spawn must persist a consolidator_for record with last_spawn');
    assert.equal(store.getNudgeState(), 'fired',
      'precondition: a successful auto-spawn sets FIRED');
    assert.equal(
      store.db.prepare('SELECT value FROM meta WHERE key = ?').get(`pending_nudge:${sessionId}`),
      undefined,
      'precondition: the auto-spawn path does NOT stage a fallback nudge');
    assert.equal(store.lastConsolidation(), undefined,
      'precondition: a fake spawn writes no consolidations row');
    return { handle, input: stopInput, spawnEnv, rec };
  } finally { store.close(); }
}

function userRec(content, timestamp = '2026-05-13T00:00:00Z') {
  return {
    type: 'user',
    message: { content },
    timestamp,
  };
}
function assistantThinkingRec(text, timestamp = '2026-05-13T00:00:01Z') {
  return {
    type: 'assistant',
    message: {
      content: [{ type: 'thinking', thinking: text }],
    },
    timestamp,
  };
}
function assistantTextRec(text, timestamp = '2026-05-13T00:00:02Z') {
  return {
    type: 'assistant',
    message: {
      content: [{ type: 'text', text }],
    },
    timestamp,
  };
}

// ----- SessionStart -------------------------------------------------------

test('session-start initializes offset to EOF for a fresh session', () => {
  const { dir, cleanup } = setupIsolatedRoot();
  try {
    const transcriptPath = writeTranscript(dir, 'sess-A', [
      userRec('hello'),
      assistantTextRec('hi back'),
    ]);
    const size = statSync(transcriptPath).size;
    // Pre-seed one long-term row so the SessionStart hook has something
    // actionable to announce — without it, the no-news path emits {}.
    const seedStore = openStore();
    try {
      seedStore.insertEntry({
        tier: 'long', category: 'fact', scope: 'project', kind: 'fact',
        content: 'pre-seeded fact for status line', sessionId: 's',
      });
    } finally { seedStore.close(); }

    const { status, stdout } = runHook('session-start.js', {
      session_id: 'sess-A',
      transcript_path: transcriptPath,
      hook_event_name: 'SessionStart',
      source: 'startup',
    }, dir);
    assert.equal(status, 0);
    assert.ok(stdout.hookSpecificOutput, 'expected hookSpecificOutput');
    assert.equal(stdout.hookSpecificOutput.hookEventName, 'SessionStart');
    assert.match(stdout.hookSpecificOutput.additionalContext, /mindwright bound/);
    // Verify offset set to EOF
    const store = openStore();
    try {
      assert.equal(store.getOffset('sess-A'), size);
    } finally {
      store.close();
    }
  } finally {
    cleanup();
  }
});

test('session-start injects the self-recall rule when the embedder cache is present', () => {
  // SessionStart injects a "before you answer, call mindwright_recall"
  // instruction into the session's context — bootstraps the proactive-
  // recall loop. As of behavior-1 the injection is gated on
  // (embedderCached() && long_count > 0): emitting the rule when there's
  // nothing to recall just teaches the agent to call a tool that errors
  // with SETUP_HINT or returns []. The setup here satisfies both halves
  // of the gate (model cache + a planted long-tier fact) so we can pin
  // the live-recall path.
  const { dir, homeDir, cleanup } = setupIsolatedRoot();
  try {
    // Plant a long-tier fact so longCount > 0.
    const store = openStore();
    try {
      store.insertEntry({
        tier: 'long',
        category: 'fact',
        scope: 'project',
        kind: 'fact',
        content: 'recall-gate sentinel fact',
        sessionId: 'sentinel-sess',
        confidence: 1.0,
        embedding: null,
      });
    } finally { store.close(); }
    const transcriptPath = writeTranscript(dir, 'sess-A2', [
      userRec('hello'),
    ]);
    const { status, stdout } = runHook('session-start.js', {
      session_id: 'sess-A2',
      transcript_path: transcriptPath,
      hook_event_name: 'SessionStart',
      source: 'startup',
    }, dir, homeDir);
    assert.equal(status, 0);
    assert.ok(stdout.hookSpecificOutput, 'must emit hookSpecificOutput');
    assert.equal(stdout.hookSpecificOutput.hookEventName, 'SessionStart');
    assert.match(
      stdout.hookSpecificOutput.additionalContext || '',
      /mindwright_recall/,
      'must include the self-recall rule that names the MCP tool to call',
    );
  } finally {
    cleanup();
  }
});

test('session-start surfaces a /mindwright:setup hint when the embedder cache is missing', () => {
  // Regression for behavior-4: a fresh install that skipped /mindwright:setup
  // would silently produce zero retrieval forever (pipe-client.embed returns
  // null until the daemon downloads the ~5 GB model). The hook now
  // proactively surfaces the setup prompt so a user who never read the README
  // gets an on-screen cue instead of an inert plugin.
  const { dir, homeDir, cleanup } = setupIsolatedRoot({ withModelCache: false });
  try {
    const transcriptPath = writeTranscript(dir, 'sess-A3', [userRec('hello')]);
    const { status, stdout } = runHook('session-start.js', {
      session_id: 'sess-A3',
      transcript_path: transcriptPath,
      hook_event_name: 'SessionStart',
      source: 'startup',
    }, dir, homeDir);
    assert.equal(status, 0);
    const ctx = stdout?.hookSpecificOutput?.additionalContext || '';
    assert.match(ctx, /\/mindwright:setup/, 'missing model → setup hint must appear in additionalContext');
    assert.match(ctx, /not cached/i, 'setup hint must name the missing-cache symptom');
  } finally {
    cleanup();
  }
});

test('session-start does NOT overwrite an existing offset (resumed session)', () => {
  const { dir, cleanup } = setupIsolatedRoot();
  try {
    const transcriptPath = writeTranscript(dir, 'sess-B', [userRec('first')]);
    // Pre-seed an offset that's mid-file so the hook leaves it alone.
    const store = openStore();
    try {
      store.setOffset('sess-B', 5);
    } finally {
      store.close();
    }
    const { status } = runHook('session-start.js', {
      session_id: 'sess-B',
      transcript_path: transcriptPath,
      hook_event_name: 'SessionStart',
      source: 'resume',
    }, dir);
    assert.equal(status, 0);
    const store2 = openStore();
    try {
      assert.equal(store2.getOffset('sess-B'), 5, 'offset preserved');
    } finally {
      store2.close();
    }
  } finally {
    cleanup();
  }
});

test('session-start warns when meeting a large transcript for the first time (resumed-but-untracked)', () => {
  // Behavior regression: a user installs mindwright mid-project and resumes
  // an active session. The transcript already contains lots of prior turns,
  // but mindwright never tracked them. Default behavior is still "skip to
  // EOF" (we don't retroactively ingest pre-mindwright history without an
  // explicit opt-in), but the SessionStart message must say so out loud
  // instead of pretending the session is fresh.
  const { dir, cleanup } = setupIsolatedRoot();
  try {
    // Generate a transcript larger than the 4096-byte warn threshold.
    const recs = [];
    for (let i = 0; i < 50; i++) {
      recs.push(userRec(`turn ${i} — quite a lot of accumulated chat content here to push past the 4 KB threshold the hook uses to decide this is meaningful prior history rather than a few empty turns`));
      recs.push(assistantTextRec(`reply ${i} — also adding enough body that the file grows past the warning threshold without needing hundreds of turns`));
    }
    const transcriptPath = writeTranscript(dir, 'sess-resumed', recs);
    const size = statSync(transcriptPath).size;
    assert.ok(size > 4096, `prep: transcript must exceed warn threshold; got ${size}`);

    const { status, stdout } = runHook('session-start.js', {
      session_id: 'sess-resumed',
      transcript_path: transcriptPath,
      hook_event_name: 'SessionStart',
      source: 'resume',
    }, dir);
    assert.equal(status, 0);
    const ac = stdout.hookSpecificOutput && stdout.hookSpecificOutput.additionalContext;
    assert.ok(ac, 'expected additionalContext');
    assert.match(ac, /before mindwright was tracking/, `warning should mention prior tracking; got: ${ac}`);
    assert.match(ac, /MINDWRIGHT_SEED_TRANSCRIPT=1/, `warning should mention the opt-in env var; got: ${ac}`);
    // Record count gives the user a much better intuition than bytes alone
    // for "how much conversation is mindwright about to skip?"
    assert.match(ac, /~\d+ records/, `warning should include the record count; got: ${ac}`);

    const store = openStore();
    try {
      assert.equal(store.getOffset('sess-resumed'), size,
        'default behavior must still skip to EOF (warn but skip)');
    } finally { store.close(); }
  } finally {
    cleanup();
  }
});

test('session-start with MINDWRIGHT_SEED_TRANSCRIPT=1 leaves offset at 0 so prior content gets ingested', () => {
  const { dir, cleanup } = setupIsolatedRoot();
  try {
    const recs = [];
    for (let i = 0; i < 20; i++) {
      recs.push(userRec(`turn ${i} — some prior conversation content`));
      recs.push(assistantTextRec(`reply ${i}`));
    }
    const transcriptPath = writeTranscript(dir, 'sess-optin', recs);
    const size = statSync(transcriptPath).size;
    assert.ok(size > 0);

    const res = spawnSync(process.execPath, [join(HOOKS_DIR, 'session-start.js')], {
      input: JSON.stringify({
        session_id: 'sess-optin',
        transcript_path: transcriptPath,
        hook_event_name: 'SessionStart',
        source: 'resume',
      }),
      encoding: 'utf8',
      env: { ...process.env, MINDWRIGHT_PROJECT_ROOT: dir, MINDWRIGHT_SEED_TRANSCRIPT: '1' },
    });
    assert.equal(res.status, 0);
    const stdout = JSON.parse(res.stdout.trim());
    assert.match(stdout.hookSpecificOutput.additionalContext, /MINDWRIGHT_SEED_TRANSCRIPT=1/);
    assert.match(stdout.hookSpecificOutput.additionalContext, /ingesting prior transcript/);

    const store = openStore();
    try {
      assert.equal(store.getOffset('sess-optin'), 0,
        'opt-in must leave offset at 0 so first PreToolUse chunks from the top');
    } finally { store.close(); }
  } finally {
    cleanup();
  }
});

test('session-start honors MINDWRIGHT_SEED_TRANSCRIPT=1 even on a session it has already tracked', () => {
  // Regression for behavior-8: previously the env var was only consulted when
  // the offset row was missing (fresh session). A user who already ran the
  // session once with mindwright tracking, then decided they wanted the
  // older content seeded, set the env var and relaunched — and got no
  // feedback because the gate `existing === 0` excluded their case. Now the
  // hook resets the offset to 0 and warns about likely duplicates.
  const { dir, cleanup } = setupIsolatedRoot();
  try {
    const recs = [];
    for (let i = 0; i < 20; i++) {
      recs.push(userRec(`turn ${i} — some prior conversation content`));
      recs.push(assistantTextRec(`reply ${i}`));
    }
    const transcriptPath = writeTranscript(dir, 'sess-tracked', recs);
    const size = statSync(transcriptPath).size;
    assert.ok(size > 0);

    // Pre-seed an offset row — this is the "already tracked" state that the
    // old code silently ignored when the env var was set.
    const seed = openStore();
    try {
      seed.setOffset('sess-tracked', Math.floor(size / 2));
    } finally {
      seed.close();
    }
    const offsetBefore = (() => {
      const s = openStore();
      try { return s.getOffset('sess-tracked'); } finally { s.close(); }
    })();
    assert.ok(offsetBefore > 0, 'prep: tracked session must have offset > 0');

    const res = spawnSync(process.execPath, [join(HOOKS_DIR, 'session-start.js')], {
      input: JSON.stringify({
        session_id: 'sess-tracked',
        transcript_path: transcriptPath,
        hook_event_name: 'SessionStart',
        source: 'resume',
      }),
      encoding: 'utf8',
      env: { ...process.env, MINDWRIGHT_PROJECT_ROOT: dir, MINDWRIGHT_SEED_TRANSCRIPT: '1' },
    });
    assert.equal(res.status, 0, `hook exit code: ${res.status}, stderr=${res.stderr}`);

    const stdout = JSON.parse(res.stdout.trim());
    assert.ok(stdout.hookSpecificOutput,
      'expected hookSpecificOutput from honored opt-in');
    const ac = stdout.hookSpecificOutput.additionalContext;
    assert.match(ac, /MINDWRIGHT_SEED_TRANSCRIPT=1/,
      'message must acknowledge the env var was honored');
    assert.match(ac, /re-ingesting/i,
      'message must say re-ingesting (not just ingesting — caller knows mindwright tracked them before)');
    assert.match(ac, /duplicate/i,
      'message must warn about likely duplicates');

    const store = openStore();
    try {
      assert.equal(store.getOffset('sess-tracked'), 0,
        'opt-in on a tracked session must reset offset to 0 so re-chunking starts from the top');
    } finally {
      store.close();
    }
  } finally {
    cleanup();
  }
});

test('session-start injects a Current time: ISO line so agents can ground temporal reasoning', () => {
  // Agents otherwise reason about "now" from a stale training cutoff or
  // whatever date string is loitering in their context. SessionStart prepends
  // an ISO-8601 wall-clock anchor to additionalContext on every boot so all
  // downstream reasoning (and the `ts=` tokens on retrieved memories) shares
  // a single clock the agent can actually see.
  const { dir, homeDir, cleanup } = setupIsolatedRoot();
  try {
    const transcriptPath = writeTranscript(dir, 'sess-time', [userRec('hi')]);
    const { status, stdout } = runHook('session-start.js', {
      session_id: 'sess-time',
      transcript_path: transcriptPath,
      hook_event_name: 'SessionStart',
      source: 'startup',
    }, dir, homeDir);
    assert.equal(status, 0);
    const ac = stdout?.hookSpecificOutput?.additionalContext || '';
    assert.match(ac, /^Current time: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
      `additionalContext must START with an ISO-8601 timestamp; got: ${ac}`);
  } finally {
    cleanup();
  }
});

test('session-start orphan-sweep promotes a quiet crashed session pending bucket', () => {
  // The orphan-pending sweep at SessionStart is the safety net for sessions
  // that crashed, were killed, or otherwise never fired their final
  // PreCompact / SessionEnd. Their pending rows would otherwise sit forever
  // invisible to retrieval. The sweep promotes them on behalf of the dead
  // session so the content joins long-term memory normally.
  const { dir, cleanup } = setupIsolatedRoot();
  try {
    // Plant pending rows under a CRASHED session, backdated well past the
    // 30-minute default threshold so the sweep flags them.
    const seedStore = openStore();
    try {
      seedStore.insertEntry({
        tier: 'short', kind: 'thinking',
        content: 'orphan content from a dead session',
        sessionId: 'sess-crashed', pendingSessionId: 'sess-crashed',
      });
      const longAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1h ago
      seedStore.db.prepare('UPDATE entries SET created_at = ? WHERE pending_session_id = ?')
        .run(longAgo, 'sess-crashed');
    } finally { seedStore.close(); }

    // A FRESH session starts up — its SessionStart triggers the sweep.
    const transcriptPath = writeTranscript(dir, 'sess-new', [userRec('hi')]);
    runHook('session-start.js', {
      session_id: 'sess-new',
      transcript_path: transcriptPath,
      hook_event_name: 'SessionStart',
      source: 'startup',
    }, dir);

    const verify = openStore();
    try {
      // Orphaned rows promoted on the dead session's behalf.
      assert.equal(verify.countPendingFor('sess-crashed'), 0,
        'orphan-sweep must promote the dead session\'s pending bucket');
      assert.equal(verify.countShortTermFor('sess-crashed'), 1,
        'promoted row must now count as real short-term under the dead session');
    } finally { verify.close(); }
  } finally {
    cleanup();
  }
});

test('session-start orphan-sweep does NOT touch the LIVE caller\'s pending bucket', () => {
  // A /resume after lunch must not have its half-typed pending bucket
  // hijacked by its own SessionStart sweep. The exclusion is on
  // currentSessionId — if it ever regresses, every resume would prematurely
  // promote (and potentially trip the cap nudge for) its OWN unfinished
  // turn.
  const { dir, cleanup } = setupIsolatedRoot();
  try {
    const seedStore = openStore();
    try {
      // The live (resuming) session's pending row — backdated well past the
      // threshold, exactly the way a long-running session would look.
      seedStore.insertEntry({
        tier: 'short', kind: 'thinking',
        content: 'live caller pending',
        sessionId: 'sess-live', pendingSessionId: 'sess-live',
      });
      const longAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      seedStore.db.prepare('UPDATE entries SET created_at = ? WHERE pending_session_id = ?')
        .run(longAgo, 'sess-live');
    } finally { seedStore.close(); }

    const transcriptPath = writeTranscript(dir, 'sess-live', [userRec('resumed')]);
    runHook('session-start.js', {
      session_id: 'sess-live',
      transcript_path: transcriptPath,
      hook_event_name: 'SessionStart',
      source: 'resume',
    }, dir);

    const verify = openStore();
    try {
      assert.equal(verify.countPendingFor('sess-live'), 1,
        'the LIVE caller\'s pending bucket must NEVER be swept by its own SessionStart');
      assert.equal(verify.countShortTermFor('sess-live'), 0,
        'no premature promotion of the caller\'s own rows');
    } finally { verify.close(); }
  } finally {
    cleanup();
  }
});

test('session-start orphan-sweep skips a fresh pending bucket below the threshold', () => {
  // Quiet-session protection: a peer session whose pending is just a minute
  // old must NOT be promoted — that session is probably still alive and the
  // sweep would otherwise strand its in-flight context. The threshold gates
  // on MAX(created_at), not COUNT, so a single recent row is enough to keep
  // the whole bucket pinned to the live session.
  const { dir, cleanup } = setupIsolatedRoot();
  try {
    const seedStore = openStore();
    try {
      // Peer's pending row at "now" — well within the 30-minute threshold.
      seedStore.insertEntry({
        tier: 'short', kind: 'thinking', content: 'fresh peer pending',
        sessionId: 'sess-fresh-peer', pendingSessionId: 'sess-fresh-peer',
      });
    } finally { seedStore.close(); }

    const transcriptPath = writeTranscript(dir, 'sess-other', [userRec('hi')]);
    runHook('session-start.js', {
      session_id: 'sess-other',
      transcript_path: transcriptPath,
      hook_event_name: 'SessionStart',
      source: 'startup',
    }, dir);

    const verify = openStore();
    try {
      assert.equal(verify.countPendingFor('sess-fresh-peer'), 1,
        'fresh peer pending must NOT be swept (peer may still be alive)');
      assert.equal(verify.countShortTermFor('sess-fresh-peer'), 0);
    } finally { verify.close(); }
  } finally {
    cleanup();
  }
});

test('session-start orphan-sweep clears the orphan\'s persisted tool_map row', () => {
  // The orphan-sweep promotes the dead session's pending bucket AND must
  // clean up its persisted tool_map — an orphan session by definition
  // won't run its own SessionEnd to do so, and without this cleanup every
  // crashed session would leave a meta row that lingers forever. Pairs
  // with the SessionEnd clearToolMap path; the orphan sweep is the
  // crashed-session equivalent.
  const { dir, cleanup } = setupIsolatedRoot();
  try {
    const seedStore = openStore();
    try {
      // Plant the orphan's pending row, backdated past the threshold.
      seedStore.insertEntry({
        tier: 'short', kind: 'thinking', content: 'orphan content',
        sessionId: 'sess-crashed-tm', pendingSessionId: 'sess-crashed-tm',
      });
      const longAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      seedStore.db.prepare('UPDATE entries SET created_at = ? WHERE pending_session_id = ?')
        .run(longAgo, 'sess-crashed-tm');
      // Plant the orphan's tool_map row — exactly what a session that
      // crashed mid-tool would leave behind.
      seedStore.saveToolMap('sess-crashed-tm', new Map([
        ['tu_orphan', { name: 'Bash', input: { command: 'cargo build' }, source_ref: 's', timestamp: longAgo }],
      ]));
      assert.equal(seedStore.loadToolMap('sess-crashed-tm').size, 1,
        'precondition: orphan tool_map exists');
    } finally { seedStore.close(); }

    const transcriptPath = writeTranscript(dir, 'sess-new-tm', [userRec('hi')]);
    runHook('session-start.js', {
      session_id: 'sess-new-tm',
      transcript_path: transcriptPath,
      hook_event_name: 'SessionStart',
      source: 'startup',
    }, dir);

    const verify = openStore();
    try {
      // Promotion still happens.
      assert.equal(verify.countPendingFor('sess-crashed-tm'), 0);
      // AND the tool_map blob is gone — the meta row is fully deleted, not
      // just left as a serialized empty map.
      assert.equal(verify.loadToolMap('sess-crashed-tm').size, 0,
        'orphan tool_map must be cleared by the sweep');
      assert.equal(verify._metaGet('tool_map:sess-crashed-tm'), null,
        'meta row must be deleted, not left as a serialized empty map');
    } finally { verify.close(); }
  } finally {
    cleanup();
  }
});

test('session-start emits empty {} on malformed stdin', () => {
  const { dir, cleanup } = setupIsolatedRoot();
  try {
    const res = spawnSync(
      process.execPath,
      [join(HOOKS_DIR, 'session-start.js')],
      {
        input: 'not json',
        encoding: 'utf8',
        env: { ...process.env, MINDWRIGHT_PROJECT_ROOT: dir },
      }
    );
    assert.equal(res.status, 0);
    const out = JSON.parse(res.stdout.trim() || '{}');
    assert.deepEqual(out, {});
  } finally {
    cleanup();
  }
});

// ----- UserPromptSubmit ---------------------------------------------------

test('user-prompt-submit chunks the prompt from the transcript', () => {
  // The chunker is the single source of truth for cli_prompt rows. When
  // Claude has already landed the prompt in the transcript before UPS
  // fires, UPS's chunk sweep catches it on its own pass; otherwise the
  // next PreToolUse/Stop chunker call picks it up (covered in those
  // hooks' own tests).
  //
  // Under the pending-staging design chunks land in short_term as PENDING
  // (pending_session_id != NULL) and are invisible to bm25Search until
  // PreCompact/SessionEnd promotes them. Mirror that boundary by promoting
  // before searching — production code path is byte-identical.
  const { dir, cleanup } = setupIsolatedRoot();
  try {
    const prompt = 'where are the auth helpers defined?';
    const transcriptPath = writeTranscript(dir, 'sess-C', [userRec(prompt)]);
    seedTrackedFromZero('sess-C');
    runHook('user-prompt-submit.js', {
      session_id: 'sess-C',
      transcript_path: transcriptPath,
      hook_event_name: 'UserPromptSubmit',
      prompt,
    }, dir);
    const store = openStore();
    try {
      // Chunk lands in pending; promote so bm25Search can see it.
      assert.ok(store.countPendingFor('sess-C') >= 1, 'prompt must chunk into pending');
      store.promotePendingForSession('sess-C');
      const rows = store.bm25Search('auth helpers', 5);
      const fetched = rows.map((r) => store.fetch(r.id)).filter(Boolean);
      assert.ok(
        fetched.some((r) => r.content.includes('where are the auth helpers')),
        'cli_prompt row should be searchable after promotion'
      );
      // Exactly one cli_prompt row — no duplicates from a direct insert
      // path running alongside the chunker.
      const promptRows = fetched.filter((r) =>
        r.kind === 'cli_prompt' && r.content === prompt
      );
      assert.equal(promptRows.length, 1, `expected exactly 1 cli_prompt row, got ${promptRows.length}`);
    } finally {
      store.close();
    }
  } finally {
    cleanup();
  }
});

test('user-prompt-submit emits no additionalContext when retrieval finds nothing', () => {
  // With no daemon, pipe.embed returns null on the first call — which is
  // behavior-13's "daemon-down" trigger. To exercise the "retrieval truly
  // finds nothing" path (i.e., daemon up but no hits) we pre-flip the
  // per-session warned latch so the hook treats the daemon as already-
  // warned-for and falls through to its silent path. The actual daemon-
  // down warning is covered by its own dedicated test below.
  const { dir, cleanup } = setupIsolatedRoot();
  try {
    const transcriptPath = writeTranscript(dir, 'sess-D', [userRec('first')]);
    const store = openStore();
    try { store.markDaemonDownWarned('sess-D'); } finally { store.close(); }
    const { stdout } = runHook('user-prompt-submit.js', {
      session_id: 'sess-D',
      transcript_path: transcriptPath,
      hook_event_name: 'UserPromptSubmit',
      prompt: 'fresh prompt',
    }, dir);
    // Unconditional negative assertion: whether the hook emits {} or a
    // hookSpecificOutput envelope, the additionalContext on the
    // retrieval-found-nothing path must be empty. Gating this behind
    // `if (stdout.hookSpecificOutput)` let the {} shape pass with zero
    // assertions — a regression that produced the wrong shape (or any
    // recall content) would have gone unnoticed.
    const ac = stdout.hookSpecificOutput?.additionalContext || '';
    assert.equal(ac, '', 'no relevant memory → no additionalContext');
  } finally {
    cleanup();
  }
});

test('user-prompt-submit emits the daemon-down warning once when the MCP daemon is unreachable', () => {
  // behavior-13: when pipe.embed() returns null (daemon down), the hook
  // injects a single warning per session so the user knows recall is
  // degraded. The latch is per-session and cleared by SessionStart, so
  // subsequent firings within the same session stay silent.
  const { dir, cleanup } = setupIsolatedRoot();
  try {
    const transcriptPath = writeTranscript(dir, 'sess-daemon-down-ups', [userRec('first')]);

    const first = runHook('user-prompt-submit.js', {
      session_id: 'sess-daemon-down-ups',
      transcript_path: transcriptPath,
      hook_event_name: 'UserPromptSubmit',
      prompt: 'something',
    }, dir);
    const ctx1 = first.stdout?.hookSpecificOutput?.additionalContext || '';
    assert.match(ctx1, /retrieval daemon is unreachable/,
      'first firing on a daemon-down session must emit the warning');

    // Second firing on the same session: latch is set, no re-warn.
    const second = runHook('user-prompt-submit.js', {
      session_id: 'sess-daemon-down-ups',
      transcript_path: transcriptPath,
      hook_event_name: 'UserPromptSubmit',
      prompt: 'something else',
    }, dir);
    const ctx2 = second.stdout?.hookSpecificOutput?.additionalContext || '';
    assert.ok(!/retrieval daemon is unreachable/.test(ctx2),
      'second firing on the same session must not re-emit the warning');
  } finally {
    cleanup();
  }
});

test('user-prompt-submit exits cleanly when sessionId is missing', () => {
  const { dir, cleanup } = setupIsolatedRoot();
  try {
    const { status, stdout } = runHook('user-prompt-submit.js', {
      hook_event_name: 'UserPromptSubmit',
      prompt: 'orphaned',
    }, dir);
    assert.equal(status, 0);
    assert.deepEqual(stdout, {});
  } finally {
    cleanup();
  }
});

// ----- PreToolUse ---------------------------------------------------------

function makeThinking(len) {
  return 'x'.repeat(Math.max(0, len));
}

test('pre-tool-use writes new chunks and advances offset', () => {
  const { dir, cleanup } = setupIsolatedRoot();
  try {
    const transcriptPath = writeTranscript(dir, 'sess-E', [
      userRec('hello'),
      assistantThinkingRec(makeThinking(200)), // under gate
      assistantTextRec('hi'),
    ]);
    const sizeBefore = statSync(transcriptPath).size;
    seedTrackedFromZero('sess-E');

    const { status } = runHook('pre-tool-use.js', {
      session_id: 'sess-E',
      transcript_path: transcriptPath,
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    }, dir);
    assert.equal(status, 0);

    const store = openStore();
    try {
      // Three rows: cli_prompt, thinking, text — staged as PENDING (visible
      // only via countPendingFor; countShortTermFor filters pending out by
      // design so the cap can't be tripped by mid-turn chunks).
      const count = store.countPendingFor('sess-E');
      assert.ok(count >= 3, `expected ≥3 pending rows, got ${count}`);
      assert.equal(store.countShortTermFor('sess-E'), 0,
        'pending rows must NOT count toward real short-term');
      assert.equal(store.getOffset('sess-E'), sizeBefore);
    } finally {
      store.close();
    }
  } finally {
    cleanup();
  }
});

test('pre-tool-use gate case: no thinking block in new chunks → no retrieval', () => {
  const { dir, cleanup } = setupIsolatedRoot();
  try {
    const transcriptPath = writeTranscript(dir, 'sess-G', [
      userRec('hello'),
      assistantTextRec('just text, no thinking'),
    ]);
    seedTrackedFromZero('sess-G');
    const { stdout } = runHook('pre-tool-use.js', {
      session_id: 'sess-G',
      transcript_path: transcriptPath,
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: {},
    }, dir);
    // Unconditional: no thinking block in the new chunks means the novelty
    // gate never fires, so retrieval is skipped and no recall is injected —
    // regardless of whether the hook emits {} or an envelope.
    const ac = stdout.hookSpecificOutput?.additionalContext || '';
    assert.equal(ac, '', 'no thinking block → retrieval skipped → no additionalContext');
    // Observable side effect proving the hook ran to completion (didn't
    // crash) while only retrieval was skipped: the transcript's two records
    // (userRec → cli_prompt, assistantTextRec → text) still flush as chunks
    // — into PENDING under the new design.
    const store = openStore();
    try {
      const count = store.countPendingFor('sess-G');
      assert.ok(count >= 2,
        `chunks must still flush even though retrieval was gated off; got ${count}`);
    } finally {
      store.close();
    }
  } finally {
    cleanup();
  }
});

test('pre-tool-use gate case: thinking present but pipe down → silently skips retrieval', () => {
  const { dir, cleanup } = setupIsolatedRoot();
  try {
    // 2500-char thinking. With no daemon, the pipe-client returns null and
    // the hook silently skips retrieval — chunks still get written. Pre-flip
    // the per-session daemon-down warned latch (behavior-13) so the hook
    // does NOT emit its first-time warning here; the warning path has its
    // own dedicated test below.
    const transcriptPath = writeTranscript(dir, 'sess-H', [
      userRec('hello'),
      assistantThinkingRec(makeThinking(2500)),
    ]);
    seedTrackedFromZero('sess-H');
    {
      const store = openStore();
      try { store.markDaemonDownWarned('sess-H'); } finally { store.close(); }
    }
    const { stdout } = runHook('pre-tool-use.js', {
      session_id: 'sess-H',
      transcript_path: transcriptPath,
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: {},
    }, dir);
    // Unconditional negative assertion: whether the hook emits {} or a
    // hookSpecificOutput envelope, the additionalContext on the pipe-down
    // path must be empty. The earlier conditional `if (stdout.hookSpecificOutput)`
    // form let the {} shape pass with zero assertions — see the matching
    // fix at the no-relevant-memory test above.
    const ac = stdout.hookSpecificOutput?.additionalContext || '';
    assert.equal(ac, '', 'pipe down → no additionalContext');
    const store = openStore();
    try {
      const count = store.countPendingFor('sess-H');
      assert.ok(count >= 2, `chunks must still be written (pending); got ${count}`);
    } finally {
      store.close();
    }
  } finally {
    cleanup();
  }
});

test('pre-tool-use emits the daemon-down warning once when the MCP daemon is unreachable', () => {
  // behavior-13: PreToolUse, like UserPromptSubmit, surfaces a single
  // per-session warning when pipe.embed() returns null. Subsequent firings
  // within the same session stay silent — SessionStart clears the latch
  // so a fresh boot is allowed to warn again.
  const { dir, cleanup } = setupIsolatedRoot();
  try {
    const transcriptPath = writeTranscript(dir, 'sess-daemon-down-ptu', [
      userRec('hello'),
      assistantThinkingRec(makeThinking(2500)),
    ]);
    seedTrackedFromZero('sess-daemon-down-ptu');
    const first = runHook('pre-tool-use.js', {
      session_id: 'sess-daemon-down-ptu',
      transcript_path: transcriptPath,
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: {},
    }, dir);
    const ctx1 = first.stdout?.hookSpecificOutput?.additionalContext || '';
    assert.match(ctx1, /retrieval daemon is unreachable/,
      'first firing on a daemon-down session must emit the warning');

    // Re-fire with a fresh thinking block in the same session.
    const transcript2 = writeTranscript(dir, 'sess-daemon-down-ptu', [
      userRec('hello'),
      assistantThinkingRec(makeThinking(2500)),
      assistantThinkingRec(makeThinking(2600), '2026-05-13T00:00:03Z'),
    ]);
    const second = runHook('pre-tool-use.js', {
      session_id: 'sess-daemon-down-ptu',
      transcript_path: transcript2,
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: {},
    }, dir);
    const ctx2 = second.stdout?.hookSpecificOutput?.additionalContext || '';
    assert.ok(!/retrieval daemon is unreachable/.test(ctx2),
      'second firing on the same session must not re-emit the warning');
  } finally {
    cleanup();
  }
});

test('pre-tool-use always emits a JSON object on stdout (early-return paths)', () => {
  // Each PreToolUse early-return path (no thinking, pipe down) must still
  // write a JSON object — every other hook in this plugin emits `{}`
  // unconditionally, and Claude Code's hook contract expects newline-
  // terminated JSON. Naked `return;` inside try/finally would silently emit
  // nothing on the most common path.
  const { dir, cleanup } = setupIsolatedRoot();
  try {
    // Path A: no thinking block at all → early return.
    const tA = writeTranscript(dir, 'sess-stdout-a', [
      userRec('hello'),
      assistantTextRec('text only, no thinking'),
    ]);
    const res = spawnSync(process.execPath, [join(HOOKS_DIR, 'pre-tool-use.js')], {
      input: JSON.stringify({
        session_id: 'sess-stdout-a',
        transcript_path: tA,
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: {},
      }),
      encoding: 'utf8',
      env: { ...process.env, MINDWRIGHT_PROJECT_ROOT: dir },
    });
    const out = res.stdout.trim();
    assert.ok(out.length > 0, `expected stdout, got empty string. stderr=${res.stderr}`);
    const parsed = JSON.parse(out);
    assert.equal(typeof parsed, 'object');

    // Path B: thinking present but pipe down → embed null → early return.
    const tB = writeTranscript(dir, 'sess-stdout-b', [
      userRec('hello'),
      assistantThinkingRec(makeThinking(800)),
    ]);
    const resB = spawnSync(process.execPath, [join(HOOKS_DIR, 'pre-tool-use.js')], {
      input: JSON.stringify({
        session_id: 'sess-stdout-b',
        transcript_path: tB,
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: {},
      }),
      encoding: 'utf8',
      env: { ...process.env, MINDWRIGHT_PROJECT_ROOT: dir },
    });
    const outB = resB.stdout.trim();
    assert.ok(outB.length > 0, `expected stdout on pipe-down path, got empty. stderr=${resB.stderr}`);
    JSON.parse(outB);
  } finally {
    cleanup();
  }
});

test('pre-tool-use is idempotent on no new content (re-run advances nothing)', () => {
  const { dir, cleanup } = setupIsolatedRoot();
  try {
    const transcriptPath = writeTranscript(dir, 'sess-I', [
      userRec('hello'),
      assistantTextRec('hi'),
    ]);
    runHook('pre-tool-use.js', {
      session_id: 'sess-I',
      transcript_path: transcriptPath,
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: {},
    }, dir);
    const store = openStore();
    let firstCount;
    try {
      firstCount = store.countShortTermFor('sess-I');
    } finally {
      store.close();
    }
    runHook('pre-tool-use.js', {
      session_id: 'sess-I',
      transcript_path: transcriptPath,
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: {},
    }, dir);
    const store2 = openStore();
    try {
      assert.equal(
        store2.countShortTermFor('sess-I'),
        firstCount,
        'second run on unchanged transcript must add no rows'
      );
    } finally {
      store2.close();
    }
  } finally {
    cleanup();
  }
});

// ----- Stop ---------------------------------------------------------------

test('stop flushes tail content', () => {
  const { dir, cleanup } = setupIsolatedRoot();
  try {
    const transcriptPath = writeTranscript(dir, 'sess-J', [
      userRec('hello'),
      assistantTextRec('final answer'),
    ]);
    seedTrackedFromZero('sess-J');
    runHook('stop.js', {
      session_id: 'sess-J',
      transcript_path: transcriptPath,
      hook_event_name: 'Stop',
      stop_hook_active: false,
    }, dir);
    const store = openStore();
    try {
      // Stop flushes into PENDING (same path as PreToolUse / UPS). Promotion
      // happens at PreCompact/SessionEnd, not at Stop.
      const count = store.countPendingFor('sess-J');
      assert.ok(count >= 2, `expected ≥2 pending rows after stop flush, got ${count}`);
      assert.equal(store.countShortTermFor('sess-J'), 0,
        'Stop must not promote — pending must NOT count toward real short-term');
    } finally {
      store.close();
    }
  } finally {
    cleanup();
  }
});

test('pre-compact flushes transcript tail into pending THEN promotes pending → real (under-cap path)', () => {
  // Under-cap basic flow: PreCompact is the boundary between live-staged
  // chunks and durable retrievable short-term. The hook chains:
  //   transcript tail → pending (via flushTranscript)
  //   pending → real short-term (via promoteAndMaybeSpawn)
  // and emits `{}` (PreCompact does not surface context). We assert both
  // halves so a regression that reverses the order (promote before flush)
  // would leave fresh tail content stranded as pending.
  const { dir, cleanup } = setupIsolatedRoot();
  try {
    const transcriptPath = writeTranscript(dir, 'sess-pc-basic', [
      userRec('hello'),
      assistantTextRec('answer'),
    ]);
    seedTrackedFromZero('sess-pc-basic');

    const { stdout } = runHook('pre-compact.js', {
      session_id: 'sess-pc-basic',
      transcript_path: transcriptPath,
      hook_event_name: 'PreCompact',
      trigger: 'manual',
    }, dir);
    assert.deepEqual(stdout, {});

    const store = openStore();
    try {
      // Tail flushed AND promoted. Pending should be 0; real short-term should
      // have at least 2 rows (cli_prompt + text).
      assert.equal(store.countPendingFor('sess-pc-basic'), 0,
        'PreCompact must promote pending → real (no pending leftovers)');
      assert.ok(store.countShortTermFor('sess-pc-basic') >= 2,
        `expected ≥2 real short-term rows after PreCompact flush+promote, got ${store.countShortTermFor('sess-pc-basic')}`);
      // Under-cap → no nudge staged.
      const nudge = store.db.prepare('SELECT value FROM meta WHERE key = ?').get('pending_nudge:sess-pc-basic');
      assert.equal(nudge, undefined, 'under-cap PreCompact must not stage a nudge');
    } finally {
      store.close();
    }
  } finally {
    cleanup();
  }
});

test('pre-compact emits {} and no-ops when session_id is missing', () => {
  // Defensive input validation parity with session-end: a malformed payload
  // must short-circuit to {} BEFORE touching the store. Without this guard,
  // promoteAndMaybeSpawn would be called with sessionId=undefined and the
  // store would error on the bound parameter — the user sees a crash at the
  // exact moment they invoked /compact.
  const { dir, cleanup } = setupIsolatedRoot();
  try {
    const transcriptPath = writeTranscript(dir, 'no-id', [userRec('x')]);
    const { stdout, status } = runHook('pre-compact.js', {
      transcript_path: transcriptPath,
      hook_event_name: 'PreCompact',
      trigger: 'manual',
    }, dir);
    assert.equal(status, 0);
    assert.deepEqual(stdout, {});
    const store = openStore();
    try {
      const n = store.db.prepare('SELECT COUNT(*) AS n FROM entries').get().n;
      assert.equal(n, 0, 'no entries should be written when session_id is missing');
    } finally { store.close(); }
  } finally {
    cleanup();
  }
});

test('pre-compact promotes already-pending rows even when transcript_path is missing', () => {
  // Some hook payloads land without transcript_path (rare, but the input
  // shape allows it). The hook must still promote whatever's already
  // pending — otherwise the user's accumulated chunks sit invisible past
  // the only natural promotion boundary they had.
  const { dir, cleanup } = setupIsolatedRoot();
  try {
    const store = openStore();
    try {
      for (let i = 0; i < 3; i++) {
        store.insertEntry({
          tier: 'short', kind: 'thinking', content: `pending ${i}`,
          sessionId: 'sess-pc-notx', pendingSessionId: 'sess-pc-notx',
        });
      }
    } finally { store.close(); }

    const { stdout } = runHook('pre-compact.js', {
      session_id: 'sess-pc-notx',
      // transcript_path deliberately omitted
      hook_event_name: 'PreCompact',
      trigger: 'manual',
    }, dir);
    assert.deepEqual(stdout, {});

    const verify = openStore();
    try {
      assert.equal(verify.countPendingFor('sess-pc-notx'), 0,
        'pending rows must promote even without transcript_path');
      assert.equal(verify.countShortTermFor('sess-pc-notx'), 3);
    } finally { verify.close(); }
  } finally {
    cleanup();
  }
});

test('pre-compact stages a pending nudge for the next UserPromptSubmit when promotion crosses the cap', () => {
  // PreCompact doesn't honor additionalContext (hook event has no
  // user-visible surface for memory work), so the cap warning is staged in
  // `meta` and the next UserPromptSubmit drains it. Under the pending-
  // staging design the cap can only cross at promotion boundaries, so the
  // cap-fire path lives in PreCompact (and SessionEnd / SessionStart
  // orphan-sweep) rather than Stop.
  const { dir, cleanup } = setupIsolatedRoot();
  try {
    const transcriptPath = writeTranscript(dir, 'sess-K', [userRec('x')]);
    // Pre-seed CAP_EXCHANGES rows as PENDING so PreCompact promotes them all
    // at once and the cap crosses at promotion.
    const store = openStore();
    try {
      for (let i = 0; i < CAP_EXCHANGES; i++) {
        store.insertEntry({
          tier: 'short',
          kind: 'thinking',
          content: `pre-seeded ${i}`,
          sessionId: 'sess-K',
          pendingSessionId: 'sess-K',
        });
      }
    } finally {
      store.close();
    }
    const { stdout } = runHook('pre-compact.js', {
      session_id: 'sess-K',
      transcript_path: transcriptPath,
      hook_event_name: 'PreCompact',
      trigger: 'manual',
    }, dir);
    // PreCompact emits `{}` — no user-visible surface here.
    assert.deepEqual(stdout, {}, 'pre-compact must not emit hookSpecificOutput');
    // But the nudge is staged. Peek (without draining) by reading meta directly,
    // since takePendingNudge would clear it and the next assertion needs it.
    const store2 = openStore();
    try {
      const row = store2.db.prepare('SELECT value FROM meta WHERE key = ?').get('pending_nudge:sess-K');
      assert.ok(row, 'expected pending_nudge:sess-K to be staged');
      assert.match(row.value, /cap reached/i);
      assert.match(row.value, /\/mindwright:dream/);
      // Sanity: pending rows were actually promoted.
      assert.equal(store2.countPendingFor('sess-K'), 0, 'pending rows must be promoted');
      assert.equal(store2.countShortTermFor('sess-K'), CAP_EXCHANGES,
        'all pending rows must now count as real short-term');
    } finally {
      store2.close();
    }
  } finally {
    cleanup();
  }
});

test('pre-compact SKIPS both spawn and nudge when MINDWRIGHT_IS_CONSOLIDATOR=1 (self-spawn loop guard)', () => {
  // Regression for the orphan-consolidator chain. Every spawned consolidator
  // inherits MINDWRIGHT_IS_CONSOLIDATOR=1 (lib/consolidator-spawn.js exports
  // CONSOLIDATOR_SPAWN_ENV_OVERRIDES). When its own PreCompact hook fires
  // with the cap crossed at promotion, the hook must short-circuit: no
  // child spawn (avoids the infinite chain), no pending_nudge row staged
  // (the consolidator IS the worker — staging a self-reminder is dead
  // text). Only nudge_state transitions still run so the gate re-arms
  // correctly.
  const { dir, cleanup } = setupIsolatedRoot();
  try {
    const transcriptPath = writeTranscript(dir, 'sess-consol-self', [userRec('x')]);
    const seedStore = openStore();
    try {
      for (let i = 0; i < CAP_EXCHANGES; i++) {
        seedStore.insertEntry({
          tier: 'short', kind: 'thinking',
          content: `seed ${i}`, sessionId: 'sess-consol-self',
          pendingSessionId: 'sess-consol-self',
        });
      }
    } finally { seedStore.close(); }

    const { stdout } = runHook('pre-compact.js', {
      session_id: 'sess-consol-self',
      transcript_path: transcriptPath,
      hook_event_name: 'PreCompact',
      trigger: 'manual',
    }, dir, null, { MINDWRIGHT_IS_CONSOLIDATOR: '1' });
    assert.deepEqual(stdout, {});

    // No pending_nudge row was staged for this session — the consolidator
    // doesn't need to be told to do its own job.
    const verifyStore = openStore();
    try {
      const row = verifyStore.db
        .prepare('SELECT value FROM meta WHERE key = ?')
        .get('pending_nudge:sess-consol-self');
      assert.equal(row, undefined,
        'a consolidator session must NOT have a pending nudge staged for itself');
      // nudge_state advanced to FIRED so the next cap-clear→cross cycle re-arms.
      assert.equal(verifyStore.getNudgeState(), 'fired',
        'nudge_state must advance to FIRED even when the staging path is skipped');
    } finally { verifyStore.close(); }
  } finally {
    cleanup();
  }
});

test('pre-compact SKIPS spawn and nudge when the session carries the consolidator role (no env var)', () => {
  // Secondary signal: explicit assign_role(role='consolidator') marks the
  // session as a consolidator without the env-var sentinel. Same skip
  // behavior — covers the "interactive /mindwright:assign-role consolidator"
  // path where the spawn-via-claude-bg chain isn't involved.
  const { dir, cleanup } = setupIsolatedRoot();
  try {
    const transcriptPath = writeTranscript(dir, 'sess-consol-role', [userRec('x')]);
    const seedStore = openStore();
    try {
      seedStore.setRoles('sess-consol-role', ['consolidator']);
      for (let i = 0; i < CAP_EXCHANGES; i++) {
        seedStore.insertEntry({
          tier: 'short', kind: 'thinking',
          content: `seed ${i}`, sessionId: 'sess-consol-role',
          pendingSessionId: 'sess-consol-role',
        });
      }
    } finally { seedStore.close(); }

    const { stdout } = runHook('pre-compact.js', {
      session_id: 'sess-consol-role',
      transcript_path: transcriptPath,
      hook_event_name: 'PreCompact',
      trigger: 'manual',
    }, dir);
    assert.deepEqual(stdout, {});

    const verifyStore = openStore();
    try {
      const row = verifyStore.db
        .prepare('SELECT value FROM meta WHERE key = ?')
        .get('pending_nudge:sess-consol-role');
      assert.equal(row, undefined,
        'a role-tagged consolidator session must NOT have a pending nudge staged');
      assert.equal(verifyStore.getNudgeState(), 'fired');
    } finally { verifyStore.close(); }
  } finally {
    cleanup();
  }
});

test('pre-compact SUSPENDS auto-spawn when MINDWRIGHT_SEED_TRANSCRIPT=1 — falls back to nudge so seed re-ingest does not silently auto-consolidate', () => {
  // Regression for the seed-mode-induced auto-spawn surprise: when a user
  // sets MINDWRIGHT_SEED_TRANSCRIPT=1 to backfill historical transcript
  // content, the re-ingest doubles short-term row count on already-tracked
  // sessions. That pushes them over CAP_EXCHANGES, and the unguarded path
  // would auto-spawn a `claude --bg` consolidator that consumes subscription
  // tokens deduplicating content the user already knows is duplicated and
  // hadn't inspected yet. The guard (now in promote-pending.js, since
  // cap-fire moved there) suspends auto-spawn while the env is set and
  // falls back to the manual nudge.
  const { dir, cleanup } = setupIsolatedRoot();
  try {
    const transcriptPath = writeTranscript(dir, 'sess-seed-guard', [userRec('x')]);
    // Set up a fake `claude` binary so an unsuppressed spawn WOULD succeed
    // — the test relies on the absence of a consolidator record to prove the
    // spawn was suppressed (not merely failed).
    const fakeBin = process.platform === 'win32'
      ? process.execPath
      : (() => {
          const p = join(dir, 'fake-claude.sh');
          writeFileSync(p, '#!/bin/sh\necho fake-session-id-seed-guard\nexit 0\n', 'utf8');
          chmodSync(p, 0o755);
          return p;
        })();

    const seedStore = openStore();
    try {
      for (let i = 0; i < CAP_EXCHANGES; i++) {
        seedStore.insertEntry({
          tier: 'short', kind: 'thinking',
          content: `seed ${i}`, sessionId: 'sess-seed-guard',
          pendingSessionId: 'sess-seed-guard',
        });
      }
    } finally { seedStore.close(); }

    const { stdout } = runHook('pre-compact.js', {
      session_id: 'sess-seed-guard',
      transcript_path: transcriptPath,
      hook_event_name: 'PreCompact',
      trigger: 'manual',
    }, dir, null, {
      // Clear the test fixture's MINDWRIGHT_SPAWN_DISABLE=1 — without
      // clearing it we couldn't distinguish "spawn suppressed by seed mode"
      // from "spawn suppressed by disable env".
      MINDWRIGHT_SPAWN_DISABLE: '',
      MINDWRIGHT_SPAWN_FAKE: fakeBin,
      MINDWRIGHT_SEED_TRANSCRIPT: '1',
    });
    assert.deepEqual(stdout, {});

    const verifyStore = openStore();
    try {
      // The fallback nudge IS staged — the user still gets a "time to dream"
      // reminder, just under their own control.
      const nudge = verifyStore.db
        .prepare('SELECT value FROM meta WHERE key = ?')
        .get('pending_nudge:sess-seed-guard');
      assert.ok(nudge,
        'expected fallback nudge to be staged when seed-mode suspends auto-spawn');
      assert.match(nudge.value, /cap reached/i);

      // No consolidator record was minted for this requester — the spawn
      // path was skipped, not just attempted-and-failed. (Were the spawn
      // attempted, the fake binary would have echoed a session id and
      // spawnConsolidator would have written a meta:consolidator_for row.)
      const handle = deriveHandle('sess-seed-guard');
      const record = verifyStore.getConsolidatorFor(handle);
      assert.equal(record, null,
        `consolidator must NOT be spawned when MINDWRIGHT_SEED_TRANSCRIPT=1; got record: ${JSON.stringify(record)}`);

      // nudge_state still advanced so the gate re-arms after dream drops
      // rows below cap.
      assert.equal(verifyStore.getNudgeState(), 'fired');
    } finally { verifyStore.close(); }
  } finally {
    cleanup();
  }
});

test('pre-compact edge-triggers the cap nudge — fires once per crossing, re-arms only after rows drop below cap', () => {
  // Without an edge-trigger, every PreCompact that promotes pending rows
  // into an over-cap short-term would re-stage the SAME nudge every time
  // until the user runs /mindwright:dream. The user already saw the
  // reminder; spamming it on every subsequent /compact is hostile.
  // Expected state machine:
  //   armed/null + promotion crosses cap → stage nudge, state := 'fired'
  //   fired      + still over cap         → no-op (already nudged this trip)
  //   fired      + count < cap            → state := 'armed' (dream ran)
  //   armed      + promotion crosses cap  → stage nudge, state := 'fired'
  //
  // Under the pending-staging design, count changes only happen at
  // promotion (PreCompact/SessionEnd/orphan-sweep) — so we exercise the
  // state machine through PreCompact, not Stop. Stop tests for re-arm-on-
  // clear live separately (Stop owns the re-arm side-effect at every
  // turn, since age can trip independently of /compact rhythm).
  const { dir, cleanup } = setupIsolatedRoot();
  try {
    const transcriptPath = writeTranscript(dir, 'sess-edge', [userRec('x')]);

    const input = {
      session_id: 'sess-edge',
      transcript_path: transcriptPath,
      hook_event_name: 'PreCompact',
      trigger: 'manual',
    };

    // Seed CAP_EXCHANGES pending rows and run PreCompact: promotes them all,
    // promotion crosses cap, nudge staged, state → FIRED.
    let s = openStore();
    try {
      for (let i = 0; i < CAP_EXCHANGES; i++) {
        s.insertEntry({
          tier: 'short', kind: 'thinking',
          content: `seed ${i}`, sessionId: 'sess-edge',
          pendingSessionId: 'sess-edge',
        });
      }
    } finally { s.close(); }
    runHook('pre-compact.js', input, dir);
    s = openStore();
    try {
      const row = s.db.prepare('SELECT value FROM meta WHERE key = ?').get('pending_nudge:sess-edge');
      assert.ok(row, 'first cap-crossing PreCompact must stage the nudge');
      assert.equal(s.getNudgeState(), 'fired');
      // Drain the nudge to simulate UserPromptSubmit firing.
      s.takePendingNudge('sess-edge');
    } finally { s.close(); }

    // Stage MORE pending rows and run PreCompact while still over cap →
    // must NOT re-stage. This is the anti-spam guarantee at the promotion
    // boundary.
    s = openStore();
    try {
      for (let i = 0; i < 3; i++) {
        s.insertEntry({
          tier: 'short', kind: 'thinking',
          content: `more pending ${i}`, sessionId: 'sess-edge',
          pendingSessionId: 'sess-edge',
        });
      }
    } finally { s.close(); }
    runHook('pre-compact.js', input, dir);
    s = openStore();
    try {
      const row = s.db.prepare('SELECT value FROM meta WHERE key = ?').get('pending_nudge:sess-edge');
      assert.equal(row, undefined, 'second over-cap PreCompact must NOT re-stage the nudge');
      assert.equal(s.getNudgeState(), 'fired');
    } finally { s.close(); }

    // Simulate /mindwright:dream draining short-term below cap.
    s = openStore();
    try {
      const rows = s.db.prepare(
        `SELECT id FROM entries WHERE session_id = ? AND tier = 'short' AND pending_session_id IS NULL`
      ).all('sess-edge');
      // Hard-delete enough rows to drop below cap.
      const toDelete = rows.slice(0, Math.ceil(rows.length * 0.5)).map((r) => r.id);
      s.hardDeleteShortTerm(toDelete);
    } finally { s.close(); }

    // Stage one more pending row and run PreCompact: promotion happens (so
    // promote-pending runs the cap check), count is now under cap → re-arm.
    s = openStore();
    try {
      s.insertEntry({
        tier: 'short', kind: 'thinking',
        content: 'post-dream pending', sessionId: 'sess-edge',
        pendingSessionId: 'sess-edge',
      });
    } finally { s.close(); }
    runHook('pre-compact.js', input, dir);
    s = openStore();
    try {
      const row = s.db.prepare('SELECT value FROM meta WHERE key = ?').get('pending_nudge:sess-edge');
      assert.equal(row, undefined, 'under-cap PreCompact must not stage a nudge');
      assert.equal(s.getNudgeState(), 'armed',
        'state must re-arm once short-term drops below cap and a promotion happens');
    } finally { s.close(); }

    // Refill past cap with another pending batch — the NEXT PreCompact
    // should re-fire after the re-arm.
    s = openStore();
    try {
      for (let i = 0; i < CAP_EXCHANGES; i++) {
        s.insertEntry({
          tier: 'short', kind: 'thinking',
          content: `refill ${i}`, sessionId: 'sess-edge',
          pendingSessionId: 'sess-edge',
        });
      }
    } finally { s.close(); }
    runHook('pre-compact.js', input, dir);
    s = openStore();
    try {
      const row = s.db.prepare('SELECT value FROM meta WHERE key = ?').get('pending_nudge:sess-edge');
      assert.ok(row, 'second cap trip must re-stage the nudge after re-arm');
      assert.equal(s.getNudgeState(), 'fired');
    } finally { s.close(); }
  } finally {
    cleanup();
  }
});

test('stop reconciles a silently-dead background consolidator — re-nudges and re-arms once the completion lease elapses with no consolidations row', () => {
  // behavior-5: trySpawnConsolidator only confirms the OS accepted the
  // detached `claude --bg` spawn, NOT that /mindwright:dream ran. If the
  // background consolidator dies before its mandatory finalize_drain close
  // (auth failure, rate limit, dream-skill regression, crashed supervisor),
  // no `consolidations` row is written, the FIRED state stays sticky,
  // short-term grows unbounded, and the user is never told. The Stop hook
  // must reconcile: spawn recorded + lease elapsed + no consolidations row +
  // still over cap → re-surface the manual nudge and re-arm so the next
  // crossing retries the spawn instead of leaving the user blind forever.
  const { dir, cleanup } = setupIsolatedRoot();
  try {
    const { handle, input, spawnEnv, rec } =
      primeAutoSpawnedConsolidator(dir, 'sess-reconcile');

    // Backdate last_spawn so the completion lease has elapsed while still no
    // consolidations row exists — i.e. the bg consolidator died silently.
    let store = openStore();
    try {
      const stale = new Date(
        Date.now() - CONSOLIDATOR_COMPLETION_GRACE_MS - 60_000,
      ).toISOString();
      store.setConsolidatorFor(handle, { ...rec, last_spawn: stale });
    } finally { store.close(); }

    // Second Stop: still over cap, state FIRED, spawn recorded, lease
    // elapsed, no consolidations row → reconcile must fire.
    runHook('stop.js', input, dir, null, spawnEnv);

    store = openStore();
    try {
      const row = store.db
        .prepare('SELECT value FROM meta WHERE key = ?')
        .get('pending_nudge:sess-reconcile');
      assert.ok(row, 'a silently-dead consolidator must re-surface the manual nudge');
      assert.match(row.value, /cap reached/i);
      assert.equal(store.getNudgeState(), 'armed',
        'reconcile must re-arm so the next cap crossing retries the spawn');
    } finally { store.close(); }
  } finally {
    cleanup();
  }
});

test('stop does NOT re-nudge when a consolidation completed at or after the spawn — only silent death triggers reconcile', () => {
  // Over-firing guard: if a `consolidations` row exists with fired_at >=
  // last_spawn, the dream DID run. Any remaining over-cap rows are a fresh
  // accumulation the normal re-arm path handles — reconcile must stay quiet,
  // otherwise it becomes the hostile per-trip spam the edge-trigger exists
  // to prevent.
  const { dir, cleanup } = setupIsolatedRoot();
  try {
    const { handle, input, spawnEnv, rec } =
      primeAutoSpawnedConsolidator(dir, 'sess-done');

    let store = openStore();
    try {
      // Lease elapsed (backdated) BUT a consolidation landed after the spawn:
      // the dream completed; this is not the silent-death case.
      const stale = new Date(
        Date.now() - CONSOLIDATOR_COMPLETION_GRACE_MS - 60_000,
      ).toISOString();
      store.setConsolidatorFor(handle, { ...rec, last_spawn: stale });
      store.recordConsolidation({
        sessionId: 'sess-done', drainedCount: 1, drainedBytes: 10, producedCount: 1,
      });
    } finally { store.close(); }

    runHook('stop.js', input, dir, null, spawnEnv);

    store = openStore();
    try {
      const row = store.db
        .prepare('SELECT value FROM meta WHERE key = ?')
        .get('pending_nudge:sess-done');
      assert.equal(row, undefined,
        'a completed dream (consolidations row >= last_spawn) must NOT re-nudge');
      assert.equal(store.getNudgeState(), 'fired',
        'state stays FIRED — reconcile did not fire, edge-trigger anti-spam holds');
    } finally { store.close(); }
  } finally {
    cleanup();
  }
});

test('stop does NOT re-nudge while still within the consolidator completion lease — a slow dream is given time to finish', () => {
  // The lease (CONSOLIDATOR_COMPLETION_GRACE_MS) is generous on purpose: a
  // real dream takes minutes, a rate-limited one longer. Within the window a
  // FIRED-over-cap state with a recent spawn and no consolidations row must
  // stay quiet — nagging now would interrupt a dream that is legitimately
  // still running.
  const { dir, cleanup } = setupIsolatedRoot();
  try {
    const { input, spawnEnv } =
      primeAutoSpawnedConsolidator(dir, 'sess-within-lease');

    // Do NOT backdate: last_spawn ≈ now (well within the lease), still no
    // consolidations row, still over cap.
    runHook('stop.js', input, dir, null, spawnEnv);

    const store = openStore();
    try {
      const row = store.db
        .prepare('SELECT value FROM meta WHERE key = ?')
        .get('pending_nudge:sess-within-lease');
      assert.equal(row, undefined,
        'within the completion lease the Stop hook must not re-nudge');
      assert.equal(store.getNudgeState(), 'fired',
        'state stays FIRED while the spawned consolidator is still within its lease');
    } finally { store.close(); }
  } finally {
    cleanup();
  }
});

test('stop honors MINDWRIGHT_NUDGE=off — never stages the nudge even past cap', () => {
  // Opt-out for users who don't want the cap reminder at all. The env var
  // is read by stop.js at run time; we set it on the spawned hook process.
  const { dir, cleanup } = setupIsolatedRoot();
  try {
    const transcriptPath = writeTranscript(dir, 'sess-optout', [userRec('x')]);
    const store = openStore();
    try {
      for (let i = 0; i < CAP_EXCHANGES; i++) {
        store.insertEntry({ tier: 'short', kind: 'thinking', content: `seed ${i}`, sessionId: 'sess-optout' });
      }
    } finally { store.close(); }

    const res = spawnSync(process.execPath, [join(HOOKS_DIR, 'stop.js')], {
      input: JSON.stringify({
        session_id: 'sess-optout',
        transcript_path: transcriptPath,
        hook_event_name: 'Stop',
        stop_hook_active: false,
      }),
      encoding: 'utf8',
      env: { ...process.env, MINDWRIGHT_PROJECT_ROOT: dir, MINDWRIGHT_NUDGE: 'off' },
    });
    assert.equal(res.status, 0);

    const s = openStore();
    try {
      const row = s.db.prepare('SELECT value FROM meta WHERE key = ?').get('pending_nudge:sess-optout');
      assert.equal(row, undefined, 'MINDWRIGHT_NUDGE=off must suppress the nudge');
      // And the nudge_state row must not have been written either — we
      // skip the whole edge-trigger path under opt-out so other code paths
      // see a clean slate if the user later toggles the env var back on.
      const state = s.db.prepare('SELECT value FROM meta WHERE key = ?').get('nudge_state');
      assert.equal(state, undefined, 'opt-out path must not touch nudge_state either');
    } finally { s.close(); }
  } finally {
    cleanup();
  }
});

test('stop stages no nudge under threshold', () => {
  const { dir, cleanup } = setupIsolatedRoot();
  try {
    const transcriptPath = writeTranscript(dir, 'sess-L', [userRec('x')]);
    const { stdout } = runHook('stop.js', {
      session_id: 'sess-L',
      transcript_path: transcriptPath,
      hook_event_name: 'Stop',
      stop_hook_active: false,
    }, dir);
    assert.deepEqual(stdout, {}, 'stop must emit `{}` regardless of cap status');
    const store = openStore();
    try {
      const row = store.db.prepare('SELECT value FROM meta WHERE key = ?').get('pending_nudge:sess-L');
      assert.equal(row, undefined, 'under-cap stop must NOT stage a nudge');
    } finally {
      store.close();
    }
  } finally {
    cleanup();
  }
});

test('stop fires the safety-net nudge when the oldest short-term row is older than SAFETY_NET_DAYS, even with row count well below cap', () => {
  // Regression for the documented-but-unimplemented safety_net_days config.
  // README and DESIGN.md promise that a session sitting on stale content gets
  // a force-dream nudge regardless of CAP_EXCHANGES; without it, a quiet
  // session can accumulate retrieval-degrading rows forever.
  const { dir, cleanup } = setupIsolatedRoot();
  try {
    const transcriptPath = writeTranscript(dir, 'sess-safety', [userRec('x')]);
    const store = openStore();
    try {
      // Plant 5 rows so we cross SAFETY_NET_MIN_ROWS (the quiet-project
      // suppressor) but stay well below CAP_EXCHANGES (50). Backdate the
      // oldest past the safety net.
      const ids = [];
      for (let i = 0; i < 5; i++) {
        ids.push(store.insertEntry({
          tier: 'short', kind: 'thinking',
          content: `something I wrote four days ago — row ${i}`, sessionId: 'sess-safety',
        }));
      }
      const fourDaysAgo = new Date(Date.now() - (SAFETY_NET_DAYS + 1) * 24 * 60 * 60 * 1000).toISOString();
      store.db.prepare('UPDATE entries SET created_at = ? WHERE id = ?').run(fourDaysAgo, ids[0]);
    } finally {
      store.close();
    }

    runHook('stop.js', {
      session_id: 'sess-safety',
      transcript_path: transcriptPath,
      hook_event_name: 'Stop',
      stop_hook_active: false,
    }, dir);

    const store2 = openStore();
    try {
      const row = store2.db.prepare('SELECT value FROM meta WHERE key = ?').get('pending_nudge:sess-safety');
      assert.ok(row, 'aged short-term content must stage the safety-net nudge');
      assert.match(row.value, /safety net/i, 'nudge body must identify the safety-net reason');
      assert.match(row.value, /\/mindwright:dream/, 'nudge must point at /mindwright:dream');
      assert.equal(store2.getNudgeState(), 'fired');
    } finally {
      store2.close();
    }
  } finally {
    cleanup();
  }
});

test('stop does NOT fire the safety-net nudge on a QUIET project (few stale rows, below SAFETY_NET_MIN_ROWS)', () => {
  // Behavior regression: a low-activity project with 1-2 stale rows used to
  // get nudged every ~3 days even when there was nothing meaningful to
  // consolidate. The min-rows floor now suppresses the age trigger below
  // the threshold.
  const { dir, cleanup } = setupIsolatedRoot();
  try {
    const transcriptPath = writeTranscript(dir, 'sess-quiet', [userRec('x')]);
    const store = openStore();
    try {
      // Plant ONE old row — well below the SAFETY_NET_MIN_ROWS floor.
      const id = store.insertEntry({
        tier: 'short', kind: 'thinking',
        content: 'one lonely row from a week ago', sessionId: 'sess-quiet',
      });
      const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      store.db.prepare('UPDATE entries SET created_at = ? WHERE id = ?').run(weekAgo, id);
    } finally {
      store.close();
    }

    runHook('stop.js', {
      session_id: 'sess-quiet',
      transcript_path: transcriptPath,
      hook_event_name: 'Stop',
      stop_hook_active: false,
    }, dir);

    const store2 = openStore();
    try {
      const row = store2.db.prepare('SELECT value FROM meta WHERE key = ?').get('pending_nudge:sess-quiet');
      assert.equal(row, undefined,
        'quiet project (1 stale row) must NOT stage a nudge — the min-rows floor suppresses spam');
    } finally {
      store2.close();
    }
  } finally {
    cleanup();
  }
});

test('stop does NOT fire the safety-net nudge for fresh rows below cap', () => {
  // Negative pair to the test above: a row that's newer than the safety net
  // AND a count below cap must produce no nudge. Pins the threshold so a
  // future drift doesn't accidentally fire on every Stop.
  const { dir, cleanup } = setupIsolatedRoot();
  try {
    const transcriptPath = writeTranscript(dir, 'sess-fresh', [userRec('x')]);
    const store = openStore();
    try {
      store.insertEntry({
        tier: 'short', kind: 'thinking', content: 'a recent row', sessionId: 'sess-fresh',
      });
    } finally {
      store.close();
    }
    runHook('stop.js', {
      session_id: 'sess-fresh',
      transcript_path: transcriptPath,
      hook_event_name: 'Stop',
      stop_hook_active: false,
    }, dir);
    const store2 = openStore();
    try {
      const row = store2.db.prepare('SELECT value FROM meta WHERE key = ?').get('pending_nudge:sess-fresh');
      assert.equal(row, undefined, 'fresh content below cap must not stage a nudge');
    } finally {
      store2.close();
    }
  } finally {
    cleanup();
  }
});

test('pre-compact fires the cap nudge based on PROJECT-WIDE short-term, even if the firing session owns zero rows', () => {
  // Regression for behavior-4: short Claude Code sessions are typical, and
  // a per-session cap would let project-wide grow unbounded while no single
  // session ever crossed 50 rows. evaluateNudgeTriggers() and the cap path
  // (now in lib/promote-pending.js) must count rows project-wide so a
  // "quiet" session whose peers have piled up rows still sees the nudge —
  // AND the nudge body must include the scope='all' hint so the user doesn't
  // run a session-scoped dream that strands every other session's rows.
  //
  // Under pending-staging, "promotion crosses cap" means: SOMETHING was
  // promoted on this PreCompact AND the resulting project-wide count is
  // over the cap. To exercise the project-wide signal we plant peer rows
  // as REAL short-term (they were promoted at some earlier event) and
  // stage just one pending row under sess-quiet to give promote-pending
  // a non-zero promotion count.
  const { dir, cleanup } = setupIsolatedRoot();
  try {
    const transcriptPath = writeTranscript(dir, 'sess-quiet', [userRec('x')]);
    const store = openStore();
    try {
      // CAP_EXCHANGES rows live under a DIFFERENT session, already promoted.
      for (let i = 0; i < CAP_EXCHANGES; i++) {
        store.insertEntry({
          tier: 'short', kind: 'thinking',
          content: `peer ${i}`, sessionId: 'sess-other',
        });
      }
      // One pending row under the firing session so PreCompact's promote
      // step has something to move — without this, promote-pending.js
      // early-exits (no count change = no cap re-eval, by design).
      store.insertEntry({
        tier: 'short', kind: 'thinking',
        content: 'quiet row', sessionId: 'sess-quiet',
        pendingSessionId: 'sess-quiet',
      });
      // The firing session owns 0 REAL short-term rows (only pending).
      // Sanity-check the setup.
      assert.equal(store.countShortTermFor('sess-quiet'), 0);
      assert.equal(store.countShortTermAllSessions(), CAP_EXCHANGES);
    } finally {
      store.close();
    }

    runHook('pre-compact.js', {
      session_id: 'sess-quiet',
      transcript_path: transcriptPath,
      hook_event_name: 'PreCompact',
      trigger: 'manual',
    }, dir);

    const store2 = openStore();
    try {
      const row = store2.db.prepare('SELECT value FROM meta WHERE key = ?').get('pending_nudge:sess-quiet');
      assert.ok(row, 'project-wide cap must trigger the nudge even when the firing session owns ~0 rows');
      assert.match(row.value, /cap reached/i);
      // Scope hint: the firing session owns only a fraction (1 of CAP+1)
      // so /mindwright:dream needs scope='all' or it'll do nothing useful.
      assert.match(row.value, /scope='all'/, `nudge must suggest scope='all'; got: ${row.value}`);
      assert.match(row.value, /confirm_all_sessions/, `nudge must mention confirm_all_sessions; got: ${row.value}`);
      assert.equal(store2.getNudgeState(), 'fired');
    } finally {
      store2.close();
    }
  } finally {
    cleanup();
  }
});

test('pre-compact does NOT re-fire the cap nudge for a sibling session once the project-wide cap was already fired', () => {
  // Regression for behavior-5: nudge_state used to be keyed per-session
  // (`nudge_state:<sessionId>`) but the trigger is project-wide. Session A
  // fires the nudge → user dismisses by NOT running dream yet. Session B
  // opens in the same project — the project-wide cap is still crossed, but
  // its own `nudge_state:<B>` row is empty → the old code treated that as
  // ARMED and re-staged the nudge. The README's "once per cap crossing"
  // promise was a lie when peers existed.
  //
  // Fix: nudge_state is now a single project-wide key. After A's PreCompact
  // fires (cap-fire moved here from Stop under pending-staging), B's
  // PreCompact must observe state='fired' and skip restaging.
  const { dir, cleanup } = setupIsolatedRoot();
  try {
    // Plant CAP_EXCHANGES PENDING rows under sess-A so PreCompact will
    // promote them and the cap will cross.
    const store = openStore();
    try {
      for (let i = 0; i < CAP_EXCHANGES; i++) {
        store.insertEntry({
          tier: 'short', kind: 'thinking',
          content: `A row ${i}`, sessionId: 'sess-A',
          pendingSessionId: 'sess-A',
        });
      }
    } finally {
      store.close();
    }
    // Session A's PreCompact: promotes, stages the nudge, flips state to FIRED.
    const transcriptA = writeTranscript(dir, 'sess-A', [userRec('x')]);
    runHook('pre-compact.js', {
      session_id: 'sess-A',
      transcript_path: transcriptA,
      hook_event_name: 'PreCompact',
      trigger: 'manual',
    }, dir);

    // Drain A's pending_nudge so it doesn't pollute the assertion below.
    {
      const s = openStore();
      try { s.takePendingNudge('sess-A'); }
      finally { s.close(); }
    }

    // Session B stages a pending row of its own and runs PreCompact — needs
    // SOMETHING to promote, otherwise promote-pending.js early-exits and the
    // cap state machine never gets re-evaluated (which is the design: count
    // changes only at promotion).
    {
      const s = openStore();
      try {
        s.insertEntry({
          tier: 'short', kind: 'thinking',
          content: 'B row', sessionId: 'sess-B',
          pendingSessionId: 'sess-B',
        });
      } finally { s.close(); }
    }
    // Session B's PreCompact in the same cap-crossed state — must NOT re-stage.
    const transcriptB = writeTranscript(dir, 'sess-B', [userRec('y')]);
    runHook('pre-compact.js', {
      session_id: 'sess-B',
      transcript_path: transcriptB,
      hook_event_name: 'PreCompact',
      trigger: 'manual',
    }, dir);

    const store2 = openStore();
    try {
      const rowB = store2.db.prepare(
        'SELECT value FROM meta WHERE key = ?'
      ).get('pending_nudge:sess-B');
      assert.equal(rowB, undefined,
        'sibling session B must NOT re-stage the nudge once A already fired it; ' +
        `got: ${rowB && rowB.value}`);
      assert.equal(store2.getNudgeState(), 'fired',
        'project-wide nudge_state must remain "fired"');
    } finally {
      store2.close();
    }
  } finally {
    cleanup();
  }
});

test('user-prompt-submit preserves a safety-net nudge even when row count is below cap', () => {
  // Without the safety-net branch in the stale-drop check, the UPS hook
  // would re-evaluate ONLY `n >= CAP_EXCHANGES` and silently drop a nudge
  // that Stop legitimately staged for the age trigger. That would make the
  // safety net effectively invisible — Stop would write the nudge and UPS
  // would always swallow it.
  const { dir, cleanup } = setupIsolatedRoot();
  try {
    const store = openStore();
    try {
      // Plant 5 rows so we cross the quiet-project SAFETY_NET_MIN_ROWS floor
      // (5) but stay well below CAP_EXCHANGES (50). Backdate the oldest past
      // the safety net so the age trigger fires.
      const ids = [];
      for (let i = 0; i < 5; i++) {
        ids.push(store.insertEntry({
          tier: 'short', kind: 'thinking',
          content: `aged row ${i}`, sessionId: 'sess-ups-age',
        }));
      }
      const fourDaysAgo = new Date(Date.now() - (SAFETY_NET_DAYS + 1) * 24 * 60 * 60 * 1000).toISOString();
      store.db.prepare('UPDATE entries SET created_at = ? WHERE id = ?').run(fourDaysAgo, ids[0]);
      store.setPendingNudge('sess-ups-age',
        'mindwright: oldest short-term content is 4 day(s) old. Run /mindwright:dream when convenient to consolidate.');
      store.setNudgeState('fired');
    } finally {
      store.close();
    }

    const { stdout } = runHook('user-prompt-submit.js', {
      session_id: 'sess-ups-age',
      hook_event_name: 'UserPromptSubmit',
      prompt: 'do something',
    }, dir);

    assert.ok(stdout && stdout.hookSpecificOutput,
      'staged safety-net nudge must survive UPS re-check');
    assert.match(stdout.hookSpecificOutput.additionalContext, /\/mindwright:dream/);
  } finally {
    cleanup();
  }
});

test('user-prompt-submit drains a staged nudge and emits it as additionalContext', () => {
  // The Stop → UserPromptSubmit handoff path: Stop persists the nudge, the
  // next prompt's UserPromptSubmit hook surfaces it and clears it. The cap
  // must STILL be reached when the nudge surfaces — otherwise the nudge is
  // stale and the hook drops it (covered in the dedicated regression below).
  const { dir, cleanup } = setupIsolatedRoot();
  try {
    const store = openStore();
    try {
      // Plant CAP_EXCHANGES rows so the re-check in UPS confirms cap still reached.
      for (let i = 0; i < CAP_EXCHANGES; i++) {
        store.insertEntry({ tier: 'short', kind: 'thinking', content: `n${i}`, sessionId: 'sess-N' });
      }
      store.setPendingNudge('sess-N', 'mindwright: cap reached. Run /mindwright:dream.');
    } finally {
      store.close();
    }
    const transcriptPath = writeTranscript(dir, 'sess-N', [userRec('next prompt')]);
    const { stdout } = runHook('user-prompt-submit.js', {
      session_id: 'sess-N',
      transcript_path: transcriptPath,
      hook_event_name: 'UserPromptSubmit',
      prompt: 'next prompt',
    }, dir);
    assert.ok(stdout.hookSpecificOutput, 'expected hookSpecificOutput when nudge drains');
    assert.equal(stdout.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    assert.match(stdout.hookSpecificOutput.additionalContext, /cap reached/i);
    assert.match(stdout.hookSpecificOutput.additionalContext, /\/mindwright:dream/);
    // And the nudge is consumed: a second UPS firing must not re-emit it.
    const { stdout: stdout2 } = runHook('user-prompt-submit.js', {
      session_id: 'sess-N',
      transcript_path: transcriptPath,
      hook_event_name: 'UserPromptSubmit',
      prompt: 'next prompt 2',
    }, dir);
    // Unconditional: whether the hook emits {} or hookSpecificOutput, the
    // additionalContext on a second-drain must not carry the cap-reached
    // body. Conditional gating let the {} shape silently pass without
    // running the negative assertion.
    const ac = stdout2.hookSpecificOutput?.additionalContext || '';
    assert.ok(!/cap reached/i.test(ac), 'nudge must be consumed on first drain');
  } finally {
    cleanup();
  }
});

test('user-prompt-submit drops a stale cap-reached nudge after /mindwright:dream cleared the cap', () => {
  // Regression: previously the nudge surfaced unconditionally on the next
  // UserPromptSubmit. If the user ran /mindwright:dream between the Stop
  // that staged it and the UPS that drained it, they'd see "cap reached,
  // run /mindwright:dream" right after doing exactly that. Fix: re-check
  // the cap before surfacing; drop silently and re-arm the edge-trigger.
  const { dir, cleanup } = setupIsolatedRoot();
  try {
    const store = openStore();
    try {
      // Stage the nudge AND set state='fired' (matching what Stop does at cap-cross).
      store.setPendingNudge('sess-stale', 'mindwright: cap reached. Run /mindwright:dream.');
      store.setNudgeState('fired');
      // DO NOT plant short-term rows — simulate that /mindwright:dream
      // already drained everything between Stop and this UPS.
    } finally {
      store.close();
    }
    const transcriptPath = writeTranscript(dir, 'sess-stale', [userRec('after dream')]);
    const { stdout } = runHook('user-prompt-submit.js', {
      session_id: 'sess-stale',
      transcript_path: transcriptPath,
      hook_event_name: 'UserPromptSubmit',
      prompt: 'after dream',
    }, dir);
    const ac = stdout.hookSpecificOutput?.additionalContext || '';
    assert.ok(!/cap reached/i.test(ac),
      `stale nudge must not surface when cap is no longer breached; got: ${ac}`);
    // And the edge-trigger must be re-armed so a future cap crossing fires.
    const s = openStore();
    try {
      assert.equal(s.getNudgeState(), 'armed',
        'dropping the stale nudge must re-arm the edge-trigger');
      const row = s.db.prepare('SELECT value FROM meta WHERE key = ?').get('pending_nudge:sess-stale');
      assert.equal(row, undefined, 'pending_nudge meta row must have been drained');
    } finally {
      s.close();
    }
  } finally {
    cleanup();
  }
});

// ----- SessionEnd ---------------------------------------------------------

test('session-end flushes tail content without injecting context', () => {
  const { dir, cleanup } = setupIsolatedRoot();
  try {
    const transcriptPath = writeTranscript(dir, 'sess-M', [
      userRec('hello'),
      assistantTextRec('goodbye'),
    ]);
    seedTrackedFromZero('sess-M');
    const { stdout } = runHook('session-end.js', {
      session_id: 'sess-M',
      transcript_path: transcriptPath,
      hook_event_name: 'SessionEnd',
      reason: 'logout',
    }, dir);
    assert.deepEqual(stdout, {});
    const store = openStore();
    try {
      const count = store.countShortTermFor('sess-M');
      assert.ok(count >= 2, `flush should write ≥2 rows; got ${count}`);
    } finally {
      store.close();
    }
  } finally {
    cleanup();
  }
});

test('session-end emits empty {} on malformed stdin', () => {
  // Mirrors the session-start malformed-stdin test. The hook MUST silently
  // emit {} rather than crash, since a session-end crash on a malformed
  // payload would surface as a Claude Code error at the user's session
  // teardown — exactly when the user can't react to it.
  const { dir, cleanup } = setupIsolatedRoot();
  try {
    const res = spawnSync(
      process.execPath,
      [join(HOOKS_DIR, 'session-end.js')],
      {
        input: 'not json at all',
        encoding: 'utf8',
        env: { ...process.env, MINDWRIGHT_PROJECT_ROOT: dir },
      }
    );
    assert.equal(res.status, 0);
    const out = JSON.parse(res.stdout.trim() || '{}');
    assert.deepEqual(out, {});
  } finally {
    cleanup();
  }
});

test('session-end emits empty {} when session_id is missing from input', () => {
  // Defensive input validation — the hook short-circuits to {} when either
  // session_id or transcript_path is absent, rather than passing undefined
  // through to flushTranscript and triggering a deep error.
  const { dir, cleanup } = setupIsolatedRoot();
  try {
    const transcriptPath = writeTranscript(dir, 'sess-no-id', [userRec('hi')]);
    const { stdout } = runHook('session-end.js', {
      // session_id deliberately omitted
      transcript_path: transcriptPath,
      hook_event_name: 'SessionEnd',
      reason: 'logout',
    }, dir);
    assert.deepEqual(stdout, {});
    // No rows should have been written under any session — the hook bailed
    // before flushTranscript ran.
    const store = openStore();
    try {
      const rows = store.db.prepare('SELECT COUNT(*) as n FROM entries').get();
      assert.equal(rows.n, 0, 'no entries should have been written on missing session_id');
    } finally {
      store.close();
    }
  } finally {
    cleanup();
  }
});

test('session-end emits empty {} when transcript_path is missing from input', () => {
  const { dir, cleanup } = setupIsolatedRoot();
  try {
    const { stdout } = runHook('session-end.js', {
      session_id: 'sess-no-path',
      // transcript_path deliberately omitted
      hook_event_name: 'SessionEnd',
      reason: 'logout',
    }, dir);
    assert.deepEqual(stdout, {});
    const store = openStore();
    try {
      const count = store.countShortTermFor('sess-no-path');
      assert.equal(count, 0,
        'no rows should have been written when transcript_path is missing');
    } finally {
      store.close();
    }
  } finally {
    cleanup();
  }
});

test('session-end promotes the session\'s pending rows even when transcript_path is missing (no-flush path)', () => {
  // logout / bypass_permissions / unusual termination paths sometimes invoke
  // SessionEnd with no transcript_path. The flush step is skipped, but the
  // session's pending bucket (rows already staged by earlier PreToolUse /
  // UserPromptSubmit passes) MUST still be promoted to real short-term —
  // otherwise the content would sit in pending until the SessionStart
  // orphan-sweep in some other session ~30 min later. Mirrors the
  // pre-compact-without-transcript_path test, but for the SessionEnd path.
  const { dir, cleanup } = setupIsolatedRoot();
  try {
    const store = openStore();
    try {
      for (let i = 0; i < 3; i++) {
        store.insertEntry({
          tier: 'short', kind: 'thinking', content: `pending ${i}`,
          sessionId: 'sess-se-notx', pendingSessionId: 'sess-se-notx',
        });
      }
    } finally { store.close(); }

    const { stdout } = runHook('session-end.js', {
      session_id: 'sess-se-notx',
      // transcript_path deliberately omitted
      hook_event_name: 'SessionEnd',
      reason: 'logout',
    }, dir);
    assert.deepEqual(stdout, {});

    const verify = openStore();
    try {
      assert.equal(verify.countPendingFor('sess-se-notx'), 0,
        'pending rows must promote even without transcript_path');
      assert.equal(verify.countShortTermFor('sess-se-notx'), 3);
    } finally { verify.close(); }
  } finally {
    cleanup();
  }
});

test('session-end stages a pending nudge when promotion crosses the cap (parallel of the PreCompact cap path)', () => {
  // SessionEnd promotes via the same shared promote-pending handler as
  // PreCompact, so a session that crosses CAP_EXCHANGES at session-end
  // boundary must stage the dream nudge for the next session's
  // UserPromptSubmit. Without this assertion a wiring regression (e.g.
  // promote running but the cap pass being short-circuited because
  // ownerSessionId/callerSessionId got swapped or omitted) would only fail
  // in production. Mirrors the PreCompact cap-firing test.
  const { dir, cleanup } = setupIsolatedRoot();
  try {
    const store = openStore();
    try {
      for (let i = 0; i < CAP_EXCHANGES; i++) {
        store.insertEntry({
          tier: 'short', kind: 'thinking', content: `pre-seeded ${i}`,
          sessionId: 'sess-se-cap', pendingSessionId: 'sess-se-cap',
        });
      }
    } finally { store.close(); }

    const { stdout } = runHook('session-end.js', {
      session_id: 'sess-se-cap',
      // transcript_path deliberately omitted — the cap path must not require it.
      hook_event_name: 'SessionEnd',
      reason: 'logout',
    }, dir);
    assert.deepEqual(stdout, {});

    const verify = openStore();
    try {
      // The nudge is staged against the firing session (sess-se-cap) — the
      // shared handler keys pending_nudge to callerSessionId.
      const row = verify.db.prepare('SELECT value FROM meta WHERE key = ?').get('pending_nudge:sess-se-cap');
      assert.ok(row, 'expected pending_nudge:sess-se-cap to be staged at session-end');
      assert.match(row.value, /cap reached/i);
      assert.match(row.value, /\/mindwright:dream/);
      // Sanity: the promote actually ran (cap couldn't cross otherwise).
      assert.equal(verify.countPendingFor('sess-se-cap'), 0);
      assert.equal(verify.countShortTermFor('sess-se-cap'), CAP_EXCHANGES);
    } finally { verify.close(); }
  } finally {
    cleanup();
  }
});

test('session-end clears the persisted tool_map for the ending session (no leak across sessions)', () => {
  // SessionEnd is the clean-shutdown cleanup point for the tool_map blob —
  // any in-flight tool_use that never received its paired tool_result is
  // abandoned by definition once the session ends. Without this cleanup
  // the persisted map row would leak in meta indefinitely (one row per
  // session that ever ran, growing the meta table unboundedly across
  // installs).
  const { dir, cleanup } = setupIsolatedRoot();
  try {
    const store = openStore();
    try {
      store.saveToolMap('sess-se-cleanup', new Map([
        ['tu_orphan', { name: 'Bash', input: { command: 'ls' }, source_ref: 's', timestamp: new Date().toISOString() }],
      ]));
      // Sanity: the row exists before the hook fires.
      assert.equal(store.loadToolMap('sess-se-cleanup').size, 1);
    } finally { store.close(); }

    runHook('session-end.js', {
      session_id: 'sess-se-cleanup',
      hook_event_name: 'SessionEnd',
      reason: 'logout',
    }, dir);

    const verify = openStore();
    try {
      assert.equal(verify.loadToolMap('sess-se-cleanup').size, 0,
        'tool_map must be cleared on session end');
      // _metaGet null == the row is gone, not just an empty serialized map.
      assert.equal(verify._metaGet('tool_map:sess-se-cleanup'), null,
        'meta row must be deleted, not left as a serialized empty map');
    } finally { verify.close(); }
  } finally {
    cleanup();
  }
});
