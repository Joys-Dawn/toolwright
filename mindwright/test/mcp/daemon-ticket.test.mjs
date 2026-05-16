// Coverage for the ticket lifecycle that binds SessionStart hooks to the
// in-process MCP daemon. The hooks tests spawn session-start.js but never
// inspect ticket file contents directly — this file pins:
//   - filename pattern + payload shape on write
//   - tmp-file invisibility to readers
//   - claude_pid filter
//   - max-age filter
//   - unparseable / partial ticket robustness
//   - cleanup count + race tolerance

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync, mkdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  writeTicket,
  readActiveTicket,
  cleanupStaleTickets,
  ticketPathFor,
} from '../../mcp/daemon-ticket.mjs';
import { ticketsDir } from '../../lib/paths.js';

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

// ---------------------------------------------------------------
// writeTicket
// ---------------------------------------------------------------

test('writeTicket creates <claudePid>-<hookPid>.json with the documented fields', async () => {
  await withTmp(async () => {
    const sessionId = 'sess-write-1';
    const pipePath = '\\\\.\\pipe\\mindwright-test';
    const filePath = await writeTicket({ sessionId, pipePath });
    assert.match(filePath, /[\\/]\d+-\d+\.json$/);
    const data = JSON.parse(readFileSync(filePath, 'utf8'));
    assert.equal(data.session_id, sessionId);
    assert.equal(data.pipe_path, pipePath);
    assert.equal(data.claude_pid, process.ppid);
    assert.equal(data.hook_pid, process.pid);
    assert.equal(typeof data.created_at, 'number');
  });
});

test('ticketPathFor returns the same path writeTicket wrote', async () => {
  // The MCP daemon's periodic heartbeat (server.mjs) uses ticketPathFor to
  // compute its own ticket path from the binding result. If this helper ever
  // diverges from the path writeTicket actually writes, the daemon would
  // touch a non-existent file forever and isDaemonAlive() would falsely
  // report dead 10 minutes into a live session — the exact failure mode
  // this fix prevents.
  await withTmp(async () => {
    const filePath = await writeTicket({
      sessionId: 'sess-path-1',
      pipePath: '\\\\.\\pipe\\x',
    });
    assert.equal(ticketPathFor(process.ppid, process.pid), filePath);
  });
});

test('writeTicket rejects missing sessionId', async () => {
  await withTmp(async () => {
    await assert.rejects(
      writeTicket({ pipePath: '\\\\.\\pipe\\x' }),
      /sessionId required/
    );
  });
});

test('writeTicket rejects missing pipePath', async () => {
  await withTmp(async () => {
    await assert.rejects(
      writeTicket({ sessionId: 's' }),
      /pipePath required/
    );
  });
});

// ---------------------------------------------------------------
// readActiveTicket
// ---------------------------------------------------------------

test('readActiveTicket returns null on missing dir (ENOENT) without throwing', async () => {
  await withTmp(async (root) => {
    // Don't create the ticket dir at all.
    const result = await readActiveTicket();
    assert.equal(result, null);
  });
});

