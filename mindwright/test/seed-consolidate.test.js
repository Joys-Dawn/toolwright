// Tests for lib/seed-consolidate.js — the seed loop's between-batch
// backpressure. The defect this fixes (implementation-2 / correctness-1): the
// production consolidate was a bare fire-and-forget spawnConsolidator, so the
// loop's `await consolidate(); accumulated = 0` reset with zero rows drained,
// short-term ballooned toward the whole corpus, and one detached `claude --bg`
// was launched per budget boundary. These tests assert the waiter actually
// blocks until short-term drains under budget, is single-flight (never two
// live consolidators), and degrades/caps instead of hanging.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../lib/store.js';
import { runSeedLoop } from '../lib/seed-loop.js';
import { makeSeedConsolidate } from '../lib/seed-consolidate.js';

// -- Unit harness: a synthetic clock + a duck-typed store so the wait logic is
// exercised deterministically without a real DB or real time. sleepFn advances
// the clock by pollMs (a faithful model of "poll every pollMs") and resolves
// instantly so the suite is fast.

function harness({ bytes, budget = 1000, pollMs = 10, timeoutMs = 1000, maxPasses = 8 }) {
  const clock = { t: 1_000_000 };
  const store = {
    bytes,
    lastFiredAt: null,
    shortTermBytes() { return this.bytes; },
    lastConsolidation() {
      return this.lastFiredAt == null ? undefined : { fired_at: new Date(this.lastFiredAt).toISOString() };
    },
  };
  const spawns = [];
  const errors = [];
  // Default fake spawn: succeeds, records nothing (caller overrides .impl to
  // model a dream completing / draining).
  const spawnFake = {
    impl: () => ({ ok: true }),
  };
  const consolidate = makeSeedConsolidate({
    store,
    requesterHandle: 'tester-1',
    spawnConsolidator: (args) => {
      spawns.push({ at: clock.t, args });
      return spawnFake.impl(spawns.length);
    },
    budgetBytes: budget,
    pollMs,
    timeoutMs,
    maxPasses,
    nowFn: () => clock.t,
    sleepFn: async () => { clock.t += pollMs; },
    onError: (msg, e) => errors.push({ msg, e }),
  });
  return { clock, store, spawns, errors, spawnFake, consolidate };
}

test('returns immediately without spawning when short-term is already under budget', async () => {
  const h = harness({ bytes: 500, budget: 1000 });
  await h.consolidate({ reason: 'r' });
  assert.equal(h.spawns.length, 0, 'no consolidator spawned — nothing to drain');
});

test('blocks until short-term drains under budget, then returns (one pass suffices)', async () => {
  const h = harness({ bytes: 5000, budget: 1000 });
  // The dream pass completes at its spawn instant and drains everything.
  h.spawnFake.impl = () => {
    h.store.lastFiredAt = h.clock.t;
    h.store.bytes = 200;
    return { ok: true };
  };
  await h.consolidate({ reason: 'budget' });
  assert.equal(h.spawns.length, 1, 'exactly one consolidator pass — no storm');
  assert.ok(h.store.bytes < 1000, 'returned only after short-term was under budget');
  assert.equal(h.errors.length, 0);
});

test('re-spawns the NEXT pass only after the previous completed, until under budget (single-flight)', async () => {
  const h = harness({ bytes: 3000, budget: 1000 });
  // Each completed pass drains 1000 bytes. 3000 → 2000 → 1000 → 0: needs 3
  // passes. Each spawn marks itself complete at its own spawn instant.
  h.spawnFake.impl = () => {
    h.store.lastFiredAt = h.clock.t;
    h.store.bytes = Math.max(0, h.store.bytes - 1000);
    return { ok: true };
  };
  await h.consolidate({ reason: 'budget' });
  assert.equal(h.spawns.length, 3, 'three sequential single-flight passes (3000/1000)');
  // Single-flight: every re-spawn happened strictly after the prior pass's
  // completion timestamp — never two live at once.
  for (let i = 1; i < h.spawns.length; i++) {
    assert.ok(h.spawns[i].at > h.spawns[i - 1].at,
      'each pass spawned only after the previous one completed');
  }
  assert.ok(h.store.bytes < 1000);
});

test('does NOT spawn a second pass while the first dream is still in flight', async () => {
  const h = harness({ bytes: 5000, budget: 1000, pollMs: 10, timeoutMs: 100_000 });
  // The dream is "in flight" for the first 5 polls (50ms): not completed, not
  // drained. Only after that does it complete and drain. The waiter must wait
  // through the in-flight window WITHOUT spawning again — single-flight is the
  // entire storm fix.
  const COMPLETE_AT = h.clock.t + 50;
  h.spawnFake.impl = () => ({ ok: true });
  h.store.shortTermBytes = () => (h.clock.t >= COMPLETE_AT ? 200 : 5000);
  h.store.lastConsolidation = () =>
    (h.clock.t >= COMPLETE_AT ? { fired_at: new Date(h.clock.t).toISOString() } : undefined);

  await h.consolidate({ reason: 'budget' });

  assert.equal(h.spawns.length, 1,
    'only one spawn — no re-spawn while the in-flight dream had not completed');
});

test('degraded: a not-ok spawn returns immediately (no hang, no wait)', async () => {
  const h = harness({ bytes: 9999, budget: 1000 });
  h.spawnFake.impl = () => ({ ok: false, error: 'spawn disabled via MINDWRIGHT_SPAWN_DISABLE' });
  await h.consolidate({ reason: 'budget' });
  assert.equal(h.spawns.length, 1, 'spawn attempted once');
  assert.equal(h.store.bytes, 9999, 'no draining — there is no consolidator');
  assert.ok(
    h.errors.some((e) => /unavailable/.test(e.msg)),
    'the degraded path is recorded best-effort',
  );
});

