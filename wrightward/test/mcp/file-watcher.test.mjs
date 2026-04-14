import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';

const { createWatcher } = await import('../../mcp/file-watcher.mjs');

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('mcp/file-watcher', () => {
  let tmpDir;
  let busPath;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watcher-'));
    busPath = path.join(tmpDir, 'bus.jsonl');
    fs.writeFileSync(busPath, '');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('fires onActivity after an append, within the polling window', async () => {
    let fires = 0;
    const watcher = createWatcher(busPath, () => { fires++; }, { debounceMs: 20, pollMs: 50 });
    watcher.start();
    // Wait past the initial mtime cache so the next write produces a change.
    await wait(60);
    fs.appendFileSync(busPath, '{"x":1}\n');
    await wait(500);
    assert.ok(fires >= 1, `expected at least 1 fire, got ${fires}`);
    watcher.close();
  });

  it('does not fire when mtime is unchanged between polls', async () => {
    let fires = 0;
    const watcher = createWatcher(busPath, () => { fires++; }, { debounceMs: 20, pollMs: 40 });
    watcher.start();
    await wait(300);
    // No writes → no fires. mtime cache prevents spurious work.
    assert.equal(fires, 0);
    watcher.close();
  });

  it('coalesces multiple rapid appends into at least one and fewer than the append count', async () => {
    let fires = 0;
    const watcher = createWatcher(busPath, () => { fires++; }, { debounceMs: 50, pollMs: 200 });
    watcher.start();
    await wait(60);
    for (let i = 0; i < 5; i++) {
      fs.appendFileSync(busPath, `{"i":${i}}\n`);
      await wait(5);
    }
    await wait(600);
    assert.ok(fires >= 1, 'expected at least one fire from burst');
    assert.ok(fires < 5, `debounce should collapse bursts, saw ${fires} fires for 5 rapid appends`);
    watcher.close();
  });

  it('polling fallback still fires when fs.watch is unavailable (stubbed)', async () => {
    // Simulate fs.watch throwing (e.g., network mount, unsupported fs).
    const realWatch = fs.watch;
    fs.watch = () => { throw new Error('unsupported'); };
    try {
      let fires = 0;
      const watcher = createWatcher(busPath, () => { fires++; }, { debounceMs: 10, pollMs: 40 });
      watcher.start();
      const state = watcher._state();
      assert.equal(state.hasWatcher, false, 'fs.watch threw — watcher should be null');
      assert.equal(state.hasPoll, true, 'polling fallback must still be installed');
      await wait(60);
      fs.appendFileSync(busPath, '{"y":1}\n');
      await wait(500);
      assert.ok(fires >= 1, `polling fallback should have fired, got ${fires}`);
      watcher.close();
    } finally {
      fs.watch = realWatch;
    }
  });

  it('close() disposes the watcher, polling interval, and any pending debounce timer', async () => {
    let fires = 0;
    const watcher = createWatcher(busPath, () => { fires++; }, { debounceMs: 200, pollMs: 50 });
    watcher.start();
    await wait(60);
    fs.appendFileSync(busPath, '{"z":1}\n');
    // Trigger a pending debounce, then close before it fires.
    await wait(20);
    watcher.close();
    const state = watcher._state();
    assert.equal(state.closed, true);
    assert.equal(state.hasPoll, false, 'polling interval must be cleared');
    assert.equal(state.hasWatcher, false, 'fs.watch handle must be released');
    assert.equal(state.hasDebounce, false, 'pending debounce timer must be cleared');
    // Give the would-have-fired window plenty of time.
    await wait(500);
    // Even if the timer fired, maybeFire() is a no-op after close (cachedMtimeMs
    // still updates from pre-close read, but onActivity is not called because
    // the debounced fire was cleared). Accept 0 or 1 fire pre-close, but no
    // new fires after the close sentinel.
    const firesAfterClose = fires;
    await wait(200);
    assert.equal(fires, firesAfterClose, 'no new fires must occur after close()');
  });

  it('does not throw when bus.jsonl is missing at start()', async () => {
    const missing = path.join(tmpDir, 'does-not-exist.jsonl');
    const watcher = createWatcher(missing, () => {}, { debounceMs: 10, pollMs: 40 });
    // fs.watch on a missing file throws synchronously — start() must swallow it
    // and keep polling, since the file may be created later.
    assert.doesNotThrow(() => watcher.start());
    await wait(100);
    watcher.close();
  });

  it('fires after the file is created post-start (polling discovers it)', async () => {
    const later = path.join(tmpDir, 'later.jsonl');
    let fires = 0;
    const watcher = createWatcher(later, () => { fires++; }, { debounceMs: 10, pollMs: 40 });
    watcher.start();
    await wait(100);
    fs.writeFileSync(later, '{"first":1}\n');
    await wait(500);
    assert.ok(fires >= 1, `expected at least 1 fire after file creation, got ${fires}`);
    watcher.close();
  });

  it('start() throws if called after close()', () => {
    const watcher = createWatcher(busPath, () => {}, { debounceMs: 10, pollMs: 40 });
    watcher.close();
    assert.throws(() => watcher.start(), /closed/);
  });

  it('stays alive and keeps firing when onActivity throws', async () => {
    // Defensive boundary: a buggy callback must not crash the watcher or the
    // MCP server's event loop. After a throw, subsequent appends must still
    // produce fires — the watcher cannot enter a wedged state.
    let calls = 0;
    const watcher = createWatcher(busPath, () => {
      calls++;
      if (calls === 1) throw new Error('boom');
    }, { debounceMs: 20, pollMs: 50 });
    watcher.start();
    await wait(60);
    fs.appendFileSync(busPath, '{"first":1}\n');
    await wait(500);
    assert.ok(calls >= 1, 'first (throwing) call should have happened');

    // Force a distinct mtime so the cache definitely sees a change.
    await wait(30);
    fs.appendFileSync(busPath, '{"second":2}\n');
    await wait(500);
    assert.ok(calls >= 2, 'watcher must keep firing after onActivity throws, calls=' + calls);
    watcher.close();
  });
});
