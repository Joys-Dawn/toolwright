// Backpressure for the seed loop's between-batch consolidate step.
//
// lib/seed-loop.js is pure: at each SEED_BATCH_BUDGET_BYTES boundary it does
// `await consolidate(...); accumulated = 0; continue`. That contract — and the
// SEED_BATCH_BUDGET_BYTES doc, and DESIGN.md "Bootstrap" — promise short-term
// "never holds the whole corpus at once". That promise is only kept if
// `consolidate` actually BLOCKS until short-term has drained back under the
// budget. The previous production wiring injected a bare fire-and-forget
// `spawnConsolidator()`: `await` returned at spawn time, `accumulated` reset to
// 0 with zero rows drained, and the loop kept ingesting at file-I/O speed —
// short-term ballooned toward the entire ~228 MB corpus and one detached
// `claude --bg` was launched per budget boundary (~corpus/budget of them,
// since spawnConsolidator has no already-running guard). implementation-2 /
// correctness-1.
//
// This factory builds the real awaitable `consolidate`:
//   1. Spawn ONE `claude --bg` /mindwright:dream pass (via the injected
//      spawnConsolidator — idempotent per (project, requesterHandle), so it
//      resolves the SAME consolidator session every call).
//   2. Block, polling store.shortTermBytes(), until it is back under the
//      budget — OR a hard timeout elapses.
//   3. One /mindwright:dream drains only ONE bounded batch, so if short-term
//      is still over budget AND the previous pass has COMPLETED (a
//      `consolidations` row with fired_at >= that pass's spawn time — the same
//      terminal signal hooks/stop.js reconciles on), spawn the NEXT pass.
//      Single-flight: a new pass is only ever spawned after the previous one
//      finished, so there is at most one live consolidator — never the storm.
//
// Degraded path: if a spawn returns ok:false (MINDWRIGHT_SPAWN_DISABLE=1,
// `claude` not on PATH, etc.) there is no consolidator to drain anything —
// blocking would hang until the timeout for nothing. Return immediately; the
// seeded rows persist and the next budget boundary / cap-nudge / manual
// /mindwright:dream drains them (the same graceful degradation the rest of the
// pipeline uses when the daemon/CLI is unavailable).
//
// GOVERNING INVARIANT untouched: this only ever READS short-term size and the
// consolidations log; it never threads event_ts (or anything) into a drain/
// finalize/lifecycle query.

import {
  SEED_BATCH_BUDGET_BYTES,
  SEED_CONSOLIDATE_POLL_MS,
  SEED_CONSOLIDATE_TIMEOUT_MS,
  SEED_CONSOLIDATE_MAX_PASSES,
} from './constants.js';
import { spawnConsolidator as realSpawnConsolidator } from './consolidator-spawn.js';
import { logHookError } from './hook-log.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Build the production `consolidate` injected into runSeedLoop.
//
//   store            required — the seed loop's open Store handle.
//   requesterHandle  required — derived from the triggering session id so the
//                    consolidator identity matches the cap-nudge path's.
//   spawnConsolidator injected for tests; defaults to the real detached
//                    `claude --bg` spawner.
//   budgetBytes / pollMs / timeoutMs / maxPasses  tunable; default to the
//                    SEED_* constants. Tests pass tiny values + a fake spawn
//                    that simulates a dream draining short rows.
//   nowFn / sleepFn  injected clock/sleep for deterministic tests.
//   onError          where to report the degraded/timeout/cap cases
//                    (default logHookError); never throws into the loop.
export function makeSeedConsolidate({
  store,
  requesterHandle,
  spawnConsolidator = realSpawnConsolidator,
  budgetBytes = SEED_BATCH_BUDGET_BYTES,
  pollMs = SEED_CONSOLIDATE_POLL_MS,
  timeoutMs = SEED_CONSOLIDATE_TIMEOUT_MS,
  maxPasses = SEED_CONSOLIDATE_MAX_PASSES,
  nowFn = Date.now,
  sleepFn = sleep,
  onError = (msg, e) => logHookError('seed-loop', msg, e),
} = {}) {
  if (!store) throw new Error('makeSeedConsolidate: store required');
  if (typeof requesterHandle !== 'string' || !requesterHandle) {
    throw new Error('makeSeedConsolidate: requesterHandle required');
  }

  // True once a dream pass spawned at-or-before `spawnedAt` has written its
  // terminal `consolidations` row. Same reconciliation signal as
  // hooks/stop.js#spawnedConsolidatorNeverCompleted: a completed dream's
  // mandatory close is mindwright_finalize_drain → store.recordConsolidation.
  const dreamCompletedSince = (spawnedAt) => {
    let last;
    try { last = store.lastConsolidation(); } catch { return false; }
    if (!last || !last.fired_at) return false;
    const done = Date.parse(last.fired_at);
    return Number.isFinite(done) && done >= spawnedAt;
  };

  // Spawn one pass. Returns the spawn timestamp on success, or null when the
  // spawn refused/failed (degraded path — caller stops waiting).
  const spawnOne = (reason) => {
    const at = nowFn();
    let r;
    try {
      r = spawnConsolidator({ requesterHandle, reason, store });
    } catch (e) {
      onError('seed consolidate: spawnConsolidator threw', e);
      return null;
    }
    if (!r || r.ok !== true) {
      // ok:false is expected/benign (spawn disabled, no CLI) — not an error
      // to escalate, just the signal to stop waiting for a drain that can't
      // happen. Recorded best-effort so a persistent failure is observable.
      onError(
        'seed consolidate: consolidator spawn unavailable — skipping backpressure wait',
        new Error((r && r.error) || 'spawnConsolidator returned not-ok'),
      );
      return null;
    }
    return at;
  };

  return async function consolidate({ reason } = {}) {
    // Nothing to wait on if short-term is already under budget (e.g. a prior
    // boundary's dream over-drained). Still no-op-cheap.
    let bytes;
    try { bytes = store.shortTermBytes(); } catch { bytes = 0; }
    if (bytes < budgetBytes) return;

    let spawnedAt = spawnOne(reason || 'seed-loop batch budget reached');
    if (spawnedAt == null) return; // degraded — rows persist for a later drain

    const startedAt = nowFn();
    let passes = 1;

    for (;;) {
      await sleepFn(pollMs);

      try { bytes = store.shortTermBytes(); } catch { bytes = 0; }
      if (bytes < budgetBytes) return; // drained back under budget — proceed

      if (nowFn() - startedAt >= timeoutMs) {
        onError(
          'seed consolidate: timed out waiting for short-term to drain under budget — continuing (rows persist for a later dream)',
          new Error(`shortTermBytes=${bytes} budget=${budgetBytes} passes=${passes}`),
        );
        return;
      }

      if (dreamCompletedSince(spawnedAt)) {
        // The in-flight pass finished but short-term is still over budget —
        // one dream drains only one bounded batch. Spawn the next pass
        // (single-flight: we only reach here once the previous completed),
        // bounded by maxPasses so a non-draining consolidator can't loop.
        if (passes >= maxPasses) {
          onError(
            'seed consolidate: hit max dream passes for this budget boundary — continuing (rows persist for a later dream)',
            new Error(`shortTermBytes=${bytes} budget=${budgetBytes} passes=${passes}`),
          );
          return;
        }
        const next = spawnOne(`${reason || 'seed-loop batch budget'} (pass ${passes + 1})`);
        if (next == null) return; // spawn became unavailable mid-wait
        spawnedAt = next;
        passes += 1;
      }
      // else: a dream is still running — keep waiting; do NOT spawn another
      // (single-flight is the entire point of the storm fix).
    }
  };
}
