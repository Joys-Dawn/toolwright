// Is a Claude session actively bound to this project root?
//
// NOT a daemon probe (the per-session MCP daemon this used to track was
// deleted in the MCP→model-daemon refactor; the machine-wide model daemon
// has its own liveness signal — see model-daemon-status.js). This answers
// exactly one question: "is a live Claude CLI process bound to this project
// via a session ticket?" — consumed by /mindwright:reset (refuse to delete a
// DB a live session is using) and /mindwright:status.
//
// Liveness is the ticket's recorded Claude CLI PID, probed with
// process.kill(pid, 0). There is deliberately NO mtime/freshness window: the
// old architecture kept the ticket's mtime touched by a long-lived per-session
// MCP daemon; that daemon is gone and nothing heartbeats the ticket, so an
// mtime window false-negatives ~10 min into every real session (it deleted
// live DBs — see the cluster this replaced). A live PID cannot go stale while
// the process runs, so it needs no refresh. A missing/garbage/dead-PID ticket
// contributes nothing here (it is NOT treated as conservatively-alive — with
// no mtime there is nothing to age such a turd out, and the destructive path
// in reset.js has its own OS-enforced backstop: the SQLite BEGIN EXCLUSIVE
// in-use probe, lib/db-in-use.js).

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ticketsDir } from './paths.js';

// Cross-platform PID liveness probe. process.kill(pid, 0) is the standard
// "does this process exist" check on POSIX; Node implements it on Windows
// too. ESRCH means the process is gone; EPERM means the process exists but
// we can't signal it (still alive). Anything else we treat as alive to err
// on the safe side — refusing a reset is less destructive than allowing one
// against a running session.
export function isPidAlive(pid) {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e && e.code === 'EPERM';
  }
}

// True iff some ticket records a Claude CLI PID that is still alive. A ticket
// with no numeric claude_pid, or unparseable JSON, is skipped — we cannot
// verify a live owner from it, and (unlike the old mtime design) there is no
// freshness window that would eventually expire it, so treating it as alive
// would wedge reset forever. The reset guard pairs this with db-in-use.js so
// an actively-locked DB is still caught even when no ticket names a live PID.
export function isSessionLive() {
  try {
    const dir = ticketsDir();
    const files = readdirSync(dir);
    for (const f of files) {
      if (!f.endsWith('.json') || f.includes('.tmp.')) continue;
      const path = join(dir, f);
      let ticket;
      try {
        ticket = JSON.parse(readFileSync(path, 'utf8'));
      } catch {
        continue; // unparseable — can't verify a live owner from it
      }
      if (typeof ticket.claude_pid !== 'number') continue;
      if (isPidAlive(ticket.claude_pid)) return true;
      // Recorded PID is verifiably dead — this ticket is an orphan from a
      // crashed/closed session; keep scanning the rest.
    }
  } catch {
    // ENOENT on the tickets dir → never spawned, no session bound.
  }
  return false;
}
