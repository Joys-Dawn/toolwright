// Tests for the auto-seed gate (lib/seed-trigger.js#shouldAutoSeed),
// evaluated at SessionStart (hooks/session-start.js#main).
//
// shouldAutoSeed is the pure predicate that decides whether SessionStart fires
// the transcript-bootstrap loop. It is the regression-prone part of Step 11:
// four AND-ed preconditions, deliberately INDEPENDENT of MINDWRIGHT_NUDGE, with
// the isConsolidatorSession self-spawn guard and an empty-memory self-limit.
// The detached spawn itself (maybeAutoSeed) is intentionally NOT unit-tested
// here — spawning a real detached process from a test is the integration
// concern the MINDWRIGHT_SEED_LOOP_DISABLE seam exists to avoid; the gate IS
// the logic. The end-to-end integration (the real SessionStart hook firing the
// loop, and the behavior-1 ordering regression) is covered in
// test/integration/end-to-end.test.js.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../../lib/store.js';
import { shouldAutoSeed, maybeAutoSeed } from '../../lib/seed-trigger.js';
import { transcriptsDir } from '../../lib/paths.js';

const SESS = '33333333-3333-4333-8333-333333333333';

// The three env vars shouldAutoSeed (transitively) reads. node --test runs
// every file in one process, so each test restores exactly these — a leaked
// MINDWRIGHT_AUTO_SEED=false would silently disable auto-seed everywhere else.
const ENV_KEYS = ['MINDWRIGHT_AUTO_SEED', 'MINDWRIGHT_IS_CONSOLIDATOR', 'MINDWRIGHT_NUDGE'];
let envSnapshot;
beforeEach(() => {
  envSnapshot = {};
  for (const k of ENV_KEYS) {
    envSnapshot[k] = process.env[k];
    delete process.env[k]; // clean baseline: every gate input is explicit per test
  }
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (envSnapshot[k] === undefined) delete process.env[k];
    else process.env[k] = envSnapshot[k];
  }
});

// Fresh isolated store + an empty tmp transcripts dir the caller populates.
async function withStore(fn) {
  const prevRoot = process.env.MINDWRIGHT_PROJECT_ROOT;
  const root = mkdtempSync(join(tmpdir(), 'mindwright-seedtrig-'));
  const txDir = mkdtempSync(join(tmpdir(), 'mindwright-seedtrig-tx-'));
  process.env.MINDWRIGHT_PROJECT_ROOT = root;
  const store = openStore();
  try {
    return await fn(store, txDir);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(txDir, { recursive: true, force: true });
    if (prevRoot === undefined) delete process.env.MINDWRIGHT_PROJECT_ROOT;
    else process.env.MINDWRIGHT_PROJECT_ROOT = prevRoot;
  }
}

function plantTranscript(txDir, name = `${SESS}.jsonl`) {
  writeFileSync(join(txDir, name), JSON.stringify({ type: 'user', message: { content: 'hi' } }) + '\n');
}

test('all four preconditions met → true (empty memory + a transcript present)', async () => {
  await withStore(async (store, txDir) => {
    plantTranscript(txDir);
    assert.equal(shouldAutoSeed(store, SESS, txDir), true);
  });
});

test('MINDWRIGHT_AUTO_SEED=false opts out even when everything else passes', async () => {
  await withStore(async (store, txDir) => {
    plantTranscript(txDir);
    process.env.MINDWRIGHT_AUTO_SEED = 'false';
    assert.equal(shouldAutoSeed(store, SESS, txDir), false);
  });
});

test('a non-"false" MINDWRIGHT_AUTO_SEED value does not opt out (default-on)', async () => {
  await withStore(async (store, txDir) => {
    plantTranscript(txDir);
    process.env.MINDWRIGHT_AUTO_SEED = 'true';
    assert.equal(shouldAutoSeed(store, SESS, txDir), true);
  });
});

test('consolidator session via MINDWRIGHT_IS_CONSOLIDATOR=1 → false (self-spawn guard)', async () => {
  await withStore(async (store, txDir) => {
    plantTranscript(txDir);
    process.env.MINDWRIGHT_IS_CONSOLIDATOR = '1';
    assert.equal(shouldAutoSeed(store, SESS, txDir), false);
  });
});

test('consolidator session via the consolidator role (no env var) → false', async () => {
  await withStore(async (store, txDir) => {
    plantTranscript(txDir);
    store.setRoles(SESS, ['consolidator']);
    assert.equal(shouldAutoSeed(store, SESS, txDir), false);
  });
});

test('non-empty memory (a short-tier row exists) → false', async () => {
  await withStore(async (store, txDir) => {
    plantTranscript(txDir);
    store.insertEntry({ tier: 'short', kind: 'thinking', content: 'x', sessionId: SESS });
    assert.equal(shouldAutoSeed(store, SESS, txDir), false);
  });
});

test('non-empty memory (a long-tier row exists) → false', async () => {
  await withStore(async (store, txDir) => {
    plantTranscript(txDir);
    store.insertEntry({
      tier: 'long', category: 'fact', scope: 'project', kind: 'fact',
      content: 'an established fact', sessionId: SESS,
    });
    assert.equal(shouldAutoSeed(store, SESS, txDir), false);
  });
});