test('readActiveTicket picks the most-recently-created ticket', async () => {
  await withTmp(async () => {
    const dir = tdir();
    mkdirSync(dir, { recursive: true });
    const older = {
      session_id: 'old', pipe_path: 'p', claude_pid: process.ppid, hook_pid: 1, created_at: Date.now() - 1000,
    };
    const newer = {
      session_id: 'new', pipe_path: 'p', claude_pid: process.ppid, hook_pid: 2, created_at: Date.now(),
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
    const mine = {
      session_id: 'mine', pipe_path: 'p', claude_pid: 9999, hook_pid: 1, created_at: Date.now(),
    };
    const theirs = {
      session_id: 'theirs', pipe_path: 'p', claude_pid: 7777, hook_pid: 2, created_at: Date.now() + 5,
    };
    writeFileSync(join(dir, `9999-1.json`), JSON.stringify(mine));
    writeFileSync(join(dir, `7777-2.json`), JSON.stringify(theirs));
    const result = await readActiveTicket({ claudePid: 9999 });
    assert.equal(result.session_id, 'mine');
  });
});

test('readActiveTicket with maxAgeMs excludes stale tickets (by file mtime)', async () => {
  // Freshness is checked against file mtime, not JSON's created_at — the
  // MCP daemon's heartbeat updates mtime but never rewrites created_at.
  // Backdate the file mtime to simulate a ticket whose daemon stopped
  // touching it (i.e., the daemon is genuinely gone).
  await withTmp(async () => {
    const dir = tdir();
    mkdirSync(dir, { recursive: true });
    const stale = {
      session_id: 'stale', pipe_path: 'p', claude_pid: process.ppid, hook_pid: 1,
      created_at: Date.now() - 60_000,
    };
    const fp = join(dir, `${process.ppid}-1.json`);
    writeFileSync(fp, JSON.stringify(stale));
    const oldSecs = (Date.now() - 60_000) / 1000;
    utimesSync(fp, oldSecs, oldSecs);
    const result = await readActiveTicket({ claudePid: process.ppid, maxAgeMs: 1000 });
    assert.equal(result, null);
  });
});

test('readActiveTicket considers a ticket fresh when mtime is fresh, even with old created_at (regression)', async () => {
  // Regression: a long-running session's daemon heartbeat keeps file mtime
  // fresh while created_at stays at the original write time. The old
  // freshness check used created_at and would falsely consider such a
  // ticket stale after maxAgeMs, breaking seed-from-repo's session id
  // attribution (rows would land under FALLBACK_SEED_SESSION_ID instead
  // of the live session, so default /mindwright:dream wouldn't drain
  // them). Fixed by switching the filter to st.mtimeMs.
  await withTmp(async () => {
    const dir = tdir();
    mkdirSync(dir, { recursive: true });
    const ticket = {
      session_id: 'live-long-session',
      pipe_path: 'p',
      claude_pid: process.ppid,
      hook_pid: 99,
      created_at: Date.now() - 60 * 60_000, // 60 minutes ago
    };
    const fp = join(dir, `${process.ppid}-99.json`);
    writeFileSync(fp, JSON.stringify(ticket));
    // Leave mtime fresh (the daemon's heartbeat just touched it).
    const result = await readActiveTicket({ claudePid: process.ppid, maxAgeMs: 10 * 60_000 });
    assert.ok(result, 'fresh-mtime ticket must not be filtered out');
    assert.equal(result.session_id, 'live-long-session');
  });
});

test('readActiveTicket skips .tmp.* partials and unparseable JSON', async () => {
  await withTmp(async () => {
    const dir = tdir();
    mkdirSync(dir, { recursive: true });
    // A partial tmp file masquerading as a ticket (writeTicket guards against
    // this by using rename, but defense in depth on the read side too).
    writeFileSync(join(dir, `${process.ppid}-1.json.tmp.1234`), '{}');
    // An unparseable .json file.
    writeFileSync(join(dir, `${process.ppid}-2.json`), '{ not valid json');
    // A valid ticket too.
    const valid = {
      session_id: 'valid', pipe_path: 'p', claude_pid: process.ppid, hook_pid: 3, created_at: Date.now(),
    };
    writeFileSync(join(dir, `${process.ppid}-3.json`), JSON.stringify(valid));
    const result = await readActiveTicket({ claudePid: process.ppid });
    assert.equal(result.session_id, 'valid');
  });
});

// ---------------------------------------------------------------
// cleanupStaleTickets
// ---------------------------------------------------------------

test('cleanupStaleTickets removes tickets past maxAgeMs (by file mtime) and returns the count', async () => {
  // Mirrors readActiveTicket's mtime-based freshness check: a ticket whose
  // file mtime is past maxAgeMs is removed; one with fresh mtime survives,
  // even if its JSON's created_at is old (long-running daemon case).
  await withTmp(async () => {
    const dir = tdir();
    mkdirSync(dir, { recursive: true });
    const fresh = {
      session_id: 'f', pipe_path: 'p', claude_pid: process.ppid, hook_pid: 1, created_at: Date.now(),
    };
    const stale = {
      session_id: 's', pipe_path: 'p', claude_pid: process.ppid, hook_pid: 2, created_at: Date.now() - 60_000,
    };
    writeFileSync(join(dir, `${process.ppid}-1.json`), JSON.stringify(fresh));
    const stalePath = join(dir, `${process.ppid}-2.json`);
    writeFileSync(stalePath, JSON.stringify(stale));
    // Backdate mtime of the "stale" ticket so it's actually stale on disk.
    const oldSecs = (Date.now() - 60_000) / 1000;
    utimesSync(stalePath, oldSecs, oldSecs);
    const removed = await cleanupStaleTickets(1000);
    assert.equal(removed, 1);
    // Fresh ticket survives.
    const remaining = readdirSync(dir).filter((f) => f.endsWith('.json'));
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0], `${process.ppid}-1.json`);
  });
});

