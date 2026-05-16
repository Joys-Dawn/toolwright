// Coverage for bindOwnSession() — the MCP daemon's only mechanism for
// discovering its own session id at startup. The three branches matter
// because a silent mis-bind would route writes to the wrong session
// across two parallel Claude sessions; the test pins each one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bindOwnSession } from '../../mcp/session-bind.mjs';
import { ticketsDir } from '../../lib/paths.js';

async function withTmp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'mindwright-bind-'));
  // Snapshot the prior MINDWRIGHT_PROJECT_ROOT so we can restore it. Without
  // this, the env var leaks across test files: a subsequent test (or any
  // code in the same node --test invocation) reads a path that was just
  // rmsync'd, and the next mkdir at that ghost path creates state in the
  // wrong location. Every other test helper in this suite snapshots-and-
  // restores this var — match that pattern here.
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

function plantTicket({ claudePid, hookPid, sessionId, ageMs = 0 }) {
  const dir = ticketsDir();
  mkdirSync(dir, { recursive: true });
  const ticket = {
    session_id: sessionId,
    pipe_path: '\\\\.\\pipe\\test',
    claude_pid: claudePid,
    hook_pid: hookPid,
    created_at: Date.now() - ageMs,
  };
  writeFileSync(join(dir, `${claudePid}-${hookPid}.json`), JSON.stringify(ticket));
}

// ---------------------------------------------------------------
// Branch 1: direct ppid match
// ---------------------------------------------------------------

test('bindOwnSession returns {sessionId, ticketPath} when a ppid-matched ticket exists', async () => {
  await withTmp(async () => {
    plantTicket({
      claudePid: process.ppid,
      hookPid: 12345,
      sessionId: 'sess-ppid-match',
    });
    const result = await bindOwnSession({ timeoutMs: 500 });
    assert.equal(result?.sessionId, 'sess-ppid-match');
    // The daemon needs the absolute ticket path to keep its own ticket
    // fresh — without that, isDaemonAlive() falsely reports dead 10 min
    // into the session and reset.js destroys the live DB. Pin the
    // <ticketsDir>/<claudePid>-<hookPid>.json contract here.
    const expectedPath = join(ticketsDir(), `${process.ppid}-12345.json`);
    assert.equal(result?.ticketPath, expectedPath);
  });
});

// ---------------------------------------------------------------
// Branch 2: timeout, no fallback candidate
// ---------------------------------------------------------------

test('bindOwnSession returns null after timeout when no ticket appears', async () => {
  await withTmp(async () => {
    // No ticket planted.
    const result = await bindOwnSession({ timeoutMs: 200 });
    assert.equal(result, null);
  });
});

// ---------------------------------------------------------------
// Branch 3: Windows fallback — ppid mismatch, single fresh ticket
// ---------------------------------------------------------------

test('bindOwnSession Windows fallback: ppid mismatch + exactly one fresh, live ticket → bind', async () => {
  await withTmp(async () => {
    plantTicket({
      // Use process.pid — that pid is guaranteed alive (it's us) AND it is
      // NOT process.ppid (which is the test runner's parent), so we still
      // hit the fallback branch rather than the ppid-match branch.
      claudePid: process.pid,
      hookPid: 4321,
      sessionId: 'sess-windows-fallback',
    });
    const result = await bindOwnSession({ timeoutMs: 200 });
    assert.equal(result?.sessionId, 'sess-windows-fallback');
    // Fallback path must also expose the ticketPath so the touch loop
    // works on Windows where ppid-match fails.
    const expectedPath = join(ticketsDir(), `${process.pid}-4321.json`);
    assert.equal(result?.ticketPath, expectedPath);
  });
});

test('bindOwnSession refuses fallback when the lone ticket\'s claude_pid is dead', async () => {
  // Regression: previously the fallback bound to any unique fresh ticket,
  // even one written by a Claude CLI process that has since exited. That
  // path silently routes our writes under a different session's id when
  // OUR SessionStart hook crashed (no ticket) and another session's stale
  // ticket happens to be the only one in the freshness window.
  await withTmp(async () => {
    plantTicket({
      // 999999 is a synthetic pid that is almost certainly NOT a live
      // process on the test machine. isPidAlive(999999) → false → refuse.
      claudePid: 999999,
      hookPid: 4321,
      sessionId: 'sess-stale-pid',
    });
    const result = await bindOwnSession({ timeoutMs: 200 });
    assert.equal(result, null, 'must refuse fallback bind when claude_pid is dead');
  });
});

test('bindOwnSession refuses fallback when ticket is older than the relative-age window', async () => {
  // Regression: the absolute freshness window (10s) doesn't catch the
  // "another session's ticket that's only 6s old" case where ours never
  // got written. A relative-to-start check tightens this.
  await withTmp(async () => {
    plantTicket({
      claudePid: process.pid, // alive
      hookPid: 4321,
      sessionId: 'sess-too-old-rel',
      ageMs: 8_000, // within FALLBACK_FRESHNESS_MS but > FALLBACK_RELATIVE_MAX_AGE_MS
    });
    const result = await bindOwnSession({ timeoutMs: 200 });
    assert.equal(result, null, 'must refuse fallback bind when ticket is too old relative to daemon start');
  });
});

// ---------------------------------------------------------------
// Branch 4: ambiguous fallback refused — ppid mismatch, multiple fresh tickets
// ---------------------------------------------------------------

test('bindOwnSession refuses ambiguous fallback (>1 fresh tickets) → null', async () => {
  await withTmp(async () => {
    plantTicket({ claudePid: 111, hookPid: 1, sessionId: 'sess-a' });
    plantTicket({ claudePid: 222, hookPid: 2, sessionId: 'sess-b' });
    // Neither matches process.ppid, but BOTH are within FALLBACK_FRESHNESS_MS.
    // The fallback must refuse to bind to avoid silent cross-routing.
    const result = await bindOwnSession({ timeoutMs: 200 });
    assert.equal(result, null);
  });
});

// ---------------------------------------------------------------
// Branch 5: stale tickets don't count toward fallback ambiguity / candidacy
// ---------------------------------------------------------------

test('bindOwnSession ignores stale tickets past FALLBACK_FRESHNESS_MS', async () => {
  await withTmp(async () => {
    // The fresh ticket would normally trigger Windows fallback — but the
    // stale ticket should NOT count toward the recent-ticket total, so the
    // fresh one is still the unique candidate. The fresh one's claude_pid
    // must be ALIVE (and pass the relative-age check) for the bind to land,
    // so we use process.pid.
    plantTicket({ claudePid: 111, hookPid: 1, sessionId: 'stale-one', ageMs: 30_000 });
    plantTicket({ claudePid: process.pid, hookPid: 2, sessionId: 'fresh-one' });
    const result = await bindOwnSession({ timeoutMs: 200 });
    assert.equal(result?.sessionId, 'fresh-one', 'stale ticket must not contribute to the count');
  });
});