test('no transcripts directory → false (nothing to bootstrap)', async () => {
  await withStore(async (store) => {
    const missing = join(tmpdir(), `mindwright-seedtrig-missing-${process.pid}-${Date.now()}`);
    assert.equal(shouldAutoSeed(store, SESS, missing), false);
  });
});

test('transcripts dir present but holds no *.jsonl → false', async () => {
  await withStore(async (store, txDir) => {
    writeFileSync(join(txDir, 'notes.md'), '# not a transcript\n');
    writeFileSync(join(txDir, 'config.json'), '{}\n');
    assert.equal(shouldAutoSeed(store, SESS, txDir), false);
  });
});

test('MINDWRIGHT_NUDGE=off does NOT suppress auto-seed (independent gate)', async () => {
  await withStore(async (store, txDir) => {
    plantTranscript(txDir);
    process.env.MINDWRIGHT_NUDGE = 'off';
    assert.equal(shouldAutoSeed(store, SESS, txDir), true,
      'a user who silenced nudges still wants their memory bootstrapped');
  });
});

test('a countByTier failure is treated as "do not seed" (defensive, never throws)', () => {
  // A store whose countByTier throws (e.g. a transient DB error) must not
  // crash the Stop hook — the predicate swallows it and declines to seed.
  const brokenStore = {
    getRoles() { return []; },
    countByTier() { throw new Error('simulated DB failure'); },
  };
  assert.doesNotThrow(() => shouldAutoSeed(brokenStore, SESS, '/nonexistent'));
  assert.equal(shouldAutoSeed(brokenStore, SESS, '/nonexistent'), false);
});

// maybeAutoSeed (the launcher around the gate). Its happy path — the gate
// passing AND a real detached seed-loop process actually starting — is the
// integration concern covered end-to-end by
// test/integration/end-to-end.test.js ("behavior-1: the real SessionStart
// hook fires the transcript-bootstrap loop…"), which runs the genuine spawn.
// Re-asserting that here would mean module-mocking child_process.spawn — the
// over-mocking anti-pattern the MINDWRIGHT_SEED_LOOP_DISABLE seam exists to
// avoid. What is NOT covered there, and IS unit-testable without spawning, is
// the launcher's orchestration contract: it must (a) short-circuit silently
// when the gate is false, and (b) honor the disable seam even when the gate
// passes — in both cases returning undefined and never throwing, because
// auto-seed must never disrupt SessionStart.

test('maybeAutoSeed short-circuits (no spawn, no throw) when the gate is false via MINDWRIGHT_AUTO_SEED=false', async () => {
  await withStore(async (store) => {
    process.env.MINDWRIGHT_AUTO_SEED = 'false'; // gate opt-out: shouldAutoSeed returns false before any fs/spawn work

    // The behavioral contract is "auto-seed never disrupts SessionStart" →
    // it must not throw. maybeAutoSeed is a fire-and-forget void launcher;
    // its return value is not a contract, so asserting it equals undefined
    // would verify nothing.
    assert.doesNotThrow(() => maybeAutoSeed(store, SESS));
  });
});

test('maybeAutoSeed honors the MINDWRIGHT_SEED_LOOP_DISABLE seam (no detached process, no throw) when the gate passes', async () => {
  // This test makes the gate genuinely pass — empty store + a real *.jsonl in
  // the project's resolved transcriptsDir() — so the ONLY thing preventing the
  // detached spawn is the seam. A vacuously-false gate would make this assert
  // nothing, so the precondition is asserted explicitly.
  const prevSeam = process.env.MINDWRIGHT_SEED_LOOP_DISABLE;
  const prevCpd = process.env.MINDWRIGHT_CLAUDE_PROJECTS_DIR;
  const cpd = mkdtempSync(join(tmpdir(), 'mindwright-seedtrig-cpd-'));
  process.env.MINDWRIGHT_CLAUDE_PROJECTS_DIR = cpd;
  try {
    await withStore(async (store) => {
      // withStore has set MINDWRIGHT_PROJECT_ROOT, so transcriptsDir() now
      // resolves to <cpd>/<projectSlug(root)> — the exact dir maybeAutoSeed
      // will read internally. Plant a transcript there.
      const txReal = transcriptsDir();
      mkdirSync(txReal, { recursive: true });
      plantTranscript(txReal);

      assert.equal(shouldAutoSeed(store, SESS, txReal), true,
        'precondition: the gate must genuinely pass so the seam is what suppresses the spawn');

      process.env.MINDWRIGHT_SEED_LOOP_DISABLE = '1';
      // The gate genuinely passes (asserted above), so the seam is the only
      // thing suppressing the detached spawn. Contract: returns without
      // throwing (and, by the seam, without spawning).
      assert.doesNotThrow(() => maybeAutoSeed(store, SESS));
    });
  } finally {
    if (prevSeam === undefined) delete process.env.MINDWRIGHT_SEED_LOOP_DISABLE;
    else process.env.MINDWRIGHT_SEED_LOOP_DISABLE = prevSeam;
    if (prevCpd === undefined) delete process.env.MINDWRIGHT_CLAUDE_PROJECTS_DIR;
    else process.env.MINDWRIGHT_CLAUDE_PROJECTS_DIR = prevCpd;
    rmSync(cpd, { recursive: true, force: true });
  }
});
