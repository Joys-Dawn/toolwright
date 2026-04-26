import test from "node:test";
import assert from "node:assert/strict";
import { makeLimiter } from "../../lib/novelty/limiter.mjs";

// Returns { promise, resolve, reject } — a manually-controlled promise the
// test can settle to drive limiter scheduling deterministically. Avoids any
// dependence on setTimeout / wall-clock timing.
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test("limiter caps concurrency at max", async () => {
  const limit = makeLimiter(3);
  const gates = Array.from({ length: 20 }, () => deferred());
  let active = 0;
  let peak = 0;

  const tasks = gates.map((g) => limit(async () => {
    active++;
    peak = Math.max(peak, active);
    await g.promise;
    active--;
  }));

  // Yield enough microtask turns for the limiter to admit its first wave.
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.equal(peak, 3, "no more than 3 may run concurrently");

  // Drain everything, one at a time. Releasing a slot must let the next
  // queued task in — so peak stays at 3, never grows.
  for (const g of gates) g.resolve();
  await Promise.all(tasks);

  assert.equal(peak, 3);
  assert.equal(active, 0);
});

test("limiter runs all tasks to completion", async () => {
  const limit = makeLimiter(2);
  const order = [];
  const tasks = Array.from({ length: 10 }, (_, i) =>
    limit(async () => { order.push(i); return i; })
  );
  const results = await Promise.all(tasks);
  assert.deepEqual(results, [0,1,2,3,4,5,6,7,8,9]);
  assert.equal(order.length, 10);
});

test("limiter propagates task errors without stalling", async () => {
  const limit = makeLimiter(2);
  const outcomes = await Promise.allSettled([
    limit(async () => { throw new Error("boom"); }),
    limit(async () => "ok"),
    limit(async () => { throw new Error("kaboom"); }),
    limit(async () => "good")
  ]);
  assert.equal(outcomes[0].status, "rejected");
  assert.equal(outcomes[1].status, "fulfilled");
  assert.equal(outcomes[2].status, "rejected");
  assert.equal(outcomes[3].status, "fulfilled");
  assert.equal(outcomes[3].value, "good");
});

test("limiter with maxConcurrent=1 serializes execution", async () => {
  const limit = makeLimiter(1);
  const gates = Array.from({ length: 5 }, () => deferred());
  let active = 0;
  let peak = 0;

  const tasks = gates.map((g) => limit(async () => {
    active++;
    peak = Math.max(peak, active);
    await g.promise;
    active--;
  }));

  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.equal(peak, 1);

  for (const g of gates) g.resolve();
  await Promise.all(tasks);

  assert.equal(peak, 1);
});

test("limiter admits a queued task immediately when an active slot frees", async () => {
  const limit = makeLimiter(2);
  const a = deferred(), b = deferred(), c = deferred();
  let cStarted = false;

  const tA = limit(() => a.promise);
  const tB = limit(() => b.promise);
  const tC = limit(async () => { cStarted = true; await c.promise; });

  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.equal(cStarted, false, "third task must wait while two are active");

  a.resolve();
  await tA;
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.equal(cStarted, true, "third task starts as soon as a slot frees");

  b.resolve();
  c.resolve();
  await Promise.all([tB, tC]);
});
