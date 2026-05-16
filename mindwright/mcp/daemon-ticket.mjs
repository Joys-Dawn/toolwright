// Ticket files binding a SessionStart hook to the in-process MCP daemon.
//
// On SessionStart, `hooks/session-start.js` calls `writeTicket()` with the
// session_id (from the hook input) and the pipe path (`pipePath(sessionId)`).
// On MCP startup, `mcp/session-bind.mjs` calls `readActiveTicket()` to find
// the matching ticket via process.ppid correlation, then connects the daemon
// to that session.
//
// Pattern mirrored from wrightward/lib/mcp-ticket.js. Filenames encode both
// the Claude CLI pid (process.ppid for hooks) and the hook's own pid so two
// SessionStart hooks sharing one shell never collide on the same ticket key.

import { writeFile, readFile, readdir, unlink, mkdir, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { ticketsDir } from '../lib/paths.js';
import { DAEMON_TICKET_MAX_AGE_MS } from '../lib/constants.js';

const DEFAULT_MAX_AGE_MS = DAEMON_TICKET_MAX_AGE_MS;

function ticketFilename(claudePid, hookPid) {
  return `${claudePid}-${hookPid}.json`;
}

// Absolute path of the ticket file for a given (claudePid, hookPid) key.
// The MCP daemon needs this so it can `utimesSync` its own ticket on a
// periodic heartbeat — without that, isDaemonAlive() falsely reports
// dead 10 minutes into a live session and reset.js will happily delete
// the DB out from under the running daemon.
export function ticketPathFor(claudePid, hookPid) {
  return join(ticketsDir(), ticketFilename(claudePid, hookPid));
}

/**
 * Write a ticket binding this hook's parent Claude CLI process to a
 * mindwright session.
 *
 * @param {object} args
 * @param {string} args.sessionId
 * @param {string} args.pipePath
 * @returns {Promise<string>} absolute path of the ticket written
 */
export async function writeTicket({ sessionId, pipePath }) {
  if (!sessionId) throw new Error('writeTicket: sessionId required');
  if (!pipePath) throw new Error('writeTicket: pipePath required');
  const dir = ticketsDir();
  await mkdir(dir, { recursive: true });
  const claudePid = process.ppid;
  const hookPid = process.pid;
  const ticket = {
    session_id: sessionId,
    pipe_path: pipePath,
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
 * Read the most recent valid ticket. Optionally restrict to tickets written
 * by a specific Claude CLI pid (matches by `claude_pid`) — the MCP daemon's
 * session-bind uses this with `process.ppid` to find its own ticket.
 *
 * @param {object} [opts]
 * @param {number} [opts.maxAgeMs] discard tickets older than this (default 10m)
 * @param {number|null} [opts.claudePid] only consider tickets whose claude_pid matches
 * @returns {Promise<object|null>} the ticket record, or null
 */
export async function readActiveTicket({
  maxAgeMs = DEFAULT_MAX_AGE_MS,
  claudePid = null,
} = {}) {
  const dir = ticketsDir();
  let files;
  try {
    files = await readdir(dir);
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
  const now = Date.now();
  let best = null;
  for (const f of files) {
    if (!f.endsWith('.json') || f.includes('.tmp.')) continue;
    const fp = join(dir, f);
    // Freshness via file mtime, NOT data.created_at. The MCP daemon keeps
    // its ticket alive by `utimesSync` (server.mjs) — it never rewrites the
    // JSON's created_at field. Using created_at here makes any session
    // older than maxAgeMs look stale even while its daemon is actively
    // touching mtime; isDaemonAlive() reads mtime, so the two checks
    // diverge after the first heartbeat. Most visible failure:
    // seed-from-repo running 10+ min into a live session would silently
    // fall back to the synthetic FALLBACK_SEED_SESSION_ID and orphan
    // its seed rows away from the user's /mindwright:dream scope=session.
    let st;
    try { st = await stat(fp); } catch { continue; }
    if (now - st.mtimeMs > maxAgeMs) continue;
    let data;
    try {
      const raw = await readFile(fp, 'utf8');
      data = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!data || !data.session_id || typeof data.created_at !== 'number') continue;
    if (claudePid !== null && data.claude_pid !== claudePid) continue;
    if (!best || data.created_at > best.created_at) best = data;
  }
  return best;
}

/**
 * Delete tickets older than `maxAgeMs`. Returns the count removed.
 * Errors on individual unlinks are swallowed — best-effort cleanup.
 *
 * @param {number} [maxAgeMs] default 10 minutes
 * @returns {Promise<number>}
 */
export async function cleanupStaleTickets(maxAgeMs = DEFAULT_MAX_AGE_MS) {
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
    // Orphan `.tmp.<pid>` files left behind when writeTicket crashed
    // between writeFile and rename — clean them too. They never end in
    // .json, so the old gate dropped them and they accumulated forever.
    // Filter by mtime since we can't trust the tmp file's JSON to parse.
    if (f.includes('.tmp.')) {
      try {
        const st = await stat(fp);
        if (now - st.mtimeMs > maxAgeMs) {
          await unlink(fp);
          removed++;
        }
      } catch {
        // Race: another cleanup pass got here first, or it disappeared.
      }
      continue;
    }
    if (!f.endsWith('.json')) continue;
    // Same divergence concern as readActiveTicket: mtime is what the daemon
    // heartbeat actually updates. A long-running session whose JSON
    // created_at is past maxAgeMs but whose mtime is fresh must NOT be
    // considered stale — its daemon is alive and its ticket is in use.
    let st;
    try { st = await stat(fp); } catch { continue; }
    let data = null;
    try {
      const raw = await readFile(fp, 'utf8');
      data = JSON.parse(raw);
    } catch {
      // Unparseable ticket — treat as stale.
    }
    const stale =
      !data ||
      typeof data.created_at !== 'number' ||
      now - st.mtimeMs > maxAgeMs;
    if (stale) {
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
