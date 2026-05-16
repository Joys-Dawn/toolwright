// session-bind: resolve the MCP server's own session_id by reading the
// ticket that session-start.js wrote. Pattern is adapted from
// wrightward/mcp/session-bind.mjs but simpler — mindwright daemons live
// and die with the MCP server process, so there's no resume-detection
// state machine to maintain.
//
// Strategy:
//   1. Poll ticketsDir() for a ticket whose claude_pid matches process.ppid.
//      That's the normal POSIX case (the hook and the MCP server share a
//      direct Claude CLI parent).
//   2. If the ppid match never lands within `timeoutMs`, fall back to the
//      most-recent ticket in the freshness window. This handles Windows
//      cases where process.ppid points at an intermediate shell rather
//      than the Claude CLI process. Only takes the fallback if exactly one
//      candidate exists, to avoid silent cross-binding when two sessions
//      are starting in parallel.

import { readActiveTicket, ticketPathFor } from './daemon-ticket.mjs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ticketsDir } from '../lib/paths.js';
import { isPidAlive } from '../lib/daemon-status.js';

const POLL_INTERVAL_MS = 100;
const DEFAULT_TIMEOUT_MS = 5000;
const FALLBACK_FRESHNESS_MS = 10_000;
// Maximum age of a fallback ticket relative to our daemon's start time.
// SessionStart writes the ticket within milliseconds-to-seconds before the
// MCP daemon is launched, so a "ours" ticket should be very close to the
// daemon's start time. A ticket much older than this — even if it's the
// only one in the freshness window — likely belongs to a different session
// whose daemon ALSO failed to ppid-match, and binding to it would silently
// cross-route writes. Tighter than FALLBACK_FRESHNESS_MS on purpose.
const FALLBACK_RELATIVE_MAX_AGE_MS = 4_000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Count tickets within the fallback freshness window. Used to refuse the
 * fallback bind when more than one candidate exists — silent misrouting
 * is worse than staying unbound and surfacing the issue at the first tool
 * call.
 */
async function countRecentTickets() {
  const dir = ticketsDir();
  let files;
  try {
    files = await readdir(dir);
  } catch (err) {
    if (err && err.code === 'ENOENT') return 0;
    throw err;
  }
  const now = Date.now();
  let count = 0;
  for (const f of files) {
    if (!f.endsWith('.json') || f.includes('.tmp.')) continue;
    try {
      const raw = await readFile(join(dir, f), 'utf8');
      const data = JSON.parse(raw);
      if (
        data &&
        data.session_id &&
        typeof data.created_at === 'number' &&
        now - data.created_at <= FALLBACK_FRESHNESS_MS
      ) {
        count++;
      }
    } catch {
      // ignore unparseable
    }
  }
  return count;
}

/**
 * Bind this process to its session_id by reading a ticket written by the
 * SessionStart hook.
 *
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs] how long to poll for a ppid-match (default 5s)
 * @returns {Promise<{sessionId: string, ticketPath: string}|null>} the
 *   resolved binding (session_id + absolute ticket path so the MCP daemon
 *   can keep its own ticket fresh), or null if no ticket appeared in time
 *   and no unambiguous fallback existed.
 */
export async function bindOwnSession({ timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const claudePid = process.ppid;
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const ticket = await readActiveTicket({ claudePid });
    if (ticket) {
      process.stderr.write(
        `[mindwright/session-bind] bound to session ${ticket.session_id} via ppid ${claudePid}\n`
      );
      return {
        sessionId: ticket.session_id,
        ticketPath: ticketPathFor(ticket.claude_pid, ticket.hook_pid),
      };
    }
    await sleep(POLL_INTERVAL_MS);
  }

  // Fallback: tolerate Windows-shell ppid mismatches, but ONLY when:
  //   (a) exactly one ticket is in the freshness window (no ambiguity), AND
  //   (b) the ticket's claude_pid is still alive (it's not a stale leftover),
  //       AND
  //   (c) the ticket was written within FALLBACK_RELATIVE_MAX_AGE_MS of our
  //       daemon's start time (so it's plausibly OUR SessionStart's ticket,
  //       not another session's that happens to be the only fresh one).
  // Refuse any other case — unbound mode is safer than silently authoring
  // rows under another session's id.
  const recentCount = await countRecentTickets();
  if (recentCount === 1) {
    const ticket = await readActiveTicket({ maxAgeMs: FALLBACK_FRESHNESS_MS });
    if (ticket) {
      const claudeAlive = isPidAlive(ticket.claude_pid);
      const ageRelToStart = start - Number(ticket.created_at);
      const closeEnough =
        Number.isFinite(ageRelToStart) &&
        ageRelToStart >= -1_000 && // tolerate small clock skew either way
        ageRelToStart <= FALLBACK_RELATIVE_MAX_AGE_MS;
      if (claudeAlive && closeEnough) {
        process.stderr.write(
          `[mindwright/session-bind] bound to session ${ticket.session_id} via fallback scan ` +
            `(ppid ${claudePid} did not match any ticket; unique candidate accepted, ` +
            `claude_pid ${ticket.claude_pid} alive, age ${ageRelToStart}ms)\n`
        );
        return {
          sessionId: ticket.session_id,
          ticketPath: ticketPathFor(ticket.claude_pid, ticket.hook_pid),
        };
      }
      process.stderr.write(
        `[mindwright/session-bind] refusing fallback bind to ${ticket.session_id}: ` +
          `claude_pid_alive=${claudeAlive} age_rel_to_start=${ageRelToStart}ms ` +
          `(safer to stay unbound than cross-route to another session)\n`
      );
    }
  } else if (recentCount > 1) {
    process.stderr.write(
      `[mindwright/session-bind] refusing fallback bind: ${recentCount} recent tickets are ambiguous — ` +
        `staying unbound to avoid cross-routing\n`
    );
  }

  process.stderr.write(
    `[mindwright/session-bind] no ticket found after ${timeoutMs}ms — entering unbound mode\n`
  );
  return null;
}
