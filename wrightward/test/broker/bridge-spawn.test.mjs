import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import {
  tryAcquireAndSpawn,
  heartbeatLock,
  shutdownOwnedBridge
} from '../../broker/bridge-spawn.mjs';
import {
  acquireLock,
  releaseLock,
  readLock,
  readCircuitBreaker,
  recordBridgeFailure,
  bridgeDir,
  lockPath,
  circuitPath,
  isProcessAlive
} from '../../broker/lifecycle.mjs';

const require = createRequire(import.meta.url);
const { ensureCollabDir } = require('../../lib/collab-dir');
const { atomicWriteJson } = require('../../lib/atomic-write');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_BRIDGE = path.resolve(__dirname, 'sleepy-bridge-fixture.mjs');
const FIXTURE_STDERR_BRIDGE = path.resolve(__dirname, 'stderr-bridge-fixture.mjs');
const FIXTURE_SELF_RECORDED_BRIDGE = path.resolve(__dirname, 'self-recorded-bridge-fixture.mjs');

function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 2000);
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() > deadline) return reject(new Error('waitFor timeout'));
      setTimeout(tick, 25);
    };
    tick();
  });
}

describe('broker/bridge-spawn', () => {
  let tmpDir, collabDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-spawn-'));
    collabDir = ensureCollabDir(tmpDir);
  });

  afterEach(async () => {
    // Ensure any spawned children are cleaned up before rmdir.
    const lock = readLock(collabDir);
    if (lock && lock.bridge_child_pid && isProcessAlive(lock.bridge_child_pid)) {
      try { process.kill(lock.bridge_child_pid, 'SIGTERM'); } catch (_) {}
      // Give it up to 1s to exit.
      for (let i = 0; i < 40 && isProcessAlive(lock.bridge_child_pid); i++) {
        await new Promise((r) => setTimeout(r, 25));
      }
    }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  });

  describe('early-return guards', () => {
    it('returns discord_disabled when discordEnabled is false', () => {
      const r = tryAcquireAndSpawn(collabDir, {
        sessionId: 'sess-a', discordEnabled: false, busEnabled: true,
        botToken: 'tok', entryOverride: FIXTURE_BRIDGE
      });
      assert.equal(r.running, false);
      assert.equal(r.reason, 'discord_disabled');
      assert.equal(readLock(collabDir), null, 'must not acquire lock');
    });

    it('returns bus_disabled when busEnabled is false', () => {
      const r = tryAcquireAndSpawn(collabDir, {
        sessionId: 'sess-a', discordEnabled: true, busEnabled: false,
        botToken: 'tok', entryOverride: FIXTURE_BRIDGE
      });
      assert.equal(r.reason, 'bus_disabled');
      assert.equal(readLock(collabDir), null);
    });

    it('returns no_token when botToken is missing', () => {
      const r = tryAcquireAndSpawn(collabDir, {
        sessionId: 'sess-a', discordEnabled: true, busEnabled: true,
        botToken: '', entryOverride: FIXTURE_BRIDGE
      });
      assert.equal(r.reason, 'no_token');
      assert.equal(readLock(collabDir), null);
    });
  });

  describe('circuit breaker', () => {
    it('refuses to spawn when circuit is open', () => {
      // Trip the breaker in the future.
      atomicWriteJson(circuitPath(collabDir), {
        disabled_until_ts: Date.now() + 60_000,
        last_error: 'test',
        consecutive_failures: 3
      });
      const r = tryAcquireAndSpawn(collabDir, {
        sessionId: 'sess-a', discordEnabled: true, busEnabled: true,
        botToken: 'tok', entryOverride: FIXTURE_BRIDGE
      });
      assert.equal(r.running, false);
      assert.equal(r.reason, 'circuit_open');
      assert.ok(r.circuit_breaker);
      assert.equal(readLock(collabDir), null);
    });

    it('proceeds when circuit has expired', () => {
      atomicWriteJson(circuitPath(collabDir), {
        disabled_until_ts: Date.now() - 1000,
        last_error: 'old',
        consecutive_failures: 1
      });
      const r = tryAcquireAndSpawn(collabDir, {
        sessionId: 'sess-a', discordEnabled: true, busEnabled: true,
        botToken: 'tok', entryOverride: FIXTURE_BRIDGE
      });
      assert.equal(r.reason, 'spawned');
      assert.equal(r.running, true);
    });
  });

  describe('lock contention', () => {
    it('returns owned_by_other when another live PID owns the lock', () => {
      fs.mkdirSync(bridgeDir(collabDir), { recursive: true });
      fs.writeFileSync(lockPath(collabDir), JSON.stringify({
        owner_pid: process.pid,       // current pid is, by definition, alive
        owner_session_id: 'other-sess',
        started_at: Date.now(),
        bridge_child_pid: null
      }));
      const r = tryAcquireAndSpawn(collabDir, {
        sessionId: 'sess-mine', discordEnabled: true, busEnabled: true,
        botToken: 'tok', entryOverride: FIXTURE_BRIDGE
      });
      assert.equal(r.reason, 'owned_by_other');
      assert.equal(r.owned, false);
    });

    it('reclaims a stale lock (owner pid dead) and spawns', () => {
      fs.mkdirSync(bridgeDir(collabDir), { recursive: true });
      fs.writeFileSync(lockPath(collabDir), JSON.stringify({
        owner_pid: 0,                 // definitely dead
        owner_session_id: 'ghost',
        started_at: 0,
        bridge_child_pid: null
      }));
      const r = tryAcquireAndSpawn(collabDir, {
        sessionId: 'sess-mine', discordEnabled: true, busEnabled: true,
        botToken: 'tok', entryOverride: FIXTURE_BRIDGE
      });
      assert.equal(r.reason, 'spawned');
      assert.equal(r.owned, true);
      assert.equal(readLock(collabDir).owner_pid, process.pid);
    });
  });

  describe('successful spawn', () => {
    it('spawns a child, records its pid in the lockfile, and stays alive', async () => {
      const r = tryAcquireAndSpawn(collabDir, {
        sessionId: 'sess-a', discordEnabled: true, busEnabled: true,
        botToken: 'tok', entryOverride: FIXTURE_BRIDGE
      });
      assert.equal(r.running, true);
      assert.equal(r.owned, true);
      assert.ok(r.childPid);
      assert.equal(readLock(collabDir).bridge_child_pid, r.childPid);
      // Child should be alive for at least a brief moment.
      assert.equal(isProcessAlive(r.childPid), true);
    });

    it('child exit releases the lock', async () => {
      const r = tryAcquireAndSpawn(collabDir, {
        sessionId: 'sess-a', discordEnabled: true, busEnabled: true,
        botToken: 'tok', entryOverride: FIXTURE_BRIDGE
      });
      assert.ok(r.child);
      r.child.kill('SIGTERM');
      await waitFor(() => !isProcessAlive(r.childPid), 3000);
      // Give the exit handler a moment to fire.
      await new Promise((res) => setTimeout(res, 100));
      assert.equal(readLock(collabDir), null, 'lock must be released on exit');
    });

    it('forwards child stderr into bridge.log (pre-appendLog failures no longer silent)', async () => {
      const r = tryAcquireAndSpawn(collabDir, {
        sessionId: 'sess-a', discordEnabled: true, busEnabled: true,
        botToken: 'tok', entryOverride: FIXTURE_STDERR_BRIDGE
      });
      assert.ok(r.childPid);
      // Wait for the child to exit (stderr fixture exits immediately).
      await waitFor(() => !isProcessAlive(r.childPid), 3000);
      // Allow the exit + 'data' event handlers to flush.
      await new Promise((res) => setTimeout(res, 150));
      const logContent = fs.readFileSync(
        path.join(collabDir, 'bridge', 'bridge.log'), 'utf8');
      assert.match(logContent, /simulated startup failure/,
        'child stderr must be captured into bridge.log');
    });

    it('fast-exit (<5s) records a circuit-breaker failure', async () => {
      const r = tryAcquireAndSpawn(collabDir, {
        sessionId: 'sess-a', discordEnabled: true, busEnabled: true,
        botToken: 'tok', entryOverride: FIXTURE_BRIDGE
      });
      r.child.kill('SIGKILL');
      await waitFor(() => !isProcessAlive(r.childPid), 3000);
      await new Promise((res) => setTimeout(res, 150));
      const cb = readCircuitBreaker(collabDir);
      assert.equal(cb.consecutive_failures >= 1, true,
        'SIGKILL fast-exit must increment consecutive_failures');
      assert.ok(cb.disabled_until_ts > Date.now(),
        'circuit breaker must be tripped after fast-exit');
    });

    it('does NOT record a second failure when child self-reports (exit code 2)', async () => {
      // Simulate the bridge having already written a 1h auth-failure breaker
      // before exiting. The parent's exit handler must NOT clobber it with
      // a shorter backoff computed from an incremented failure count.
      const oneHour = 60 * 60 * 1000;
      atomicWriteJson(
        path.join(collabDir, 'bridge', 'circuit-breaker.json'),
        { disabled_until_ts: Date.now() + oneHour, last_error: '401', consecutive_failures: 1 }
      );
      // Bump circuit breaker into "open" state first by tripping it manually
      // via recordBridgeFailure... but we already wrote it directly above.
      // Child will fast-exit with code 2. Parent must see that as
      // self-recorded and skip its own recordBridgeFailure.
      const before = readCircuitBreaker(collabDir);
      const r = tryAcquireAndSpawn(collabDir, {
        sessionId: 'sess-a', discordEnabled: true, busEnabled: true,
        botToken: 'tok', entryOverride: FIXTURE_SELF_RECORDED_BRIDGE
      });
      // Wait for exit + exit handler to run.
      await waitFor(() => !isProcessAlive(r.childPid), 3000);
      await new Promise((res) => setTimeout(res, 200));
      const after = readCircuitBreaker(collabDir);
      assert.equal(after.consecutive_failures, before.consecutive_failures,
        'consecutive_failures must NOT be incremented by parent when bridge self-reports');
      assert.equal(after.disabled_until_ts, before.disabled_until_ts,
        'disabled_until_ts must NOT be clobbered by parent when bridge self-reports');
    });
  });

  describe('heartbeatLock', () => {
    it('idle when we do not own the lock', () => {
      fs.mkdirSync(bridgeDir(collabDir), { recursive: true });
      fs.writeFileSync(lockPath(collabDir), JSON.stringify({
        owner_pid: process.pid + 999999,
        owner_session_id: 'other',
        started_at: 0,
        bridge_child_pid: 999999
      }));
      const r = heartbeatLock(collabDir, {});
      assert.equal(r.action, 'idle');
    });

    it('idle when we own the lock and child is alive', async () => {
      const spawn = tryAcquireAndSpawn(collabDir, {
        sessionId: 'sess-a', discordEnabled: true, busEnabled: true,
        botToken: 'tok', entryOverride: FIXTURE_BRIDGE
      });
      assert.equal(spawn.running, true);
      const r = heartbeatLock(collabDir, {
        discordEnabled: true, busEnabled: true,
        botToken: 'tok', entryOverride: FIXTURE_BRIDGE
      });
      assert.equal(r.action, 'idle');
      assert.equal(r.reason, 'child_alive');
    });

    it('respawns when owned-lock child is dead', () => {
      // Forge a lockfile owned by us but with a dead child pid so
      // heartbeat sees an orphaned owner slot and respawns. Avoids
      // tripping the circuit breaker via a real fast-exit.
      fs.mkdirSync(bridgeDir(collabDir), { recursive: true });
      fs.writeFileSync(lockPath(collabDir), JSON.stringify({
        owner_pid: process.pid,
        owner_session_id: 'sess-a',
        started_at: Date.now(),
        bridge_child_pid: 0
      }));
      const hb = heartbeatLock(collabDir, {
        sessionId: 'sess-a', discordEnabled: true, busEnabled: true,
        botToken: 'tok', entryOverride: FIXTURE_BRIDGE
      });
      assert.equal(hb.action, 'respawn');
      assert.ok(hb.result, 'respawn must return a result');
      assert.equal(hb.result.running, true);
      assert.equal(hb.result.owned, true);
    });
  });

  describe('shutdownOwnedBridge', () => {
    it('kills the child and releases the lock when we own it', async () => {
      const r = tryAcquireAndSpawn(collabDir, {
        sessionId: 'sess-a', discordEnabled: true, busEnabled: true,
        botToken: 'tok', entryOverride: FIXTURE_BRIDGE
      });
      assert.equal(r.running, true);
      shutdownOwnedBridge(collabDir, r.child);
      await waitFor(() => !isProcessAlive(r.childPid), 3000);
      assert.equal(readLock(collabDir), null);
    });

    it('no-op when we do not own the lock', () => {
      fs.mkdirSync(bridgeDir(collabDir), { recursive: true });
      fs.writeFileSync(lockPath(collabDir), JSON.stringify({
        owner_pid: process.pid + 999999,
        owner_session_id: 'other',
        started_at: 0,
        bridge_child_pid: 999999
      }));
      // Should not throw.
      assert.doesNotThrow(() => shutdownOwnedBridge(collabDir, null));
      // Lock remains.
      assert.ok(readLock(collabDir));
    });
  });
});
