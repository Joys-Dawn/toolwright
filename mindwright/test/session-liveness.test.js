// Direct unit tests for lib/session-liveness.js. isSessionLive() gates the
// destructive reset (reset.js refuses --yes when it — or the db-in-use probe
// — says bound) and feeds the `session_alive` field in mindwright_status, so
// its PID semantics need standalone coverage.
//
// Liveness is the recorded Claude PID, NOT file mtime: nothing heartbeats the
// ticket, so an mtime window false-negatived ~10 min into every real session
// (the cluster this replaced). A ticket with no probeable PID / unparseable
// JSON is NOT treated as conservatively-alive: with no mtime there is nothing
// to age such a turd out, and the destructive path's real backstop is the
// SQLite BEGIN EXCLUSIVE probe in db-in-use.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, rmSync, mkdirSync, writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isSessionLive, isPidAlive } from '../lib/session-liveness.js';
import { ticketsDir } from '../lib/paths.js';

function withFreshProject(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'mindwright-session-liveness-'));
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

function plantTicket(filename, { claudePid = undefined } = {}) {
  const dir = ticketsDir();
  mkdirSync(dir, { recursive: true });
  const path = join(dir, filename);
  const body = { session_id: 'fake-1', hook_pid: 1, created_at: Date.now() };
  if (claudePid !== undefined) body.claude_pid = claudePid;
  writeFileSync(path, JSON.stringify(body));
  return path;
}

// A reliably-dead PID: spawn a child, let it exit, reuse its reaped pid.
function deadPid() {
  return spawnSync(process.execPath, ['-e', 'process.exit(0)']).pid;
}

// ---------------------------------------------------------------
// isSessionLive
// ---------------------------------------------------------------

test('a ticket with a live claude_pid → isSessionLive true', () => {
  withFreshProject(() => {
    plantTicket('100-200.json', { claudePid: process.pid }); // alive while test runs
    assert.equal(isSessionLive(), true);
  });
});

test('a ticket with a dead claude_pid → isSessionLive false', () => {
  withFreshProject(() => {
    plantTicket('100-200.json', { claudePid: deadPid() });
    assert.equal(isSessionLive(), false);
  });
});

test('mixed dead + live tickets → true (any live PID wins)', () => {
  withFreshProject(() => {
    plantTicket('1-1.json', { claudePid: deadPid() });
    plantTicket('2-2.json', { claudePid: process.pid });
    assert.equal(isSessionLive(), true);
  });
});

test('missing tickets directory → false without throwing', () => {
  withFreshProject(() => {
    assert.equal(isSessionLive(), false);
  });
});

test('empty tickets directory → false', () => {
  withFreshProject(() => {
    mkdirSync(ticketsDir(), { recursive: true });
    assert.equal(isSessionLive(), false);
  });
});

test('only non-.json / .tmp files (even with live content) → false', () => {
  withFreshProject(() => {
    const dir = ticketsDir();
    mkdirSync(dir, { recursive: true });
    // A fresh .tmp partial that happens to carry a live pid must NOT count
    // (writeTicket only publishes via atomic rename of a *.json).
    writeFileSync(
      join(dir, '100-200.json.tmp.42'),
      JSON.stringify({ claude_pid: process.pid }),
    );
    writeFileSync(join(dir, 'README'), 'human readable');
    writeFileSync(join(dir, 'pipe.lock'), '');
    assert.equal(isSessionLive(), false);
  });
});

test('a ticket with NO claude_pid → false (NOT conservatively alive — no mtime ages it out; db-in-use is the destructive backstop)', () => {
  withFreshProject(() => {
    plantTicket('100-200.json'); // no claude_pid field
    assert.equal(isSessionLive(), false);
  });
});

test('a ticket with unparseable JSON → false (same rationale as the PID-less case)', () => {
  withFreshProject(() => {
    const dir = ticketsDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '100-200.json'), 'not valid json {{');
    assert.equal(isSessionLive(), false);
  });
});

// ---------------------------------------------------------------
// isPidAlive
// ---------------------------------------------------------------

test('isPidAlive: rejects non-integers and non-positive pids', () => {
  for (const bad of [undefined, null, 'x', 1.5, 0, -1, NaN]) {
    assert.equal(isPidAlive(bad), false, `isPidAlive(${String(bad)}) must be false`);
  }
});

test('isPidAlive: the running test process is alive', () => {
  assert.equal(isPidAlive(process.pid), true);
});

test('isPidAlive: a reaped child pid is dead', () => {
  assert.equal(isPidAlive(deadPid()), false);
});
