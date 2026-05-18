// Ticket files recording the active Claude session.
//
// On SessionStart, `hooks/session-start.js` calls `writeTicket()` with the
// session_id. Scripts (e.g. seed-from-repo) call `readActiveTicket()` for
// session-id discovery, and session-liveness.js#isSessionLive() uses the
// recorded Claude CLI PID for liveness.
//
// Filenames encode both the Claude CLI pid (process.ppid for hooks) and the
// hook's own pid so two SessionStart hooks sharing one shell never collide.
//
// Liveness is PID-based, NOT mtime-based: the ticket is written once at
// SessionStart and nothing heartbeats it (the long-lived per-session MCP
// daemon that used to touch its mtime was deleted). A live PID never goes
// stale while the process runs, so no refresh is needed; a dead PID is a
// crashed/closed session's orphan.

import { writeFile, readFile, readdir, unlink, mkdir, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { ticketsDir } from './paths.js';
import { DAEMON_TICKET_MAX_AGE_MS } from './constants.js';
import { isPidAlive } from './session-liveness.js';

// Only `.tmp.<pid>` write-crash orphans are time-swept now (they have no
// usable PID/JSON to probe); live `.json` tickets are kept/dropped purely by
// PID liveness, so this bound never races a live session.
const TMP_ORPHAN_MAX_AGE_MS = DAEMON_TICKET_MAX_AGE_MS;

function ticketFilename(claudePid, hookPid) {
  return `${claudePid}-${hookPid}.json`;
}

// Absolute path of the ticket file for a given (claudePid, hookPid) key.
export function ticketPathFor(claudePid, hookPid) {
  return join(ticketsDir(), ticketFilename(claudePid, hookPid));
}

/**
 * Write a ticket binding this hook's parent Claude CLI process to a
 * mindwright session.
 *
 * @param {object} args
 * @param {string} args.sessionId
 * @returns {Promise<string>} absolute path of the ticket written
 */
export async function writeTicket({ sessionId }) {
  if (!sessionId) throw new Error('writeTicket: sessionId required');
  const dir = ticketsDir();
  await mkdir(dir, { recursive: true });
  const claudePid = process.ppid;
  const hookPid = process.pid;
  const ticket = {
    session_id: sessionId,
    claude_pid: claudePid,
    hook_pid: hookPid,
    created_at: Date.now(),
  };
  const finalPath = join(dir, ticketFilename(claudePid, hookPid));
  const tmpPath = `${finalPath}.tmp.${process.pid}`;
  await writeFile(tmpPath, JSON.stringify(ticket));
  await rename(tmpPath, finalPath);
  return finalPath;
}

/**
 * Read the most recent ticket whose Claude CLI process is still alive.
 * Optionally restrict to tickets written by a specific Claude CLI pid.
 *
 * Liveness is `isPidAlive(claude_pid)`, NOT file mtime: a long-running
 * session writes its ticket once at SessionStart and nothing refreshes it,
 * so an mtime window would drop a live session 10+ min in and orphan its
 * seed rows under FALLBACK_SEED_SESSION_ID. Among the live tickets the most
 * recently created wins, so a fresh session always beats a stale straggler.
 *
 * @param {object} [opts]
 * @param {number|null} [opts.claudePid] only consider tickets whose claude_pid matches
 * @returns {Promise<object|null>} the ticket record, or null
 */
export async function readActiveTicket({ claudePid = null } = {}) {
  const dir = ticketsDir();
  let files;
  try {
    files = await readdir(dir);
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
  let best = null;
  for (const f of files) {
    if (!f.endsWith('.json') || f.includes('.tmp.')) continue;
    const fp = join(dir, f);
    let data;
    try {
      const raw = await readFile(fp, 'utf8');
      data = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!data || !data.session_id || typeof data.created_at !== 'number') continue;
    if (typeof data.claude_pid !== 'number' || !isPidAlive(data.claude_pid)) continue;
    if (claudePid !== null && data.claude_pid !== claudePid) continue;
    if (!best || data.created_at > best.created_at) best = data;
  }
  return best;
}

/**
 * Delete orphaned tickets. A `.json` ticket is orphaned when its Claude CLI
 * PID is dead (or it has no probeable PID / is unparseable) — mtime is NOT
 * consulted, so a long-lived session's never-refreshed ticket is never
 * reaped while it runs. `.tmp.<pid>` write-crash leftovers have no usable
 * PID/JSON, so those alone are time-swept. Returns the count removed; per-
 * unlink errors are swallowed (best-effort).
 *
 * @returns {Promise<number>}
 */
export async function cleanupStaleTickets() {
  const dir = ticketsDir();
  let files;
  try {
    files = await readdir(dir);
  } catch (err) {
    if (err && err.code === 'ENOENT') return 0;
    throw err;
  }
  const now = Date.now();
  let removed = 0;
  for (const f of files) {
    const fp = join(dir, f);
    // Orphan `.tmp.<pid>` files left when writeTicket crashed between
    // writeFile and rename. Time-swept (their JSON may not parse).
    if (f.includes('.tmp.')) {
      try {
        const st = await stat(fp);
        if (now - st.mtimeMs > TMP_ORPHAN_MAX_AGE_MS) {
          await unlink(fp);
          removed++;
        }
      } catch {
        // Race: another cleanup pass got here first, or it disappeared.
      }
      continue;
    }
    if (!f.endsWith('.json')) continue;
    let data = null;
    try {
      const raw = await readFile(fp, 'utf8');
      data = JSON.parse(raw);
    } catch {
      // Unparseable ticket — treat as orphaned.
    }
    const orphaned =
      !data ||
      typeof data.claude_pid !== 'number' ||
      !isPidAlive(data.claude_pid);
    if (orphaned) {
      try {
        await unlink(fp);
        removed++;
      } catch {
        // Race: another cleanup pass got here first.
      }
    }
  }
  return removed;
}
