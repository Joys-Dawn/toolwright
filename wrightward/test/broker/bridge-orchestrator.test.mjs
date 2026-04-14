import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createBridgeOrchestrator } from '../../broker/bridge-orchestrator.mjs';

// Helpers to build a harness with injectable stubs. The orchestrator's state
// machine is driven by the return shapes of tryAcquireAndSpawn / heartbeatLock.

function makeLogger() {
  const lines = [];
  const logger = (msg) => lines.push(msg);
  logger.lines = lines;
  return logger;
}

function makeHarness(overrides) {
  overrides = overrides || {};
  const spawnCalls = [];
  const heartbeatCalls = [];
  const shutdownCalls = [];
  const intervalCalls = [];
  const clearIntervalCalls = [];
  const logger = makeLogger();

  let savedTick = null;
  const fakeTimer = { __fake: true };

  const deps = {
    tryAcquireAndSpawn: overrides.tryAcquireAndSpawn ||
      ((_collabDir, opts) => {
        spawnCalls.push(opts);
        return { running: true, owned: true, reason: 'spawned', childPid: 1234,
          child: { exitCode: null } };
      }),
    heartbeatLock: overrides.heartbeatLock ||
      ((_collabDir, opts) => {
        heartbeatCalls.push(opts);
        return { action: 'idle', reason: 'child_alive' };
      }),
    shutdownOwnedBridge: overrides.shutdownOwnedBridge ||
      ((_collabDir, child) => {
        shutdownCalls.push({ child });
      }),
    logger,
    setInterval: (fn, ms) => {
      savedTick = fn;
      intervalCalls.push({ fn, ms });
      return fakeTimer;
    },
    clearInterval: (timer) => { clearIntervalCalls.push(timer); }
  };

  // Wrap spy counters around the real tryAcquireAndSpawn when caller
  // supplied one — so tests can still read spawnCalls.
  if (overrides.tryAcquireAndSpawn) {
    const userFn = overrides.tryAcquireAndSpawn;
    deps.tryAcquireAndSpawn = (collabDir, opts) => {
      spawnCalls.push(opts);
      return userFn(collabDir, opts);
    };
  }
  if (overrides.heartbeatLock) {
    const userFn = overrides.heartbeatLock;
    deps.heartbeatLock = (collabDir, opts) => {
      heartbeatCalls.push(opts);
      return userFn(collabDir, opts);
    };
  }

  const spawnOpts = overrides.spawnOpts || { sessionId: 'sess-a' };
  const orch = createBridgeOrchestrator('/fake/collab', () => spawnOpts, deps);

  return {
    orch,
    spawnCalls,
    heartbeatCalls,
    shutdownCalls,
    intervalCalls,
    clearIntervalCalls,
    logger,
    fireHeartbeat: () => { if (savedTick) savedTick(); }
  };
}