test('cleanupStaleTickets preserves a ticket with old created_at but fresh mtime (regression)', async () => {
  // Regression mirror of readActiveTicket: a long-running daemon's ticket
  // has stale created_at but fresh mtime. Cleanup must not yank it out
  // from under the running daemon.
  await withTmp(async () => {
    const dir = tdir();
    mkdirSync(dir, { recursive: true });
    const longRunner = {
      session_id: 'long', pipe_path: 'p', claude_pid: process.ppid, hook_pid: 1,
      created_at: Date.now() - 60 * 60_000, // 60 min ago
    };
    writeFileSync(join(dir, `${process.ppid}-1.json`), JSON.stringify(longRunner));
    // Leave mtime fresh — the daemon just touched the file.
    const removed = await cleanupStaleTickets(10 * 60_000);
    assert.equal(removed, 0, 'fresh-mtime ticket must not be removed by cleanup');
    const remaining = readdirSync(dir).filter((f) => f.endsWith('.json'));
    assert.equal(remaining.length, 1);
  });
});

test('cleanupStaleTickets treats unparseable tickets as stale', async () => {
  await withTmp(async () => {
    const dir = tdir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `1-1.json`), 'not json');
    writeFileSync(join(dir, `1-2.json`), '{"created_at": "not-a-number"}');
    const removed = await cleanupStaleTickets(60_000);
    assert.equal(removed, 2);
    assert.equal(readdirSync(dir).filter((f) => f.endsWith('.json')).length, 0);
  });
});

test('cleanupStaleTickets returns 0 on missing ticket dir', async () => {
  await withTmp(async () => {
    const removed = await cleanupStaleTickets(60_000);
    assert.equal(removed, 0);
  });
});

test('cleanupStaleTickets removes orphan .tmp.<pid> files past maxAgeMs (mtime-gated)', async () => {
  // Regression: writeTicket crashes between writeFile() and rename() can
  // leave `.tmp.<pid>` files behind. The previous cleanup only inspected
  // `*.json`, so those orphans accumulated in the tickets dir forever.
  // The fix gates them by mtime since the tmp file content isn't trusted
  // to parse.
  await withTmp(async () => {
    const dir = tdir();
    mkdirSync(dir, { recursive: true });
    // Plant an orphan tmp file and backdate its mtime past the cleanup window.
    const tmpName = `9999-1.json.tmp.12345`;
    const tmpPath = join(dir, tmpName);
    writeFileSync(tmpPath, '{ partial');
    const { utimesSync } = await import('node:fs');
    const oldMtime = (Date.now() - 60_000) / 1000;
    utimesSync(tmpPath, oldMtime, oldMtime);

    // A FRESH tmp file (mtime = now) — must be left alone, write could be
    // in-flight from a peer hook right now.
    const freshTmp = `9999-2.json.tmp.67890`;
    writeFileSync(join(dir, freshTmp), '{ in-flight');

    const removed = await cleanupStaleTickets(1000);
    assert.equal(removed, 1, 'must remove the stale tmp orphan');

    const remaining = readdirSync(dir);
    assert.ok(!remaining.includes(tmpName), 'stale tmp must be gone');
    assert.ok(remaining.includes(freshTmp), 'fresh in-flight tmp must survive');
  });
});
