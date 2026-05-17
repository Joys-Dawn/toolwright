// Regression test for scripts/reset.js's active-daemon guardrail
// (behavior-7). The script must refuse to delete underneath a live daemon
// because (Windows) rmSync fails mid-delete on the locked DB file, leaving
// mirrors deleted but the DB intact, and (POSIX) rm succeeds at the
// directory entry but the daemon's open fd keeps writing to the orphan
// inode while new hooks open a fresh DB at the same path — two split-brain
// stores with no warning.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync, rmSync, writeFileSync, mkdirSync,
  existsSync, statSync, utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PLUGIN_ROOT = resolve(__dirname, '..', '..');
const SCRIPT = join(PLUGIN_ROOT, 'scripts', 'reset.js');

function withFreshRoot(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'mindwright-reset-'));
  try {
    return fn(dir);
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* tmp */ }
  }
}

function plantDb(dir) {
  const dbDir = join(dir, '.claude', 'mindwright');
  mkdirSync(dbDir, { recursive: true });
  const dbPath = join(dbDir, 'mindwright.db');
  writeFileSync(dbPath, 'fake sqlite bytes');
  // Mirrors too — reset deletes mirrorsDir as well.
  const mirrors = join(dbDir, 'mirrors');
  mkdirSync(mirrors, { recursive: true });
  writeFileSync(join(mirrors, 'recent.md'), '# recent\n');
  return { dbPath, mirrors };
}

function plantTicket(dir, { ageMs = 0 } = {}) {
  const ticketsDir = join(dir, '.claude', 'mindwright', 'tickets');
  mkdirSync(ticketsDir, { recursive: true });
  const ticketPath = join(ticketsDir, '1234-5678.json');
  writeFileSync(ticketPath, JSON.stringify({ pipe: 'fake' }));
  if (ageMs > 0) {
    const old = new Date(Date.now() - ageMs);
    utimesSync(ticketPath, old, old);
  }
  return ticketPath;
}

function runReset(dir, args, extraEnv = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, MINDWRIGHT_PROJECT_ROOT: dir, ...extraEnv },
  });
}

test('reset --yes refuses while a live daemon ticket is present', () => {
  withFreshRoot((dir) => {
    const { dbPath, mirrors } = plantDb(dir);
    plantTicket(dir); // fresh mtime = live daemon

    const res = runReset(dir, ['--yes']);
    assert.equal(res.status, 1, `expected exit 1; got ${res.status}. stderr=${res.stderr}`);
    assert.match(res.stderr, /refusing to delete/i);
    assert.match(res.stderr, /active daemon/i);
    // Nothing should have been deleted.
    assert.ok(existsSync(dbPath), 'DB must still exist after refusal');
    assert.ok(existsSync(mirrors), 'mirrors dir must still exist after refusal');
  });
});

test('reset --yes proceeds when no ticket is fresh (daemon dead or never spawned)', () => {
  withFreshRoot((dir) => {
    const { dbPath, mirrors } = plantDb(dir);
    // Plant a stale ticket — older than the 10-minute freshness window.
    plantTicket(dir, { ageMs: 11 * 60 * 1000 });

    const res = runReset(dir, ['--yes']);
    assert.equal(res.status, 0, `expected exit 0; got ${res.status}. stderr=${res.stderr}`);
    assert.match(res.stderr, /DELETING/);
    assert.ok(!existsSync(dbPath), 'DB should be gone after successful reset');
    assert.ok(!existsSync(mirrors), 'mirrors dir should be gone after successful reset');
  });
});

