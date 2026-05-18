// Coverage for the ticket lifecycle that binds a SessionStart hook to a live
// Claude session. The hooks tests spawn session-start.js but never inspect
// ticket files directly — this file pins:
//   - filename pattern + payload shape on write
//   - tmp-file invisibility to readers
//   - claude_pid filter
//   - PID-liveness gate (NOT mtime — nothing heartbeats the ticket; a live
//     PID is the liveness signal, a dead PID is a crashed-session orphan)
//   - unparseable / partial ticket robustness
//   - cleanup count + race tolerance (.json by dead-PID, .tmp by mtime)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync, mkdirSync, utimesSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  writeTicket,
  readActiveTicket,
  cleanupStaleTickets,
  ticketPathFor,
} from '../../lib/daemon-ticket.mjs';
import { ticketsDir } from '../../lib/paths.js';
import { DAEMON_TICKET_MAX_AGE_MS } from '../../lib/constants.js';

async function withTmp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'mindwright-ticket-'));
  // Snapshot + restore MINDWRIGHT_PROJECT_ROOT so the env var never leaks
  // across test files; without this it would point at a just-rmsync'd path
  // for every subsequent caller in the same node --test invocation.
  const prevRoot = process.env.MINDWRIGHT_PROJECT_ROOT;
  process.env.MINDWRIGHT_PROJECT_ROOT = dir;
  try {
    return await fn(dir);
  } finally {
    if (prevRoot === undefined) delete process.env.MINDWRIGHT_PROJECT_ROOT;
    else process.env.MINDWRIGHT_PROJECT_ROOT = prevRoot;
    rmSync(dir, { recursive: true, force: true });
  }
}

function tdir() {
  return ticketsDir();
}

// A reliably-dead PID: spawn a child, wait for it to exit, reuse its now-
// reaped pid. The exit→probe gap makes PID reuse vanishingly unlikely.
function deadPid() {
  const res = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
  return res.pid;
}

// ---------------------------------------------------------------
// writeTicket
// ---------------------------------------------------------------

test('writeTicket creates <claudePid>-<hookPid>.json with the documented fields', async () => {
  await withTmp(async () => {
    const sessionId = 'sess-write-1';
    const filePath = await writeTicket({ sessionId });
    assert.match(filePath, /[\\/]\d+-\d+\.json$/);
    const data = JSON.parse(readFileSync(filePath, 'utf8'));
    assert.equal(data.session_id, sessionId);
    assert.equal(data.claude_pid, process.ppid);
    assert.equal(data.hook_pid, process.pid);
    assert.equal(typeof data.created_at, 'number');
  });
});

test('ticketPathFor returns the same path writeTicket wrote', async () => {
  // Discovery (readActiveTicket / isSessionLive) keys tickets by the
  // (claudePid, hookPid) filename. If this helper ever diverged from the
  // path writeTicket actually writes, lookups would silently miss the live
  // ticket.
  await withTmp(async () => {
    const filePath = await writeTicket({ sessionId: 'sess-path-1' });
    assert.equal(ticketPathFor(process.ppid, process.pid), filePath);
  });
});

test('writeTicket rejects missing sessionId', async () => {
  await withTmp(async () => {
    await assert.rejects(
      writeTicket({}),
      /sessionId required/
    );
  });
});

// ---------------------------------------------------------------
// readActiveTicket — liveness is the recorded PID, never file mtime
// ---------------------------------------------------------------

test('readActiveTicket returns null on missing dir (ENOENT) without throwing', async () => {
  await withTmp(async () => {
    const result = await readActiveTicket();
    assert.equal(result, null);
  });
});

