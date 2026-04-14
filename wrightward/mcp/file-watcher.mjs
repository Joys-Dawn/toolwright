/**
 * File watcher for `bus.jsonl` — Phase 2 doorbell trigger.
 *
 * Fires `onActivity()` (no args) when bus.jsonl's mtime changes. The callback
 * is expected to re-read the current session ID from the binder and dispatch
 * to the channel-doorbell — this module holds no session state.
 *
 * Combines `fs.watch` (immediate notification on supported filesystems) with
 * an unconditional 1s `setInterval` polling fallback. On Windows `fs.watch`
 * is known flaky (missed events, inconsistent payloads), so polling is NOT
 * a fallback — it always runs.
 *
 * mtime-gated: before firing `onActivity`, `statSync(bus.jsonl).mtimeMs` is
 * compared against the cached value. No mtime change → no callback. This
 * keeps idle-session CPU at zero and avoids phantom doorbell rings.
 *
 * 50ms debounce coalesces bursts of fs.watch fires (which Windows often emits
 * multiple times per append).
 */

import fs from 'fs';

const DEFAULT_DEBOUNCE_MS = 50;
const DEFAULT_POLL_MS = 1000;

export function createWatcher(busPath, onActivity, opts = {}) {
  const debounceMs = opts.debounceMs != null ? opts.debounceMs : DEFAULT_DEBOUNCE_MS;
  const pollMs = opts.pollMs != null ? opts.pollMs : DEFAULT_POLL_MS;

  let cachedMtimeMs = readMtime(busPath);
  let debounceTimer = null;
  let pollInterval = null;
  let watcher = null;
  let closed = false;

  function readMtime(p) {
    try {
      return fs.statSync(p).mtimeMs;
    } catch (_) {
      // Missing file is fine — first append creates it and the next tick fires.
      return null;
    }
  }

  function maybeFire() {
    if (closed) return;
    const mtimeMs = readMtime(busPath);
    if (mtimeMs === null) return;
    if (cachedMtimeMs !== null && mtimeMs === cachedMtimeMs) return;
    cachedMtimeMs = mtimeMs;
    try {
      onActivity();
    } catch (err) {
      process.stderr.write('[wrightward-mcp] file-watcher onActivity threw: ' + (err.message || err) + '\n');
    }
  }

  function scheduleFire() {
    if (closed) return;
    if (debounceTimer !== null) return;
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      maybeFire();
    }, debounceMs);
    debounceTimer.unref();
  }

  function start() {
    if (closed) throw new Error('file-watcher closed');
    try {
      watcher = fs.watch(busPath, () => scheduleFire());
      watcher.on('error', (err) => {
        process.stderr.write('[wrightward-mcp] fs.watch error: ' + (err.message || err) + '\n');
      });
    } catch (_) {
      // Some filesystems (network mounts, old Linux kernels, missing file on
      // some platforms) don't support fs.watch. Polling alone is sufficient.
      watcher = null;
    }

    pollInterval = setInterval(() => scheduleFire(), pollMs);
    pollInterval.unref();
  }

  function close() {
    closed = true;
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    if (pollInterval !== null) {
      clearInterval(pollInterval);
      pollInterval = null;
    }
    if (watcher !== null) {
      try { watcher.close(); } catch (_) {}
      watcher = null;
    }
  }

  return {
    start,
    close,
    // Exposed for tests.
    _state: () => ({
      cachedMtimeMs,
      hasDebounce: debounceTimer !== null,
      hasPoll: pollInterval !== null,
      hasWatcher: watcher !== null,
      closed
    })
  };
}
