// Backpressure for the seed loop's between-batch consolidate step. The seed
// loop's "short-term never holds the whole corpus at once" promise only holds
// if `consolidate` BLOCKS until short-term drains back under budget — a bare
// fire-and-forget spawn returns immediately and lets short-term balloon.
//
// This factory builds the awaitable `consolidate`: spawn one /mindwright:dream
// pass, poll store.shortTermBytes() until under budget or a timeout, and only
// spawn the NEXT pass once the previous COMPLETED (a `consolidations` row with
// fired_at >= its spawn time). Single-flight: at most one live consolidator.
//
// Degraded path: a spawn returning ok:false (disabled, no CLI) means nothing
// can drain — return immediately; seeded rows persist for a later drain.
//
// GOVERNING INVARIANT: only ever READS short-term size and the consolidations
// log; never threads anything into a drain/finalize/lifecycle query.

import {
  SEED_BATCH_BUDGET_BYTES,
  SEED_CONSOLIDATE_POLL_MS,
  SEED_CONSOLIDATE_TIMEOUT_MS,
  SEED_CONSOLIDATE_MAX_PASSES,
} from './constants.js';
import { spawnConsolidator as realSpawnConsolidator } from './consolidator-spawn.js';
import { logHookError } from './hook-log.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Build the `consolidate` injected into runSeedLoop. requesterHandle must be
// derived from the triggering session id so the consolidator identity matches
// the cap-nudge path's. Other params are test injection points.
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

  // True once a pass spawned at-or-before `spawnedAt` wrote its terminal
  // `consolidations` row (a completed dream's mandatory close is
  // finalize_drain → recordConsolidation).
  const dreamCompletedSince = (spawnedAt) => {
    let last;
    try { last = store.lastConsolidation(); } catch { return false; }
    if (!last || !last.fired_at) return false;
    const done = Date.parse(last.fired_at);
    return Number.isFinite(done) && done >= spawnedAt;
  };

  // Returns the spawn timestamp, or null when the spawn refused/failed
  // (degraded path — caller stops waiting).
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
      // ok:false is benign (spawn disabled, no CLI) — the signal to stop
      // waiting for a drain that can't happen. Recorded so persistent failure
      // is observable.
      onError(
        'seed consolidate: consolidator spawn unavailable — skipping backpressure wait',
        new Error((r && r.error) || 'spawnConsolidator returned not-ok'),
      );
      return null;
    }
    return at;
  };

  return async function consolidate({ reason } = {}) {
    // Already under budget (e.g. a prior boundary over-drained) — nothing to
    // wait on.
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
      if (bytes < budgetBytes) return;

      if (nowFn() - startedAt >= timeoutMs) {
        onError(
          'seed consolidate: timed out waiting for short-term to drain under budget — continuing (rows persist for a later dream)',
          new Error(`shortTermBytes=${bytes} budget=${budgetBytes} passes=${passes}`),
        );
        return;
      }

      if (dreamCompletedSince(spawnedAt)) {
        // Previous pass finished but still over budget (one dream drains one
        // bounded batch). Single-flight: only spawn the next here. maxPasses
        // bounds a non-draining consolidator.
        if (passes >= maxPasses) {
          onError(
            'seed consolidate: hit max dream passes for this budget boundary — continuing (rows persist for a later dream)',
            new Error(`shortTermBytes=${bytes} budget=${budgetBytes} passes=${passes}`),
          );
          return;
        }
        const next = spawnOne(`${reason || 'seed-loop batch budget'} (pass ${passes + 1})`);
        if (next == null) return;
        spawnedAt = next;
        passes += 1;
      }
      // else: a dream is still running — keep waiting, do NOT spawn another
      // (single-flight).
    }
  };
}