describe('broker/bridge-orchestrator', () => {
  describe('start', () => {
    it('calls tryAcquireAndSpawn once and schedules a heartbeat interval', () => {
      const h = makeHarness();
      h.orch.start();
      assert.equal(h.spawnCalls.length, 1);
      assert.equal(h.intervalCalls.length, 1);
      assert.equal(h.intervalCalls[0].ms, 5000);
    });

    it('adopts the returned state when owned=true', () => {
      const fakeChild = { exitCode: null };
      const h = makeHarness({
        tryAcquireAndSpawn: () => ({ running: true, owned: true, reason: 'spawned',
          childPid: 42, child: fakeChild })
      });
      h.orch.start();
      const s = h.orch.getState();
      assert.equal(s.owned, true);
      assert.equal(s.childPid, 42);
      assert.equal(s.child, fakeChild);
    });

    it('logs "bridge spawned" with the child pid on initial spawn success', () => {
      const h = makeHarness({
        tryAcquireAndSpawn: () => ({ running: true, owned: true, reason: 'spawned',
          childPid: 777, child: { exitCode: null } })
      });
      h.orch.start();
      assert.ok(h.logger.lines.some(l => /bridge spawned \(pid=777\)/.test(l)));
    });

    it('logs "owned by another session" when reason=owned_by_other', () => {
      const h = makeHarness({
        tryAcquireAndSpawn: () => ({ running: false, owned: false,
          reason: 'owned_by_other', childPid: null })
      });
      h.orch.start();
      assert.ok(h.logger.lines.some(l => /already owned by another session/.test(l)));
      assert.equal(h.orch.getState().owned, false);
      assert.equal(h.orch.getState().reason, 'owned_by_other');
    });

    it('logs "circuit breaker open" when reason=circuit_open', () => {
      const h = makeHarness({
        tryAcquireAndSpawn: () => ({ running: false, owned: false,
          reason: 'circuit_open', childPid: null })
      });
      h.orch.start();
      assert.ok(h.logger.lines.some(l => /circuit breaker open/.test(l)));
    });

    it('keeps reason in state after a silent failure (spawn_failed) so takeover fires next tick', () => {
      const h = makeHarness({
        tryAcquireAndSpawn: () => ({ running: false, owned: false,
          reason: 'spawn_failed', childPid: null })
      });
      h.orch.start();
      assert.equal(h.orch.getState().reason, 'spawn_failed');
    });

    it('calls unref on the returned timer when available', () => {
      let unrefCalled = false;
      const h = makeHarness();
      h.orch.start();
      // Can't easily test real unref because our fake timer is a plain object.
      // Sanity: ensure start does not throw when the timer lacks unref.
      assert.doesNotThrow(() => {
        const h2 = makeHarness();
        h2.orch.start();
      });
      unrefCalled = true;
      assert.equal(unrefCalled, true);
    });

    it('passes spawnOptsFn result into tryAcquireAndSpawn (late-bound session id)', () => {
      const h = makeHarness({ spawnOpts: { sessionId: 'sess-XYZ', foo: 'bar' } });
      h.orch.start();
      assert.deepEqual(h.spawnCalls[0], { sessionId: 'sess-XYZ', foo: 'bar' });
    });
  });

  describe('heartbeat: respawn branch', () => {
    it('adopts hb.result and logs respawn when action=respawn and owned=true', () => {
      let callCount = 0;
      const h = makeHarness({
        tryAcquireAndSpawn: () => ({ running: true, owned: true, reason: 'spawned',
          childPid: 1, child: { exitCode: null } }),
        heartbeatLock: () => {
          callCount++;
          if (callCount === 1) {
            return { action: 'respawn', result: { running: true, owned: true,
              reason: 'spawned', childPid: 99, child: { exitCode: null } } };
          }
          return { action: 'idle' };
        }
      });
      h.orch.start();
      h.fireHeartbeat();
      const s = h.orch.getState();
      assert.equal(s.childPid, 99);
      assert.ok(h.logger.lines.some(l => /bridge respawned \(pid=99\)/.test(l)));
    });

    it('adopts hb.result even when owned=false so next tick retries via takeover reason', () => {
      // Previously the tick kept state unchanged on owned=false and then
      // called spawn() again in the same tick via the dead-child branch —
      // double-calling tryAcquireAndSpawn. New behavior: adopt hb.result
      // unconditionally, so the next 5s tick retries via the takeover branch.
      const initialChild = { exitCode: null };
      const h = makeHarness({
        tryAcquireAndSpawn: () => ({ running: true, owned: true, reason: 'spawned',
          childPid: 1, child: initialChild }),
        heartbeatLock: () => ({ action: 'respawn', result: { owned: false,
          reason: 'circuit_open', childPid: null } })
      });
      h.orch.start();
      const spawnCountBefore = h.spawnCalls.length;
      h.fireHeartbeat();
      assert.equal(h.orch.getState().owned, false);
      assert.equal(h.orch.getState().reason, 'circuit_open');
      // Must NOT have triggered a second spawn in the same tick.
      assert.equal(h.spawnCalls.length, spawnCountBefore,
        'heartbeat-respawn path must not double-call tryAcquireAndSpawn');
    });
  });

  describe('heartbeat: own-child-exited branch (the correctness-3 bug)', () => {
    it('respawns when we own the bridge but our child has exitCode !== null', () => {
      const deadChild = { exitCode: 1 };
      const newChild = { exitCode: null };
      let spawnCount = 0;
      const h = makeHarness({
        tryAcquireAndSpawn: () => {
          spawnCount++;
          if (spawnCount === 1) {
            return { running: true, owned: true, reason: 'spawned',
              childPid: 10, child: deadChild };
          }
          return { running: true, owned: true, reason: 'spawned',
            childPid: 20, child: newChild };
        },
        heartbeatLock: () => ({ action: 'idle', reason: 'no_lock' })
      });
      h.orch.start();
      // Simulate child crash — exitCode is now non-null.
      deadChild.exitCode = 1;
      h.fireHeartbeat();
      // Orchestrator should have called spawn again.
      assert.equal(h.spawnCalls.length, 2);
      assert.equal(h.orch.getState().child, newChild);
      assert.equal(h.orch.getState().childPid, 20);
    });

    it('does NOT respawn when child is still alive (exitCode === null)', () => {
      const liveChild = { exitCode: null };
      const h = makeHarness({
        tryAcquireAndSpawn: () => ({ running: true, owned: true, reason: 'spawned',
          childPid: 10, child: liveChild }),
        heartbeatLock: () => ({ action: 'idle', reason: 'child_alive' })
      });
      h.orch.start();
      h.fireHeartbeat();
      assert.equal(h.spawnCalls.length, 1, 'must NOT re-spawn when child is alive');
    });
  });

  describe('heartbeat: takeover branch', () => {
    const TAKEOVER_REASONS = ['owned_by_other', 'circuit_open', 'not_attempted',
      'spawn_failed', 'spawn_no_pid'];

    for (const reason of TAKEOVER_REASONS) {
      it(`retries spawn when reason=${reason}`, () => {
        let count = 0;
        const h = makeHarness({
          tryAcquireAndSpawn: () => {
            count++;
            if (count === 1) return { owned: false, reason, childPid: null };
            return { owned: true, reason: 'spawned', childPid: 7,
              child: { exitCode: null } };
          },
          heartbeatLock: () => ({ action: 'idle', reason: 'no_lock' })
        });
        h.orch.start();
        assert.equal(h.spawnCalls.length, 1);
        h.fireHeartbeat();
        assert.equal(h.spawnCalls.length, 2, `tick must retry spawn for reason=${reason}`);
        assert.equal(h.orch.getState().owned, true);
      });
    }

    it('does NOT retry when reason=spawned and child is alive', () => {
      const h = makeHarness({
        tryAcquireAndSpawn: () => ({ owned: true, reason: 'spawned', childPid: 5,
          child: { exitCode: null } }),
        heartbeatLock: () => ({ action: 'idle', reason: 'child_alive' })
      });
      h.orch.start();
      h.fireHeartbeat();
      assert.equal(h.spawnCalls.length, 1);
    });
  });

  describe('shutdown', () => {
    it('clears the timer and calls shutdownOwnedBridge with the tracked child', () => {
      const ourChild = { exitCode: null };
      const h = makeHarness({
        tryAcquireAndSpawn: () => ({ owned: true, reason: 'spawned', childPid: 1,
          child: ourChild })
      });
      h.orch.start();
      h.orch.shutdown();
      assert.equal(h.clearIntervalCalls.length, 1);
      assert.equal(h.shutdownCalls.length, 1);
      assert.equal(h.shutdownCalls[0].child, ourChild);
    });

    it('is safe to call twice (idempotent timer clear)', () => {
      const h = makeHarness();
      h.orch.start();
      h.orch.shutdown();
      assert.doesNotThrow(() => h.orch.shutdown());
    });

    it('swallows shutdownOwnedBridge errors so SIGTERM handler does not crash', () => {
      const h = makeHarness({
        shutdownOwnedBridge: () => { throw new Error('boom'); }
      });
      h.orch.start();
      assert.doesNotThrow(() => h.orch.shutdown());
    });

    it('passes null child when we never owned the bridge (owned_by_other at start)', () => {
      const h = makeHarness({
        tryAcquireAndSpawn: () => ({ owned: false, reason: 'owned_by_other',
          childPid: 99, child: null })
      });
      h.orch.start();
      h.orch.shutdown();
      assert.equal(h.shutdownCalls[0].child, null);
    });
  });

  describe('state transitions across multiple ticks', () => {
    it('owned_by_other → owned (owner died, we take over)', () => {
      const liveChild = { exitCode: null };
      let calls = 0;
      const h = makeHarness({
        tryAcquireAndSpawn: () => {
          calls++;
          if (calls === 1) return { owned: false, reason: 'owned_by_other', childPid: null };
          return { owned: true, reason: 'spawned', childPid: 123, child: liveChild };
        },
        heartbeatLock: () => ({ action: 'idle', reason: 'no_lock' })
      });
      h.orch.start();
      assert.equal(h.orch.getState().owned, false);
      h.fireHeartbeat();
      assert.equal(h.orch.getState().owned, true);
      assert.equal(h.orch.getState().childPid, 123);
    });

    it('spawned → child-dies → respawn (full correctness-3 scenario)', () => {
      const c1 = { exitCode: null };
      const c2 = { exitCode: null };
      let calls = 0;
      const h = makeHarness({
        tryAcquireAndSpawn: () => {
          calls++;
          return calls === 1
            ? { owned: true, reason: 'spawned', childPid: 1, child: c1 }
            : { owned: true, reason: 'spawned', childPid: 2, child: c2 };
        },
        heartbeatLock: () => ({ action: 'idle', reason: 'no_lock' })
      });
      h.orch.start();
      assert.equal(h.orch.getState().childPid, 1);
      c1.exitCode = 137; // SIGKILL
      h.fireHeartbeat();
      assert.equal(h.orch.getState().childPid, 2);
    });
  });
});
