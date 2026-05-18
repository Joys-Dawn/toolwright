// Regression tests for scripts/reset.js's bound-guard. reset must refuse to
// delete underneath something that is using the DB, because (Windows) rmSync
// fails mid-delete on the locked DB file leaving a half-reset, and (POSIX) rm
// succeeds at the dir entry but a live fd keeps writing the orphan inode while
// new hooks open a fresh DB at the same path — silent split-brain.
//
// Two complementary signals gate it (post daemon-liveness refactor):
//   - isSessionLive(): a ticket records a live Claude PID (no mtime window —
//     a live PID is the signal, a dead one is a crashed-session orphan).
//   - isDbInUse(): some connection actively holds the SQLite lock right now
//     (the OS/SQLite-enforced backstop; catches an active writer even with no
//     ticket). The two-stage --force / --bypass-live-daemon ladder is the
//     escape hatch and is unchanged.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PLUGIN_ROOT = resolve(__dirname, '..', '..');
const SCRIPT = join(PLUGIN_ROOT, 'scripts', 'reset.js');

// Async-aware: a sync body cleans up immediately (unchanged for the existing
// ticket-driven tests); an async body (the belt-and-suspenders SQLite-lock
// case) defers the rmSync until its Promise settles, so the temp project root
// isn't deleted out from under an in-flight `await new Database(...)`.
function withFreshRoot(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'mindwright-reset-'));
  const cleanup = () => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* tmp */ }
  };
  let result;
  try {
    result = fn(dir);
  } catch (err) {
    cleanup();
    throw err;
  }
  if (result && typeof result.then === 'function') {
    return result.then(
      (v) => { cleanup(); return v; },
      (err) => { cleanup(); throw err; },
    );
  }
  cleanup();
  return result;
}

// A reliably-dead PID for the "crashed session, ticket lingers" case.
function deadPid() {
  return spawnSync(process.execPath, ['-e', 'process.exit(0)']).pid;
}

// Fake-bytes DB: enough for the ticket-driven tests (isDbInUse opens it as
// SQLite, fails SQLITE_NOTADB → not-in-use, so the TICKET alone decides
// boundness — exactly the isolation these cases want).
function plantDb(dir) {
  const dbDir = join(dir, '.claude', 'mindwright');
  mkdirSync(dbDir, { recursive: true });
  const dbPath = join(dbDir, 'mindwright.db');
  writeFileSync(dbPath, 'fake sqlite bytes');
  const mirrors = join(dbDir, 'mirrors');
  mkdirSync(mirrors, { recursive: true });
  writeFileSync(join(mirrors, 'recent.md'), '# recent\n');
  return { dbPath, mirrors };
}

// liveness now keys on claude_pid: alive → bound, dead → orphan.
function plantTicket(dir, { claudePid } = {}) {
  const ticketsDir = join(dir, '.claude', 'mindwright', 'tickets');
  mkdirSync(ticketsDir, { recursive: true });
  const ticketPath = join(ticketsDir, `${claudePid}-5678.json`);
  writeFileSync(ticketPath, JSON.stringify({
    session_id: 'reset-test', claude_pid: claudePid, hook_pid: 5678, created_at: Date.now(),
  }));
  return ticketPath;
}

function runReset(dir, args, extraEnv = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, MINDWRIGHT_PROJECT_ROOT: dir, ...extraEnv },
  });
}

test('reset --yes refuses while a live-PID ticket is present', () => {
  withFreshRoot((dir) => {
    const { dbPath, mirrors } = plantDb(dir);
    plantTicket(dir, { claudePid: process.pid }); // alive → bound

    const res = runReset(dir, ['--yes']);
    assert.equal(res.status, 1, `expected exit 1; got ${res.status}. stderr=${res.stderr}`);
    assert.match(res.stderr, /refusing to delete/i);
    assert.match(res.stderr, /Claude session is bound/i);
    assert.ok(existsSync(dbPath), 'DB must still exist after refusal');
    assert.ok(existsSync(mirrors), 'mirrors dir must still exist after refusal');
  });
});

test('reset --yes proceeds when the only ticket has a dead PID (crashed/never-spawned session)', () => {
  withFreshRoot((dir) => {
    const { dbPath, mirrors } = plantDb(dir);
    plantTicket(dir, { claudePid: deadPid() }); // dead → orphan, not bound

    const res = runReset(dir, ['--yes']);
    assert.equal(res.status, 0, `expected exit 0; got ${res.status}. stderr=${res.stderr}`);
    assert.match(res.stderr, /DELETING/);
    assert.ok(!existsSync(dbPath), 'DB should be gone after successful reset');
    assert.ok(!existsSync(mirrors), 'mirrors dir should be gone after successful reset');
  });
});

