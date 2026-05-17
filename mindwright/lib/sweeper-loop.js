// Self-rescheduling sweeper-tick scheduler (no production caller post-refactor;
// retained, exercised by test/sweeper-loop.test.js).
//
// setTimeout-chain, not setInterval: the next tick is armed only AFTER the
// current sweep resolves, so a long sweep can't overlap itself (concurrent
// vec_index writes / double-bumped embed_failures). `.stop()` is idempotent;
// errors route to `onError` and never propagate.

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
