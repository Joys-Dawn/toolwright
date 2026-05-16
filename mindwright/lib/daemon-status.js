// Single source of truth for "is a mindwright daemon currently bound to this
// project root?". Both the MCP server's status tool and the script-side
// `/mindwright:status` and `/mindwright:reset` need this check; duplicating
// the freshness window across three files invites drift if the SessionStart
// hook ever changes how it writes tickets.
//
// The check is a layered proxy:
//   1. Ticket file mtime freshness — every session-start writes a ticket and
//      the daemon keeps it touched. mtime older than the freshness window
//      means a stale ticket from a crashed or killed session.
//   2. Claude CLI process liveness (claude_pid in the ticket JSON) — even
//      within the freshness window, a daemon that died seconds ago (user
//      closed Claude Code, OS killed the process, etc.) is verifiably dead
//      via process.kill(pid, 0). Without this shortcut the user has to wait
//      out the full freshness window before /mindwright:reset will proceed.

import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ticketsDir } from './paths.js';
import { DAEMON_TICKET_MAX_AGE_MS } from './constants.js';

const FRESH_MS = DAEMON_TICKET_MAX_AGE_MS;

// Cross-platform PID liveness probe. process.kill(pid, 0) is the standard
// "does this process exist" check on POSIX; Node implements it on Windows
// too. ESRCH means the process is gone; EPERM means the process exists but
// we can't signal it (still alive). Anything else we treat as alive to err
// on the safe side — refusing a reset is less destructive than allowing one
// against a running daemon.
export function isPidAlive(pid) {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e && e.code === 'EPERM';
  }
}

export function isDaemonAlive() {
  try {
    const dir = ticketsDir();
    const files = readdirSync(dir);
    const now = Date.now();
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      const path = join(dir, f);
      let st;
      try { st = statSync(path); } catch { continue; }
      if (now - st.mtimeMs >= FRESH_MS) continue; // stale ticket; skip
      // Fresh ticket. Cross-check the Claude CLI PID — if it's verifiably
      // dead, this ticket is orphaned (user closed Claude before reset).
      let ticket;
      try { ticket = JSON.parse(readFileSync(path, 'utf8')); } catch {
        // Unparseable ticket — conservative true (assume a daemon).
        return true;
      }
      // Missing claude_pid (older ticket format, or hand-planted) →
      // conservative true. We don't have enough info to verify deadness.
      if (typeof ticket.claude_pid !== 'number') return true;
      if (isPidAlive(ticket.claude_pid)) return true;
      // Fresh mtime but dead claude_pid — daemon already gone, fall through
      // to check any remaining tickets.
    }
  } catch {
    // ENOENT on the tickets dir → never spawned, no daemon.
  }
  return false;
}
