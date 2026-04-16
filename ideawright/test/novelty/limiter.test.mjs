import test from "node:test";
import assert from "node:assert/strict";
import { makeLimiter } from "../../lib/novelty/limiter.mjs";

test("limiter caps concurrency at max", async () => {
  const limit = makeLimiter(3);
  let active = 0;
  let peak = 0;
  const task = async () => {
    active++;
    peak = Math.max(peak, active);
    await new Promise(r => setTimeout(r, 5));
    active--;
  };
  await Promise.all(Array.from({ length: 20 }, () => limit(task)));
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
  let active = 0;
  let peak = 0;
  const task = async () => {
    active++;
    peak = Math.max(peak, active);
    await new Promise(r => setTimeout(r, 2));
    active--;
  };
  await Promise.all(Array.from({ length: 5 }, () => limit(task)));
  assert.equal(peak, 1);
});
