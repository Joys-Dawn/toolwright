// Self-rescheduling sweeper-tick scheduler. Two callers want the same
// "fire `sweep`, wait for it to resolve, fire again after `intervalMs`"
// pattern: the live MCP server's deferred-embed sweeper, and tests that
// need to assert ticks never overlap (best-practices-1 regression).
//
// Why not setInterval? sweepOnce's per-text fallback path can run for many
// seconds on a poison-heavy batch (one sync embed per row). setInterval
// would fire the next tick on schedule regardless, leading to two
// concurrent sweeps writing to vec_index simultaneously and double-bumping
// embed_failures counters. With this setTimeout-chain, the next tick is
// only armed AFTER the current sweep resolves; a long sweep stretches the
// next interval rather than overlapping with itself.
//
// Returns a handle with `.stop()` that idempotently cancels any pending
// tick and prevents future ones. Errors raised inside `sweep` are routed
// to `onError` and never propagated — failure modes inside one sweep must
// not break the loop.

export function startSweeperLoop({ sweep, intervalMs, onError = null }) {
  if (typeof sweep !== 'function') throw new TypeError('sweep must be a function');
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new RangeError('intervalMs must be a positive finite number');
  }

  let handle = null;
  let stopped = false;

  const scheduleNext = () => {
    if (stopped) return;
    handle = setTimeout(tick, intervalMs);
    // Don't keep the event loop alive just for this background task.
    if (handle && typeof handle.unref === 'function') handle.unref();
  };

  async function tick() {
    try {
      await sweep();
    } catch (err) {
      if (onError) {
        try { onError(err); } catch { /* onError must not break the loop */ }
      }
    } finally {
      scheduleNext();
    }
  }

  scheduleNext();

  return {
    stop() {
      stopped = true;
      if (handle) {
        clearTimeout(handle);
        handle = null;
      }
    },
  };
}
