// Unit tests for lib/promote-pending.js — the shared "promote → real
// short-term + cap-side spawn" handler that PreCompact, SessionEnd, and
// SessionStart-orphan-sweep all delegate to.
//
// The hook-level integration tests in test/hooks/hooks.test.js drive this
// through the full subprocess path; these tests pin the LOGIC contracts
// directly so a regression in the shared path-of-no-return helper fails
// loud with a clear stack instead of being detected only via the
// downstream hook tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../lib/store.js';
import { promoteAndMaybeSpawn } from '../lib/promote-pending.js';
import { CAP_EXCHANGES, NUDGE_STATES } from '../lib/constants.js';

function withStore(fn) {
  const prevProjectRoot = process.env.MINDWRIGHT_PROJECT_ROOT;
  const prevNudge = process.env.MINDWRIGHT_NUDGE;
  const prevSeed = process.env.MINDWRIGHT_SEED_TRANSCRIPT;
  const prevSpawnDisable = process.env.MINDWRIGHT_SPAWN_DISABLE;
  const dir = mkdtempSync(join(tmpdir(), 'mindwright-pp-'));
  process.env.MINDWRIGHT_PROJECT_ROOT = dir;
  // The whole suite uses the fallback nudge path (no real `claude` binary).
  // Setting MINDWRIGHT_SPAWN_DISABLE=1 makes spawnConsolidator return early
  // so out.spawned === false and the test can observe the fallback nudge.
  process.env.MINDWRIGHT_SPAWN_DISABLE = '1';
  const store = openStore();
  try {
    return fn(store, dir);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
    if (prevProjectRoot === undefined) delete process.env.MINDWRIGHT_PROJECT_ROOT;
    else process.env.MINDWRIGHT_PROJECT_ROOT = prevProjectRoot;
    if (prevNudge === undefined) delete process.env.MINDWRIGHT_NUDGE;
    else process.env.MINDWRIGHT_NUDGE = prevNudge;
    if (prevSeed === undefined) delete process.env.MINDWRIGHT_SEED_TRANSCRIPT;
    else process.env.MINDWRIGHT_SEED_TRANSCRIPT = prevSeed;
    if (prevSpawnDisable === undefined) delete process.env.MINDWRIGHT_SPAWN_DISABLE;
    else process.env.MINDWRIGHT_SPAWN_DISABLE = prevSpawnDisable;
  }
}

function seedPending(store, sessionId, count) {
  for (let i = 0; i < count; i++) {
    store.insertEntry({
      tier: 'short', kind: 'thinking',
      content: `pending ${sessionId} ${i}`,
      sessionId, pendingSessionId: sessionId,
    });
  }
}

test('returns zeros + no-op when ownerSessionId is missing or invalid', () => {
  withStore((store) => {
    // The shared helper is the single source of truth for the promote +
    // cap-eval boundary; a misuse must fail SAFELY (no DB churn, no spawn,
    // no nudge) so a hook author who forgets the parameter doesn't leak
    // a half-fired side effect.
    for (const owner of [undefined, null, '', 42, {}]) {
      const r = promoteAndMaybeSpawn({ store, ownerSessionId: owner, callerSessionId: 'c' });
      assert.deepEqual(r, { promoted: 0, capCrossed: false, ageCrossed: false, spawned: false, nudged: false });
    }
  });
});

test('no pending rows for the owner → early exit (no triggers eval, no spawn, no nudge)', () => {
  withStore((store) => {
    // Pre-populate sibling state so a missed early-exit would show. If the
    // helper kept going on `promoted === 0`, the FIRED state below would
    // get reset to ARMED (its no-trigger re-arm path) — that's the
    // regression we're guarding.
    store.setNudgeState(NUDGE_STATES.FIRED);

    const r = promoteAndMaybeSpawn({
      store, ownerSessionId: 's-empty', callerSessionId: 's-empty', tag: 'unit',
    });
    assert.deepEqual(r, { promoted: 0, capCrossed: false, ageCrossed: false, spawned: false, nudged: false });
    assert.equal(store.getNudgeState(), 'fired',
      'with no rows promoted, state must remain untouched');
  });
});

test('promote with no cap/age crossing → re-arms a sticky FIRED state', () => {
  withStore((store) => {
    seedPending(store, 's-rearm', 2);
    store.setNudgeState(NUDGE_STATES.FIRED);
    const r = promoteAndMaybeSpawn({ store, ownerSessionId: 's-rearm', callerSessionId: 's-rearm' });
    assert.equal(r.promoted, 2);
    assert.equal(r.capCrossed, false);
    assert.equal(r.ageCrossed, false);
    assert.equal(r.spawned, false);
    assert.equal(r.nudged, false);
    assert.equal(store.getNudgeState(), 'armed',
      'when both triggers clear after promotion, FIRED must re-arm');
  });
});