test('readActiveTicket picks the most-recently-created among live-PID tickets', async () => {
  await withTmp(async () => {
    const dir = tdir();
    mkdirSync(dir, { recursive: true });
    // Both tickets carry a LIVE pid (this test runner's parent); the newer
    // created_at must win.
    const older = {
      session_id: 'old', claude_pid: process.ppid, hook_pid: 1, created_at: Date.now() - 1000,
    };
    const newer = {
      session_id: 'new', claude_pid: process.ppid, hook_pid: 2, created_at: Date.now(),
    };
    writeFileSync(join(dir, `${process.ppid}-1.json`), JSON.stringify(older));
    writeFileSync(join(dir, `${process.ppid}-2.json`), JSON.stringify(newer));
    const result = await readActiveTicket({ claudePid: process.ppid });
    assert.equal(result.session_id, 'new');
  });
});

test('readActiveTicket with claudePid filter excludes non-matching tickets', async () => {
  await withTmp(async () => {
    const dir = tdir();
    mkdirSync(dir, { recursive: true });
    // Both PIDs are alive (this process + its parent) so the LIVENESS gate
    // passes for both — it is the claudePid FILTER that must exclude 'theirs'.
    const mine = {
      session_id: 'mine', claude_pid: process.pid, hook_pid: 1, created_at: Date.now(),
    };
    const theirs = {
      session_id: 'theirs', claude_pid: process.ppid, hook_pid: 2, created_at: Date.now() + 5,
    };
    writeFileSync(join(dir, `${process.pid}-1.json`), JSON.stringify(mine));
    writeFileSync(join(dir, `${process.ppid}-2.json`), JSON.stringify(theirs));
    const result = await readActiveTicket({ claudePid: process.pid });
    assert.equal(result.session_id, 'mine');
  });
});

test('readActiveTicket excludes a ticket whose claude_pid is dead', async () => {
  // The replacement for the old mtime window: a crashed/closed session's
  // ticket lingers on disk but its PID is gone, so it must not be returned
  // (its rows would orphan under FALLBACK_SEED_SESSION_ID otherwise).
  await withTmp(async () => {
    const dir = tdir();
    mkdirSync(dir, { recursive: true });
    const dead = deadPid();
    writeFileSync(
      join(dir, `${dead}-1.json`),
      JSON.stringify({ session_id: 'crashed', claude_pid: dead, hook_pid: 1, created_at: Date.now() }),
    );
    assert.equal(await readActiveTicket(), null,
      `a dead claude_pid (${dead}) ticket must not be returned`);
  });
});

test('readActiveTicket returns a long-lived session ticket regardless of created_at age (no mtime window)', async () => {
  // Regression for the cluster this replaced: a long session writes its
  // ticket once at SessionStart and nothing refreshes it. created_at can be
  // hours old; as long as the Claude PID is alive the ticket is live, so
  // seed-from-repo keeps binding rows to the real session.
  await withTmp(async () => {
    const dir = tdir();
    mkdirSync(dir, { recursive: true });
    const fp = join(dir, `${process.ppid}-99.json`);
    writeFileSync(fp, JSON.stringify({
      session_id: 'live-long-session',
      claude_pid: process.ppid,
      hook_pid: 99,
      created_at: Date.now() - 6 * 60 * 60_000, // 6 hours ago
    }));
    // Backdate mtime too — proving mtime is irrelevant now (the old design
    // would have filtered this out).
    const old = (Date.now() - 6 * 60 * 60_000) / 1000;
    utimesSync(fp, old, old);
    const result = await readActiveTicket({ claudePid: process.ppid });
    assert.ok(result, 'a live-PID ticket must survive any created_at/mtime age');
    assert.equal(result.session_id, 'live-long-session');
  });
});