test('reset --yes --force STILL refuses when a live-PID ticket is present (single-flag override is too coarse)', () => {
  withFreshRoot((dir) => {
    const { dbPath, mirrors } = plantDb(dir);
    plantTicket(dir, { claudePid: process.pid }); // alive → bound

    const res = runReset(dir, ['--yes', '--force']);
    assert.equal(res.status, 1, `--force alone must refuse when bound; got ${res.status}. stderr=${res.stderr}`);
    assert.match(res.stderr, /refusing to delete/i);
    assert.match(res.stderr, /--bypass-live-daemon/);
    assert.ok(existsSync(dbPath));
    assert.ok(existsSync(mirrors));
  });
});

test('reset --yes --force bypasses the guard when the ticket is a genuine dead-PID orphan', () => {
  withFreshRoot((dir) => {
    const { dbPath, mirrors } = plantDb(dir);
    plantTicket(dir, { claudePid: deadPid() }); // dead → not bound → --force is a clean no-op

    const res = runReset(dir, ['--yes', '--force']);
    assert.equal(res.status, 0, `--force must succeed when not bound; got ${res.status}. stderr=${res.stderr}`);
    assert.ok(!existsSync(dbPath));
    assert.ok(!existsSync(mirrors));
  });
});

test('reset --yes --bypass-live-daemon (without --force) STILL refuses on a live-PID ticket', () => {
  withFreshRoot((dir) => {
    const { dbPath, mirrors } = plantDb(dir);
    plantTicket(dir, { claudePid: process.pid });

    const res = runReset(dir, ['--yes', '--bypass-live-daemon']);
    assert.equal(res.status, 1,
      `--bypass-live-daemon alone must refuse when bound; got ${res.status}. stderr=${res.stderr}`);
    assert.match(res.stderr, /refusing to delete/i);
    assert.match(res.stderr, /--force/);
    assert.ok(existsSync(dbPath));
    assert.ok(existsSync(mirrors));
  });
});

test('reset --yes --force --bypass-live-daemon overrides the bound refusal', () => {
  withFreshRoot((dir) => {
    const { dbPath, mirrors } = plantDb(dir);
    plantTicket(dir, { claudePid: process.pid }); // bound

    const res = runReset(dir, ['--yes', '--force', '--bypass-live-daemon']);
    assert.equal(res.status, 0,
      `both override flags must allow deletion; got ${res.status}. stderr=${res.stderr}`);
    assert.ok(!existsSync(dbPath));
    assert.ok(!existsSync(mirrors));
  });
});

test('reset (dry-run) prints the bound hint but still succeeds without deleting', () => {
  withFreshRoot((dir) => {
    const { dbPath, mirrors } = plantDb(dir);
    plantTicket(dir, { claudePid: process.pid });

    const res = runReset(dir, []); // no --yes
    assert.equal(res.status, 0, `dry-run must succeed; got ${res.status}. stderr=${res.stderr}`);
    assert.match(res.stderr, /DRY RUN/);
    assert.match(res.stderr, /Claude session is currently bound/i);
    assert.match(res.stderr, /--force/);
    assert.ok(existsSync(dbPath));
    assert.ok(existsSync(mirrors));
  });
});

test('belt-and-suspenders: a held SQLite lock makes reset --yes refuse even with NO ticket at all', async () => {
  // The OS/SQLite-enforced backstop: no ticket exists (isSessionLive=false),
  // but a real connection actively holds BEGIN EXCLUSIVE, so isDbInUse=true
  // and reset must still refuse. The lock is held by THIS process; reset runs
  // as a separate process → genuine cross-process lock contention.
  await new Promise((resolveTest, rejectTest) => {
    withFreshRoot(async (dir) => {
      const dbDir = join(dir, '.claude', 'mindwright');
      mkdirSync(dbDir, { recursive: true });
      const dbPath = join(dbDir, 'mindwright.db');
      const { loadNativeDefault } = await import('../../lib/native-require.js');
      const Database = await loadNativeDefault('better-sqlite3');
      const held = new Database(dbPath);
      held.pragma('journal_mode = WAL');
      held.exec('CREATE TABLE t(x)');
      held.pragma('busy_timeout = 0');
      held.exec('BEGIN EXCLUSIVE'); // hold the write lock across the spawn
      try {
        const res = runReset(dir, ['--yes']); // separate process
        assert.equal(res.status, 1,
          `a held SQLite lock must make reset refuse; got ${res.status}. stderr=${res.stderr}`);
        assert.match(res.stderr, /refusing to delete/i);
        assert.ok(existsSync(dbPath), 'DB must survive — it was actively locked');
      } finally {
        try { held.exec('ROLLBACK'); } catch { /* */ }
        held.close();
      }
    }).then(resolveTest, rejectTest);
  });
});