test('promotion crosses cap (ARMED) → spawn refuses → stage fallback nudge + FIRED', () => {
  withStore((store) => {
    seedPending(store, 's-cap', CAP_EXCHANGES);
    const r = promoteAndMaybeSpawn({ store, ownerSessionId: 's-cap', callerSessionId: 's-cap' });
    assert.equal(r.promoted, CAP_EXCHANGES);
    assert.equal(r.capCrossed, true);
    assert.equal(r.ageCrossed, false);
    assert.equal(r.spawned, false, 'MINDWRIGHT_SPAWN_DISABLE=1 prevents spawn');
    assert.equal(r.nudged, true, 'fallback nudge takes over when spawn refuses');
    assert.equal(store.getNudgeState(), 'fired');
    const nudge = store.takePendingNudge('s-cap');
    assert.match(nudge, /cap reached/i,
      'fallback nudge body must mention the cap');
  });
});

test('promotion crosses cap (FIRED already) → no re-stage; out flags reflect skip', () => {
  withStore((store) => {
    // First crossing arms FIRED.
    seedPending(store, 's-trip', CAP_EXCHANGES);
    promoteAndMaybeSpawn({ store, ownerSessionId: 's-trip', callerSessionId: 's-trip' });
    store.takePendingNudge('s-trip'); // simulate the user receiving the nudge
    assert.equal(store.getNudgeState(), 'fired');

    // Second pass: stage more pending and re-promote. Cap still crossed,
    // state is FIRED → no spawn, no nudge, but counts reflect a promotion.
    seedPending(store, 's-trip', 2);
    const r = promoteAndMaybeSpawn({ store, ownerSessionId: 's-trip', callerSessionId: 's-trip' });
    assert.equal(r.promoted, 2);
    assert.equal(r.capCrossed, true);
    assert.equal(r.spawned, false);
    assert.equal(r.nudged, false, 'FIRED suppresses re-staging');
    assert.equal(store.takePendingNudge('s-trip'), null);
    assert.equal(store.getNudgeState(), 'fired');
  });
});

test('MINDWRIGHT_NUDGE=off short-circuits AFTER promote (rows still move, no nudge/spawn)', () => {
  withStore((store) => {
    seedPending(store, 's-off', CAP_EXCHANGES);
    process.env.MINDWRIGHT_NUDGE = 'off';
    const r = promoteAndMaybeSpawn({ store, ownerSessionId: 's-off', callerSessionId: 's-off' });
    delete process.env.MINDWRIGHT_NUDGE;

    assert.equal(r.promoted, CAP_EXCHANGES, 'promote still runs — opt-out is on nudge, not flush');
    assert.equal(r.capCrossed, false, 'evaluator never ran under opt-out');
    assert.equal(r.nudged, false);
    assert.equal(store.takePendingNudge('s-off'), null);
    // nudge_state row was NOT created — opt-out path must leave a clean
    // slate so toggling the env back on doesn't see stale state.
    const stateRow = store.db.prepare('SELECT value FROM meta WHERE key = ?').get('nudge_state');
    assert.equal(stateRow, undefined);
  });
});

test('MINDWRIGHT_SEED_TRANSCRIPT=1 suspends auto-spawn but stages the fallback nudge', () => {
  withStore((store) => {
    seedPending(store, 's-seed', CAP_EXCHANGES);
    // Clear the suite-wide MINDWRIGHT_SPAWN_DISABLE so the test can prove the
    // SEED guard is what skipped the spawn (not the disable flag).
    delete process.env.MINDWRIGHT_SPAWN_DISABLE;
    process.env.MINDWRIGHT_SEED_TRANSCRIPT = '1';
    let r;
    try {
      r = promoteAndMaybeSpawn({ store, ownerSessionId: 's-seed', callerSessionId: 's-seed' });
    } finally {
      delete process.env.MINDWRIGHT_SEED_TRANSCRIPT;
      // Restore the suite-wide flag so the `finally` cleanup in withStore
      // sees the same value it snapshotted.
      process.env.MINDWRIGHT_SPAWN_DISABLE = '1';
    }
    assert.equal(r.promoted, CAP_EXCHANGES);
    assert.equal(r.capCrossed, true);
    assert.equal(r.spawned, false, 'seed mode must suppress the spawn');
    assert.equal(r.nudged, true, 'seed mode must still stage the manual nudge');
    assert.equal(store.getNudgeState(), 'fired');
  });
});

test('orphan promotion: owner is a dead session, caller is the live SessionStart caller', () => {
  withStore((store) => {
    seedPending(store, 's-dead', CAP_EXCHANGES);
    // Backdate so SessionStart's orphan sweep WOULD flag this in production;
    // for the unit-level helper we just call directly with the dead owner.
    const old = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    store.db.prepare('UPDATE entries SET created_at = ? WHERE pending_session_id = ?')
      .run(old, 's-dead');

    const r = promoteAndMaybeSpawn({
      store,
      ownerSessionId: 's-dead',
      callerSessionId: 's-live',
      tag: 'orphan-sweep',
    });
    assert.equal(r.promoted, CAP_EXCHANGES,
      "orphan owner's rows must promote");
    assert.equal(r.nudged, true,
      'when promotion crosses cap, the LIVE caller surfaces the nudge');
    // Pending nudge is keyed to the LIVE caller, not the dead owner — the
    // dead session can no longer receive UserPromptSubmit events.
    assert.ok(store.takePendingNudge('s-live'),
      'nudge must be staged for the live caller (the one whose UPS will see it)');
    assert.equal(store.takePendingNudge('s-dead'), null,
      'no nudge should be staged for the dead owner');
  });
});