test('readActiveTicket skips .tmp.* partials and unparseable JSON', async () => {
  await withTmp(async () => {
    const dir = tdir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${process.ppid}-1.json.tmp.1234`), '{}');
    writeFileSync(join(dir, `${process.ppid}-2.json`), '{ not valid json');
    const valid = {
      session_id: 'valid', claude_pid: process.ppid, hook_pid: 3, created_at: Date.now(),
    };
    writeFileSync(join(dir, `${process.ppid}-3.json`), JSON.stringify(valid));
    const result = await readActiveTicket({ claudePid: process.ppid });
    assert.equal(result.session_id, 'valid');
  });
});

// ---------------------------------------------------------------
// cleanupStaleTickets — .json by dead PID, .tmp by mtime
// ---------------------------------------------------------------

test('cleanupStaleTickets removes a dead-PID ticket and keeps a live-PID one', async () => {
  await withTmp(async () => {
    const dir = tdir();
    mkdirSync(dir, { recursive: true });
    const live = {
      session_id: 'f', claude_pid: process.ppid, hook_pid: 1, created_at: Date.now(),
    };
    const dead = deadPid();
    const orphan = {
      session_id: 's', claude_pid: dead, hook_pid: 2, created_at: Date.now(),
    };
    writeFileSync(join(dir, `${process.ppid}-1.json`), JSON.stringify(live));
    writeFileSync(join(dir, `${dead}-2.json`), JSON.stringify(orphan));
    const removed = await cleanupStaleTickets();
    assert.equal(removed, 1);
    const remaining = readdirSync(dir).filter((f) => f.endsWith('.json'));
    assert.deepEqual(remaining, [`${process.ppid}-1.json`]);
  });
});

test('cleanupStaleTickets preserves a live-PID ticket with an old created_at (regression)', async () => {
  // The long-running-session case: old created_at, never-refreshed mtime,
  // but the PID is alive — cleanup must not yank it out from under it.
  await withTmp(async () => {
    const dir = tdir();
    mkdirSync(dir, { recursive: true });
    const fp = join(dir, `${process.ppid}-1.json`);
    writeFileSync(fp, JSON.stringify({
      session_id: 'long', claude_pid: process.ppid, hook_pid: 1,
      created_at: Date.now() - 6 * 60 * 60_000,
    }));
    const old = (Date.now() - 6 * 60 * 60_000) / 1000;
    utimesSync(fp, old, old);
    const removed = await cleanupStaleTickets();
    assert.equal(removed, 0, 'a live-PID ticket must not be removed regardless of age');
    assert.equal(readdirSync(dir).filter((f) => f.endsWith('.json')).length, 1);
  });
});

test('cleanupStaleTickets treats unparseable / PID-less tickets as orphaned', async () => {
  await withTmp(async () => {
    const dir = tdir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `1-1.json`), 'not json');
    writeFileSync(join(dir, `1-2.json`), '{"session_id":"x","created_at":123}'); // no claude_pid
    const removed = await cleanupStaleTickets();
    assert.equal(removed, 2);
    assert.equal(readdirSync(dir).filter((f) => f.endsWith('.json')).length, 0);
  });
});

test('cleanupStaleTickets returns 0 on missing ticket dir', async () => {
  await withTmp(async () => {
    const removed = await cleanupStaleTickets();
    assert.equal(removed, 0);
  });
});

test('cleanupStaleTickets removes orphan .tmp.<pid> files past the tmp window (mtime-gated)', async () => {
  // writeTicket crashing between writeFile() and rename() can leave
  // `.tmp.<pid>` files. They have no trustworthy PID/JSON, so they are the
  // ONLY thing still time-swept (window = DAEMON_TICKET_MAX_AGE_MS).
  await withTmp(async () => {
    const dir = tdir();
    mkdirSync(dir, { recursive: true });
    const tmpName = `9999-1.json.tmp.12345`;
    const tmpPath = join(dir, tmpName);
    writeFileSync(tmpPath, '{ partial');
    const old = (Date.now() - DAEMON_TICKET_MAX_AGE_MS - 60_000) / 1000;
    utimesSync(tmpPath, old, old);

    // A FRESH tmp file — a peer hook's write could be in-flight; leave it.
    const freshTmp = `9999-2.json.tmp.67890`;
    writeFileSync(join(dir, freshTmp), '{ in-flight');

    const removed = await cleanupStaleTickets();
    assert.equal(removed, 1, 'must remove the stale tmp orphan');
    const remaining = readdirSync(dir);
    assert.ok(!remaining.includes(tmpName), 'stale tmp must be gone');
    assert.ok(remaining.includes(freshTmp), 'fresh in-flight tmp must survive');
  });
});
