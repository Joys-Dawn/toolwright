import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import {
  acquireLock,
  releaseLock,
  readLock,
  updateChildPid,
  isProcessAlive,
  appendLog,
  maybeRotateLog,
  logPath,
  lockPath,
  bridgeDir,
  circuitPath,
  readCircuitBreaker,
  recordBridgeFailure,
  recordBridgeSuccess,
  isCircuitOpen,
  LOG_ROTATE_BYTES,
  LOG_KEEP_COUNT,
  BACKOFF_SCHEDULE_MS,
  AUTH_FAIL_BACKOFF_MS
} from '../../broker/lifecycle.mjs';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { ensureCollabDir } = require('../../lib/collab-dir');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('broker/lifecycle', () => {
  let tmpDir, collabDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-life-'));
    collabDir = ensureCollabDir(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('isProcessAlive', () => {
    it('returns true for the current process', () => {
      assert.equal(isProcessAlive(process.pid), true);
    });

    it('returns false for a PID that is certainly dead', () => {
      // PID 999999 is well outside the Linux/Windows typical range during test.
      // On Windows the upper pid range is ~4B but 999999 is also unlikely.
      // isProcessAlive must return false (ESRCH) — NOT fall through to "alive".
      // We also guard 0 and negative just in case.
      // (A flake-proof dead pid is hard; fall back to a never-valid value.)
      assert.equal(isProcessAlive(0), false);
      assert.equal(isProcessAlive(-1), false);
    });

    it('treats EPERM as alive (Windows quirk)', () => {
      // Monkeypatch process.kill to throw EPERM — verifies the Windows
      // behavior where signal 0 can throw on protected processes. The helper
      // MUST return true to avoid false-dead locks → duplicate bridges.
      const orig = process.kill;
      process.kill = () => { const e = new Error('perm'); e.code = 'EPERM'; throw e; };
      try {
        assert.equal(isProcessAlive(12345), true);
      } finally {
        process.kill = orig;
      }
    });

    it('treats ESRCH as dead', () => {
      const orig = process.kill;
      process.kill = () => { const e = new Error('no such'); e.code = 'ESRCH'; throw e; };
      try {
        assert.equal(isProcessAlive(12345), false);
      } finally {
        process.kill = orig;
      }
    });

    it('handles invalid pids safely', () => {
      assert.equal(isProcessAlive(NaN), false);
      assert.equal(isProcessAlive(null), false);
      assert.equal(isProcessAlive(undefined), false);
      assert.equal(isProcessAlive('abc'), false);
    });
  });

  describe('lock acquire/release', () => {
    it('acquires a fresh lock', () => {
      const r = acquireLock(collabDir, { sessionId: 'sess-a' });
      assert.equal(r.acquired, true);
      assert.equal(r.lock.owner_pid, process.pid);
      assert.equal(r.lock.owner_session_id, 'sess-a');
    });

    it('persists the lockfile with owner pid + session + started_at', () => {
      acquireLock(collabDir, { sessionId: 'sess-a' });
      const saved = readLock(collabDir);
      assert.equal(saved.owner_pid, process.pid);
      assert.equal(saved.owner_session_id, 'sess-a');
      assert.ok(saved.started_at > 0);
    });

    it('second acquire in same process is refused when alive', () => {
      acquireLock(collabDir, { sessionId: 'sess-a' });
      const r = acquireLock(collabDir, { sessionId: 'sess-b' });
      assert.equal(r.acquired, false);
      assert.equal(r.lock.owner_pid, process.pid);
    });

    it('reclaims a stale lock (owner pid dead)', () => {
      // Write a lockfile with a clearly-dead pid.
      fs.mkdirSync(bridgeDir(collabDir), { recursive: true });
      fs.writeFileSync(path.join(bridgeDir(collabDir), 'bridge.lock'),
        JSON.stringify({ owner_pid: 0, owner_session_id: 'ghost', started_at: 0 }));
      const r = acquireLock(collabDir, { sessionId: 'sess-alive' });
      assert.equal(r.acquired, true);
      assert.equal(r.stale_reclaimed, true);
      assert.equal(readLock(collabDir).owner_pid, process.pid);
    });

    it('refuses to reclaim when owner is dead but bridge_child_pid is still alive', () => {
      // Owner_pid is dead (0) but bridge_child_pid points at a live PID (us).
      // This simulates the parent-exits-before-child-drains race: a new
      // MCP must NOT acquire the lock while the prior child is still mirroring.
      fs.mkdirSync(bridgeDir(collabDir), { recursive: true });
      fs.writeFileSync(path.join(bridgeDir(collabDir), 'bridge.lock'),
        JSON.stringify({
          owner_pid: 0,
          owner_session_id: 'departed',
          started_at: 0,
          bridge_child_pid: process.pid
        }));
      const r = acquireLock(collabDir, { sessionId: 'new-mcp' });
      assert.equal(r.acquired, false);
      assert.equal(r.lock.bridge_child_pid, process.pid,
        'existing lock with live ghost child is preserved');
    });

    it('reclaims when both owner and bridge_child_pid are dead', () => {
      fs.mkdirSync(bridgeDir(collabDir), { recursive: true });
      fs.writeFileSync(path.join(bridgeDir(collabDir), 'bridge.lock'),
        JSON.stringify({
          owner_pid: 0,
          owner_session_id: 'gone',
          started_at: 0,
          bridge_child_pid: 0 // both dead
        }));
      const r = acquireLock(collabDir, { sessionId: 'new-mcp' });
      assert.equal(r.acquired, true);
      assert.equal(r.stale_reclaimed, true);
    });

    it('reclaims when owner is dead and bridge_child_pid is null/missing (old lock format)', () => {
      fs.mkdirSync(bridgeDir(collabDir), { recursive: true });
      fs.writeFileSync(path.join(bridgeDir(collabDir), 'bridge.lock'),
        JSON.stringify({ owner_pid: 0, owner_session_id: 'legacy', started_at: 0 }));
      const r = acquireLock(collabDir, { sessionId: 'new-mcp' });
      assert.equal(r.acquired, true);
      assert.equal(r.stale_reclaimed, true);
    });

    it('does NOT steal a lock owned by a live PID', () => {
      // Write a lockfile with this process' pid → isProcessAlive returns true.
      fs.mkdirSync(bridgeDir(collabDir), { recursive: true });
      fs.writeFileSync(path.join(bridgeDir(collabDir), 'bridge.lock'),
        JSON.stringify({ owner_pid: process.pid, owner_session_id: 'owner', started_at: Date.now() }));
      const r = acquireLock(collabDir, { sessionId: 'thief' });
      assert.equal(r.acquired, false);
      assert.equal(r.lock.owner_session_id, 'owner');
    });

    it('releaseLock unlinks the lockfile when we own it', () => {
      acquireLock(collabDir, { sessionId: 'sess-a' });
      assert.equal(releaseLock(collabDir), true);
      assert.equal(readLock(collabDir), null);
    });

    it('releaseLock refuses to unlink a lock we do not own', () => {
      fs.mkdirSync(bridgeDir(collabDir), { recursive: true });
      fs.writeFileSync(path.join(bridgeDir(collabDir), 'bridge.lock'),
        JSON.stringify({ owner_pid: process.pid + 999999, owner_session_id: 'other', started_at: 0 }));
      assert.equal(releaseLock(collabDir), false);
      assert.ok(readLock(collabDir), 'lock must still exist');
    });

    it('releaseLock with expectedChildPid refuses when child PID does not match', () => {
      // Simulates the race: old child's exit handler fires after a heartbeat
      // has already re-acquired the lock for a NEW child with a different PID.
      // The old handler must NOT unlink the fresh lock.
      acquireLock(collabDir, { sessionId: 'sess-a' });
      updateChildPid(collabDir, 12345);
      // Old child thinks its PID was 999 — must not steal the 12345 lock.
      assert.equal(releaseLock(collabDir, 999), false);
      assert.ok(readLock(collabDir), 'fresh lock must still exist');
    });

    it('releaseLock with expectedChildPid succeeds when child PID matches', () => {
      acquireLock(collabDir, { sessionId: 'sess-a' });
      updateChildPid(collabDir, 12345);
      assert.equal(releaseLock(collabDir, 12345), true);
      assert.equal(readLock(collabDir), null);
    });

    it('updateChildPid writes when we own the lock', () => {
      acquireLock(collabDir, { sessionId: 'sess-a' });
      assert.equal(updateChildPid(collabDir, 12345), true);
      assert.equal(readLock(collabDir).bridge_child_pid, 12345);
    });

    it('updateChildPid refuses when we do not own the lock', () => {
      fs.mkdirSync(bridgeDir(collabDir), { recursive: true });
      fs.writeFileSync(path.join(bridgeDir(collabDir), 'bridge.lock'),
        JSON.stringify({ owner_pid: process.pid + 999999, owner_session_id: 'other', started_at: 0 }));
      assert.equal(updateChildPid(collabDir, 999), false);
    });
  });

  describe('log rotation', () => {
    it('creates the log file on first append', () => {
      appendLog(collabDir, 'line1');
      assert.ok(fs.existsSync(logPath(collabDir)));
      assert.match(fs.readFileSync(logPath(collabDir), 'utf8'), /line1/);
    });

    it('appends multiple lines', () => {
      appendLog(collabDir, 'first');
      appendLog(collabDir, 'second');
      const content = fs.readFileSync(logPath(collabDir), 'utf8');
      assert.match(content, /first/);
      assert.match(content, /second/);
    });

    it('adds a trailing newline if missing', () => {
      appendLog(collabDir, 'no-nl');
      const content = fs.readFileSync(logPath(collabDir), 'utf8');
      assert.ok(content.endsWith('\n'));
    });

    it('rotates at LOG_ROTATE_BYTES (1 MB)', () => {
      // Write a big blob directly, then trigger the rotation check.
      fs.mkdirSync(bridgeDir(collabDir), { recursive: true });
      fs.writeFileSync(logPath(collabDir), 'x'.repeat(LOG_ROTATE_BYTES + 10));
      maybeRotateLog(collabDir);
      assert.ok(fs.existsSync(logPath(collabDir) + '.1'));
      assert.ok(!fs.existsSync(logPath(collabDir)), 'current log should have rotated out');
    });

    it('keeps at most LOG_KEEP_COUNT rotations', () => {
      // Simulate 4 rotations. After the 4th, log.4 should not exist.
      for (let i = 0; i < LOG_KEEP_COUNT + 1; i++) {
        fs.mkdirSync(bridgeDir(collabDir), { recursive: true });
        fs.writeFileSync(logPath(collabDir), 'x'.repeat(LOG_ROTATE_BYTES + 1));
        maybeRotateLog(collabDir);
      }
      assert.ok(!fs.existsSync(logPath(collabDir) + '.' + (LOG_KEEP_COUNT + 1)),
        'log.' + (LOG_KEEP_COUNT + 1) + ' should have been pruned');
    });

    it('does not rotate when size is under the threshold', () => {
      fs.mkdirSync(bridgeDir(collabDir), { recursive: true });
      fs.writeFileSync(logPath(collabDir), 'short');
      maybeRotateLog(collabDir);
      assert.ok(fs.existsSync(logPath(collabDir)));
      assert.ok(!fs.existsSync(logPath(collabDir) + '.1'));
    });

    it('swallows write failures (disk full) without throwing', () => {
      // Pass a path that does not exist and cannot be mkdirSync'd atomically
      // because a plain file blocks it.
      const blocker = path.join(tmpDir, '.claude', 'collab', 'blocker');
      fs.writeFileSync(blocker, 'not a dir');
      assert.doesNotThrow(() => appendLog(blocker, 'x'));
    });
  });

  describe('circuit breaker', () => {
    it('reads default zero state when file missing', () => {
      const cb = readCircuitBreaker(collabDir);
      assert.deepEqual(cb, { disabled_until_ts: 0, last_error: null, consecutive_failures: 0 });
    });

    it('isCircuitOpen = false when disabled_until_ts is in the past', () => {
      assert.equal(isCircuitOpen(collabDir), false);
    });

    it('recordBridgeFailure escalates 10s → 30s → 60s → 1h', () => {
      const a = recordBridgeFailure(collabDir, { error: 'crashed' });
      assert.equal(a.consecutive_failures, 1);
      assert.ok(a.disabled_until_ts - Date.now() >= BACKOFF_SCHEDULE_MS[0] - 100);
      assert.ok(a.disabled_until_ts - Date.now() <= BACKOFF_SCHEDULE_MS[0] + 100);

      const b = recordBridgeFailure(collabDir, { error: 'crashed' });
      assert.equal(b.consecutive_failures, 2);
      assert.ok(b.disabled_until_ts - Date.now() >= BACKOFF_SCHEDULE_MS[1] - 100);

      const c = recordBridgeFailure(collabDir, { error: 'crashed' });
      assert.equal(c.consecutive_failures, 3);
      assert.ok(c.disabled_until_ts - Date.now() >= BACKOFF_SCHEDULE_MS[2] - 100);

      const d = recordBridgeFailure(collabDir, { error: 'crashed' });
      assert.equal(d.consecutive_failures, 4);
      assert.ok(d.disabled_until_ts - Date.now() >= AUTH_FAIL_BACKOFF_MS - 100);
    });

    it('recordBridgeFailure with isAuthFailure=true trips full 1h ceiling immediately', () => {
      const r = recordBridgeFailure(collabDir, { error: '401 unauthorized', isAuthFailure: true });
      assert.equal(r.consecutive_failures, 1);
      assert.ok(r.disabled_until_ts - Date.now() >= AUTH_FAIL_BACKOFF_MS - 100,
        'auth failure should trip 1h backoff on first failure, got ' + (r.disabled_until_ts - Date.now()));
    });

    it('last_error is a string copy of the passed error', () => {
      const e = new Error('boom');
      const r = recordBridgeFailure(collabDir, { error: e });
      assert.equal(r.last_error, 'boom');
    });

    it('recordBridgeSuccess clears all state', () => {
      recordBridgeFailure(collabDir, { error: 'bad' });
      recordBridgeFailure(collabDir, { error: 'bad2' });
      const r = recordBridgeSuccess(collabDir);
      assert.deepEqual(r, { disabled_until_ts: 0, last_error: null, consecutive_failures: 0 });
    });

    it('isCircuitOpen = true while disabled_until_ts is in the future', () => {
      recordBridgeFailure(collabDir, { error: 'x' });
      assert.equal(isCircuitOpen(collabDir), true);
    });

    it('isCircuitOpen = false after the window elapses (simulated clock)', () => {
      recordBridgeFailure(collabDir, { error: 'x' });
      // Simulate looking at the future: check with now = disabled_until_ts + 1
      const cb = readCircuitBreaker(collabDir);
      assert.equal(isCircuitOpen(collabDir, cb.disabled_until_ts + 1), false);
    });

    it('recordBridgeSuccess is a no-op when already clean', () => {
      const before = readCircuitBreaker(collabDir);
      const after = recordBridgeSuccess(collabDir);
      assert.deepEqual(before, after);
      // No file written — verify by checking file existence.
      assert.equal(fs.existsSync(circuitPath(collabDir)), false);
    });
  });

  describe('concurrent lock acquisition (subprocess race)', () => {
    it('only one of two racing processes acquires the lock', async () => {
      // The fixture is a static file alongside this test so we don't have
      // to wrestle with path-escaping inside a runtime-generated script.
      const raceScript = path.resolve(__dirname, 'race-lock-fixture.mjs');
      assert.ok(fs.existsSync(raceScript), 'fixture missing: ' + raceScript);

      const { spawn } = await import('child_process');
      const runChild = () => new Promise((resolve) => {
        const child = spawn(process.execPath, [raceScript, collabDir, 'sess-race'],
          { stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '', err = '';
        child.stdout.on('data', (d) => { out += d.toString(); });
        child.stderr.on('data', (d) => { err += d.toString(); });
        child.on('close', (code) => resolve({ code, out, err }));
      });

      const [a, b] = await Promise.all([runChild(), runChild()]);
      const parse = (s) => { try { return JSON.parse(s); } catch (_) { return null; } };
      const results = [parse(a.out), parse(b.out)];
      assert.ok(results[0] && results[1],
        'both children must produce valid JSON — a.err=' + a.err + ' b.err=' + b.err +
        ' a.out=' + JSON.stringify(a.out) + ' b.out=' + JSON.stringify(b.out));
      const acquiredCount = results.filter(r => r && r.acquired).length;
      assert.equal(acquiredCount, 1,
        'exactly one race winner expected — got ' + acquiredCount +
        ' (results: ' + JSON.stringify(results) + ')');
    });

    it('stale-reclaim TOCTOU: two racing reclaimers do not both think they own the lock', async () => {
      // Seed a stale lock (dead owner). Both children will hit the
      // stale-reclaim path and race on unlink+openSync. Without the
      // post-write verification, both could return acquired=true; with it,
      // exactly one wins.
      const raceScript = path.resolve(__dirname, 'race-lock-fixture.mjs');
      fs.mkdirSync(bridgeDir(collabDir), { recursive: true });
      fs.writeFileSync(lockPath(collabDir), JSON.stringify({
        owner_pid: 0, owner_session_id: 'ghost', started_at: 0, bridge_child_pid: null
      }));

      const { spawn } = await import('child_process');
      const runChild = () => new Promise((resolve) => {
        const child = spawn(process.execPath, [raceScript, collabDir, 'sess-reclaim'],
          { stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '', err = '';
        child.stdout.on('data', (d) => { out += d.toString(); });
        child.stderr.on('data', (d) => { err += d.toString(); });
        child.on('close', (code) => resolve({ code, out, err }));
      });

      // Run many iterations to broaden the TOCTOU window: a single pass
      // might get lucky on scheduling, but 5 iterations with a fresh stale
      // lock each round is a robust statistical check.
      for (let i = 0; i < 5; i++) {
        fs.writeFileSync(lockPath(collabDir), JSON.stringify({
          owner_pid: 0, owner_session_id: 'ghost-' + i, started_at: 0, bridge_child_pid: null
        }));
        const [a, b] = await Promise.all([runChild(), runChild()]);
        const parse = (s) => { try { return JSON.parse(s); } catch (_) { return null; } };
        const results = [parse(a.out), parse(b.out)];
        assert.ok(results[0] && results[1],
          'both children must produce valid JSON (iter ' + i + ')');
        const acquiredCount = results.filter(r => r && r.acquired).length;
        assert.equal(acquiredCount, 1,
          'iter ' + i + ': exactly one reclaimer must win — got ' + acquiredCount +
          ' (results: ' + JSON.stringify(results) + ')');
      }
    });
  });
});
