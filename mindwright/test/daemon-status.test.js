// Direct unit tests for lib/daemon-status.js#isDaemonAlive. The function is
// the gate for destructive operations (reset.js refuses --yes when it
// returns true) and the source of the `daemon_alive` field in
// mindwright_status, so its TTL semantics need standalone coverage rather
// than only the boolean-type sanity check in server.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, rmSync, mkdirSync, writeFileSync, utimesSync, rmdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDaemonAlive } from '../lib/daemon-status.js';
import { ticketsDir } from '../lib/paths.js';
import { DAEMON_TICKET_MAX_AGE_MS } from '../lib/constants.js';

function withFreshProject(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'mindwright-daemon-status-'));
  const prev = process.env.MINDWRIGHT_PROJECT_ROOT;
  process.env.MINDWRIGHT_PROJECT_ROOT = dir;
  try {
    return fn(dir);
  } finally {
    if (prev === undefined) delete process.env.MINDWRIGHT_PROJECT_ROOT;
    else process.env.MINDWRIGHT_PROJECT_ROOT = prev;
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* tmp */ }
  }
}

function plantTicket(filename, { ageMs = 0, claudePid = undefined } = {}) {
  const dir = ticketsDir();
  mkdirSync(dir, { recursive: true });
  const path = join(dir, filename);
  const body = { pipe: 'fake', session_id: 'fake-1' };
  if (claudePid !== undefined) body.claude_pid = claudePid;
  writeFileSync(path, JSON.stringify(body));
  if (ageMs > 0) {
    const old = new Date(Date.now() - ageMs);
    utimesSync(path, old, old);
  }
  return path;
}

// Spawn a child process and wait for it to exit. The returned PID points at
// a process that was real and is now reaped — a reliable "definitely dead"
// PID for liveness probing. There's a theoretical PID-reuse race but
// extremely unlikely between exit and the immediately-following probe.
async function getDeadPid() {
  const { spawnSync } = await import('node:child_process');
  const res = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
  return res.pid;
}

test('ticket newer than FRESH_MS reports alive=true', () => {
  withFreshProject(() => {
    plantTicket('100-200.json'); // fresh mtime
    assert.equal(isDaemonAlive(), true);
  });
});

test('ticket older than FRESH_MS reports alive=false', () => {
  withFreshProject(() => {
    // 1s past the freshness window so we never race the wall clock.
    plantTicket('100-200.json', { ageMs: DAEMON_TICKET_MAX_AGE_MS + 1000 });
    assert.equal(isDaemonAlive(), false);
  });
});

test('mixed fresh + stale tickets report alive=true (any fresh wins)', () => {
  withFreshProject(() => {
    plantTicket('100-200.json', { ageMs: DAEMON_TICKET_MAX_AGE_MS + 1000 });
    plantTicket('300-400.json'); // fresh
    assert.equal(isDaemonAlive(), true);
  });
});

test('only non-.json files present reports alive=false', () => {
  withFreshProject(() => {
    const dir = ticketsDir();
    mkdirSync(dir, { recursive: true });
    // Plant non-.json files: tmp scratch, a README, a .lock. None of
    // these should trip the freshness gate even though they're fresh.
    writeFileSync(join(dir, '100-200.json.tmp.42'), 'in flight');
    writeFileSync(join(dir, 'README'), 'human readable');
    writeFileSync(join(dir, 'pipe.lock'), '');
    assert.equal(isDaemonAlive(), false);
  });
});

test('missing tickets directory returns false without throwing', () => {
  withFreshProject(() => {
    // No mkdir — the tickets directory doesn't exist yet.
    // ENOENT must be caught internally; we get false back.
    assert.equal(isDaemonAlive(), false);
  });
});

test('empty tickets directory returns false', () => {
  withFreshProject(() => {
    mkdirSync(ticketsDir(), { recursive: true });
    assert.equal(isDaemonAlive(), false);
  });
});

test('fresh ticket with a live claude_pid still reports alive=true', () => {
  // The PID-liveness shortcut must NOT regress the basic alive case. Use
  // the test runner's own PID — it's definitely alive while the test runs.
  withFreshProject(() => {
    plantTicket('100-200.json', { claudePid: process.pid });
    assert.equal(isDaemonAlive(), true);
  });
});

test('fresh ticket with a dead claude_pid reports alive=false (PID shortcut bypasses the freshness window)', async () => {
  // Regression for the /mindwright:reset two-stage daemon override: when
  // the user closes Claude Code before running reset, the ticket file's
  // mtime is still within the freshness window but the Claude CLI PID is
  // gone. Without the PID shortcut the user has to wait 10 minutes or pass
  // --bypass-live-daemon. With the shortcut, reset proceeds immediately.
  const deadPid = await getDeadPid();
  withFreshProject(() => {
    plantTicket('100-200.json', { claudePid: deadPid });
    assert.equal(isDaemonAlive(), false,
      `dead claude_pid (${deadPid}) on a fresh ticket must report alive=false`);
  });
});

test('fresh ticket without claude_pid is treated as alive (conservative — older ticket format)', () => {
  // Backward compatibility: tickets from older mindwright versions had no
  // claude_pid field. Treat them as conservatively alive — refusing a
  // reset is less destructive than allowing one against a daemon we can't
  // verify is dead.
  withFreshProject(() => {
    plantTicket('100-200.json'); // no claudePid
    assert.equal(isDaemonAlive(), true);
  });
});

test('fresh ticket with unparseable JSON is treated as alive (conservative)', () => {
  withFreshProject(() => {
    const dir = ticketsDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '100-200.json'), 'not valid json {{');
    assert.equal(isDaemonAlive(), true);
  });
});
