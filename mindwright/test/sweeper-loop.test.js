// Regression for best-practices-1: the deferred-embed sweeper used to run
// on a setInterval, which fires the next tick on schedule regardless of
// whether the previous sweepOnce is still in flight. With a poison-heavy
// batch the per-text fallback inside sweepOnce can run for many seconds,
// so two ticks would overlap and write to vec_index simultaneously,
// double-bumping embed_failures counters. The fix is a self-rescheduling
// setTimeout chain in lib/sweeper-loop.js that only arms the next tick
// AFTER the current sweep resolves.
//
// Tests use node:test MockTimers so we exercise the setTimeout chain
// deterministically — no wall-clock sleeps, no CI-load flake risk.
// `delay` is imported INSIDE each test after enabling mock timers so the
// captured reference points at the mocked setTimeout, not the real one
// (a module-level import would freeze in the real timer at load time).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startSweeperLoop } from '../lib/sweeper-loop.js';

// Drains the microtask queue between mocked timer ticks so async sweep
// bodies progress to their next await before we advance the clock again.
// 20 is empirically enough for the promise-chain depth of one self-
// rescheduling cycle (sweep body + tick's finally + scheduleNext).
async function drainMicrotasks() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

test('startSweeperLoop never runs two ticks concurrently even when sweep is slow', async (t) => {
  // intervalMs=30 is shorter than the slow-sweep duration of 80 — a
  // setInterval would absolutely overlap them. Self-rescheduling must not.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { setTimeout: delay } = await import('node:timers/promises');

  let concurrent = 0;
  let maxConcurrent = 0;
  let invocations = 0;

  const loop = startSweeperLoop({
    sweep: async () => {
      invocations += 1;
      concurrent += 1;
      if (concurrent > maxConcurrent) maxConcurrent = concurrent;
      await delay(80);
      concurrent -= 1;
    },
    intervalMs: 30,
  });

  // Drive 4 cycles. Each cycle: tick(intervalMs) fires the outer timer →
  // sweep enters → drain microtasks → tick(80) releases the inner delay →
  // drain microtasks → outer setTimeout is armed again in `finally`.
  for (let i = 0; i < 4; i++) {
    t.mock.timers.tick(30);
    await drainMicrotasks();
    t.mock.timers.tick(80);
    await drainMicrotasks();
  }

  loop.stop();

  assert.equal(maxConcurrent, 1,
    `concurrent ticks observed (${maxConcurrent}); the self-rescheduling chain must serialize them`);
  assert.equal(invocations, 4, `expected exactly 4 invocations under mocked timers; got ${invocations}`);
});

test('startSweeperLoop swallows errors from sweep and keeps running', async (t) => {
  // A single bad sweep must not wedge the loop forever — that was the
  // setInterval pattern's only redeeming feature, so the replacement must
  // preserve it.
  t.mock.timers.enable({ apis: ['setTimeout'] });

  let invocations = 0;
  let errorsSeen = 0;
  const loop = startSweeperLoop({
    sweep: async () => {
      invocations += 1;
      if (invocations === 1) throw new Error('boom');
    },
    intervalMs: 20,
    onError: () => { errorsSeen += 1; },
  });

  // Tick three cycles: first throws, second and third are no-ops.
  for (let i = 0; i < 3; i++) {
    t.mock.timers.tick(20);
    await drainMicrotasks();
  }
  loop.stop();

  assert.equal(invocations, 3, `expected loop to keep ticking after error; got ${invocations}`);
  assert.equal(errorsSeen, 1, 'onError must fire exactly once for the one failing sweep');
});

test('startSweeperLoop.stop() is idempotent and prevents future ticks', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });

  let invocations = 0;
  const loop = startSweeperLoop({
    sweep: async () => { invocations += 1; },
    intervalMs: 20,
  });

  // Two ticks before stop.
  for (let i = 0; i < 2; i++) {
    t.mock.timers.tick(20);
    await drainMicrotasks();
  }
  const countAtStop = invocations;
  loop.stop();
  loop.stop(); // second stop must not crash

  // Advance well past any future would-have-been ticks. No callbacks fire.
  t.mock.timers.tick(500);
  await drainMicrotasks();

  assert.equal(invocations, countAtStop,
    `stop() must prevent further invocations; before=${countAtStop} after=${invocations}`);
});

test('startSweeperLoop rejects bad input', () => {
  // TypeError for the function-shape check, RangeError for the numeric
  // range check — programmatically distinguishable per Node convention.
  assert.throws(() => startSweeperLoop({ sweep: 'not a fn', intervalMs: 100 }),
    (err) => err instanceof TypeError && /sweep must be a function/.test(err.message));
  assert.throws(() => startSweeperLoop({ sweep: () => {}, intervalMs: 0 }),
    (err) => err instanceof RangeError && /intervalMs must be a positive finite number/.test(err.message));
  assert.throws(() => startSweeperLoop({ sweep: () => {}, intervalMs: -1 }),
    (err) => err instanceof RangeError && /intervalMs must be a positive finite number/.test(err.message));
});