test('degraded: a spawn that THROWS is swallowed and returns (loop never aborts)', async () => {
  const h = harness({ bytes: 9999, budget: 1000 });
  h.spawnFake.impl = () => { throw new Error('ENOENT claude'); };
  await assert.doesNotReject(h.consolidate({ reason: 'budget' }));
  assert.ok(h.errors.some((e) => /threw/.test(e.msg)));
});

test('times out (does not hang forever) when the dream never drains', async () => {
  const h = harness({ bytes: 9999, budget: 1000, pollMs: 10, timeoutMs: 60 });
  // Spawn succeeds but the dream never completes and never drains.
  h.spawnFake.impl = () => ({ ok: true });
  await h.consolidate({ reason: 'budget' });
  assert.equal(h.spawns.length, 1, 'no completion → no re-spawn (single-flight)');
  assert.ok(
    h.errors.some((e) => /timed out/.test(e.msg)),
    'the timeout cap fired instead of hanging',
  );
});

test('caps at maxPasses when every pass completes but never drains under budget', async () => {
  const h = harness({ bytes: 9999, budget: 1000, pollMs: 10, timeoutMs: 1_000_000, maxPasses: 4 });
  // Each pass completes (records a consolidation at its spawn instant) but
  // drains nothing — without the cap this would re-spawn forever.
  h.spawnFake.impl = () => {
    h.store.lastFiredAt = h.clock.t;
    return { ok: true };
  };
  await h.consolidate({ reason: 'budget' });
  assert.equal(h.spawns.length, 4, 'bounded to maxPasses — never an unbounded re-spawn storm');
  assert.ok(h.errors.some((e) => /max dream passes/.test(e.msg)));
});

// -- Integration: the real store + the real seed loop, with a fake
// spawnConsolidator that synchronously simulates a dream draining the
// project-wide short rows. Proves the invariant the finding said was false:
// short-term peak stays bounded near the budget instead of the whole corpus.

async function withStore(fn) {
  const prev = process.env.MINDWRIGHT_PROJECT_ROOT;
  const root = mkdtempSync(join(tmpdir(), 'mindwright-seedcons-'));
  const txDir = mkdtempSync(join(tmpdir(), 'mindwright-seedcons-tx-'));
  process.env.MINDWRIGHT_PROJECT_ROOT = root;
  const store = openStore();
  try {
    return await fn(store, txDir);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(txDir, { recursive: true, force: true });
    if (prev === undefined) delete process.env.MINDWRIGHT_PROJECT_ROOT;
    else process.env.MINDWRIGHT_PROJECT_ROOT = prev;
  }
}

test('integration: seed loop + real backpressure keeps short-term peak bounded near the budget (not the whole corpus)', async () => {
  await withStore(async (store, txDir) => {
    // 6 transcripts, each one ~3 KB user prompt → cumulative far over a 4 KB
    // budget. Without backpressure all 6 would pile into short-term at once;
    // with it, each budget crossing must drain back down before continuing.
    for (let i = 0; i < 6; i++) {
      writeFileSync(
        join(txDir, `s${i}-1111-4111-8111-1111111111${i}${i}.jsonl`),
        JSON.stringify({
          type: 'user',
          message: { content: `transcript ${i} ` + 'x'.repeat(3000) },
          timestamp: `2024-0${i + 1}-01T00:00:00.000Z`,
          uuid: `u-${i}`,
        }) + '\n',
      );
    }

    const peaks = [];
    // Fake dream: record the short-term size we observed (the peak the loop
    // ever let accumulate), then drain ALL active short rows + log a
    // consolidation, exactly as a finalize-drain would.
    const fakeSpawn = () => {
      peaks.push(store.shortTermBytes());
      const ids = store.db
        .prepare(`SELECT id FROM entries WHERE tier='short' AND active=1`)
        .all()
        .map((r) => r.id);
      if (ids.length) {
        store.hardDeleteShortTerm(ids);
        store.recordConsolidation({
          sessionId: 'fake-dream',
          drainedCount: ids.length,
          drainedBytes: 0,
          producedCount: 1,
        });
      }
      return { ok: true };
    };

    const consolidate = makeSeedConsolidate({
      store,
      requesterHandle: 'integ-1',
      spawnConsolidator: fakeSpawn,
      budgetBytes: 4096,
      pollMs: 1,
      timeoutMs: 60_000,
      sleepFn: async () => {},
      onError: () => {},
    });

    const summary = await runSeedLoop({
      store,
      transcriptsDir: txDir,
      batchBudgetBytes: 4096,
      consolidate,
    });

    assert.equal(summary.transcriptsSeeded, 6);
    assert.ok(summary.consolidations >= 2,
      `multiple budget boundaries should have triggered drains, got ${summary.consolidations}`);
    assert.ok(peaks.length > 0, 'the consolidator ran at least once');
    // The whole corpus is ~18 KB; the budget is 4 KB. With real backpressure
    // the loop never lets short-term hold more than roughly one budget plus
    // the single transcript that tipped it over (~3 KB). A regression to
    // fire-and-forget would push this toward the full ~18 KB.
    const peak = Math.max(...peaks);
    assert.ok(
      peak < 4096 + 4096,
      `short-term peak (${peak}B) must stay bounded near the 4096B budget, not balloon to the corpus`,
    );
    // Everything drained between/at boundaries — short-term ends ~empty.
    assert.ok(store.shortTermBytes() < 4096, 'final flush drained the tail');
  });
});