test('reset --yes --force STILL refuses when the ticket is fresh (single-flag override is too coarse)', () => {
  // Behavior regression: --force was previously a single-flag escape hatch
  // for the irreversible reset. A user who mis-judged the daemon's liveness
  // would corrupt their DB silently. Now --force only bypasses *when the
  // ticket is genuinely stale* — if isDaemonAlive() still says alive, --force
  // refuses with a clearer message pointing at --bypass-live-daemon.
  withFreshRoot((dir) => {
    const { dbPath, mirrors } = plantDb(dir);
    plantTicket(dir); // fresh — daemon shows alive

    const res = runReset(dir, ['--yes', '--force']);
    assert.equal(res.status, 1, `--force alone must refuse when daemon is alive; got ${res.status}. stderr=${res.stderr}`);
    assert.match(res.stderr, /refusing to delete/i);
    assert.match(res.stderr, /--bypass-live-daemon/);
    // Nothing deleted.
    assert.ok(existsSync(dbPath));
    assert.ok(existsSync(mirrors));
  });
});

test('reset --yes --force bypasses the live-daemon guard when the ticket is genuinely stale', () => {
  // Standard --force use case: a previous session crashed, ticket lingers,
  // user wants to nuke and rebuild. With a stale ticket, isDaemonAlive()
  // returns false and --force is a clean no-op (proceeds same as --yes would).
  withFreshRoot((dir) => {
    const { dbPath, mirrors } = plantDb(dir);
    plantTicket(dir, { ageMs: 11 * 60 * 1000 }); // stale — past freshness window

    const res = runReset(dir, ['--yes', '--force']);
    assert.equal(res.status, 0, `--force must succeed when ticket is stale; got ${res.status}. stderr=${res.stderr}`);
    assert.ok(!existsSync(dbPath));
    assert.ok(!existsSync(mirrors));
  });
});

test('reset --yes --bypass-live-daemon (without --force) STILL refuses on a fresh ticket', () => {
  // Regression: the override is a TWO-stage ladder. Passing
  // --bypass-live-daemon by itself (skipping the --force step) used to let
  // a single mistaken flag wipe an actively-bound DB, contradicting the
  // documented ladder and the refusal-message wording. Now both override
  // flags must be present together; --bypass-live-daemon alone falls into
  // the non-forced refusal branch and the user is pointed at --force first.
  withFreshRoot((dir) => {
    const { dbPath, mirrors } = plantDb(dir);
    plantTicket(dir); // fresh — daemon shows alive

    const res = runReset(dir, ['--yes', '--bypass-live-daemon']);
    assert.equal(res.status, 1,
      `--bypass-live-daemon alone must refuse when daemon is alive; got ${res.status}. stderr=${res.stderr}`);
    assert.match(res.stderr, /refusing to delete/i);
    assert.match(res.stderr, /--force/);
    // Nothing deleted.
    assert.ok(existsSync(dbPath));
    assert.ok(existsSync(mirrors));
  });
});

test('reset --yes --force --bypass-live-daemon overrides the live-daemon refusal', () => {
  // Two-stage override: --force alone refuses on a fresh ticket, but adding
  // the explicit --bypass-live-daemon flag lets the user nuke anyway. Used
  // when the user has manually verified the daemon is dead and only the
  // ticket file is lingering inside the freshness window.
  withFreshRoot((dir) => {
    const { dbPath, mirrors } = plantDb(dir);
    plantTicket(dir); // fresh ticket

    const res = runReset(dir, ['--yes', '--force', '--bypass-live-daemon']);
    assert.equal(res.status, 0,
      `--bypass-live-daemon must allow deletion; got ${res.status}. stderr=${res.stderr}`);
    assert.ok(!existsSync(dbPath));
    assert.ok(!existsSync(mirrors));
  });
});

test('reset (dry-run) prints a hint about active daemon but still succeeds without deleting', () => {
  withFreshRoot((dir) => {
    const { dbPath, mirrors } = plantDb(dir);
    plantTicket(dir);

    const res = runReset(dir, []); // no --yes
    assert.equal(res.status, 0, `dry-run must succeed; got ${res.status}. stderr=${res.stderr}`);
    assert.match(res.stderr, /DRY RUN/);
    // The hint about the live daemon should be visible so the user knows
    // why --yes alone won't work next.
    assert.match(res.stderr, /active daemon/i);
    assert.match(res.stderr, /--force/);
    // Nothing deleted.
    assert.ok(existsSync(dbPath));
    assert.ok(existsSync(mirrors));
  });
});
