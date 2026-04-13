/**
 * MCP session binding module.
 *
 * Resolves the session ID for this MCP server by correlating with the
 * SessionStart hook via process.ppid. The hook writes a ticket file at
 * .claude/collab/mcp-bindings/<claudePid>.json. This module polls for
 * that file and reads the session_id.
 *
 * Exports: createSessionBinder(collabDir) → { bind, getSessionId, isBound, refreshBinding }
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const fs = require('fs');
const path = require('path');
const { atomicWriteJson } = require('../lib/atomic-write');
const { withAgentsLock } = require('../lib/agents');
const { bindingsDir: mcpBindingsDir, ppidPrefix } = require('../lib/mcp-ticket');

const POLL_INTERVAL_MS = 100;
const POLL_TIMEOUT_MS = 5000;
const RETRY_INTERVAL_MS = 30000;
// Cap late-bind polling. A server running in a cwd with no wrightward
// collab dir will never receive a ticket; 10 × 30s = 5min is enough to
// absorb a slow SessionStart hook without burning CPU forever.
const RETRY_MAX_ATTEMPTS = 10;

export function createSessionBinder(collabDir) {
  let boundSessionId = null;
  let ticketPath = null;
  let retryTimer = null;

  const claudePid = process.ppid;
  const bindingsDir = mcpBindingsDir(collabDir);

  /**
   * Attempts to bind by polling for a ticket matching this process's parent pid.
   * Tickets are keyed <claudePid>-<hookPid>.json so two sessions sharing an
   * intermediate shell (Windows) do not collide — we pick the newest unclaimed.
   * Falls back to scanning across all ppids if no match is found (covers the
   * Windows case where process.ppid is the shell rather than the Claude CLI).
   */
  async function bind() {
    const start = Date.now();

    while (Date.now() - start < POLL_TIMEOUT_MS) {
      const claimed = tryClaimByPpid();
      if (claimed) {
        boundSessionId = claimed.sessionId;
        ticketPath = claimed.ticketPath;
        process.stderr.write('[wrightward-mcp] bound to session ' + claimed.sessionId + ' via ppid ' + claudePid + '\n');
        return;
      }
      await sleep(POLL_INTERVAL_MS);
    }

    const fallbackResult = tryFallbackScan();
    if (fallbackResult) {
      boundSessionId = fallbackResult.sessionId;
      ticketPath = fallbackResult.ticketPath;
      // Fallback only binds when exactly one candidate ticket exists — the
      // requireUnique guard in scanAndClaim refuses ambiguous cases so we
      // never silently misroute across concurrent sessions.
      process.stderr.write('[wrightward-mcp] bound to session ' + fallbackResult.sessionId +
        ' via fallback scan (ppid correlation unavailable; unique candidate)\n');
      return;
    }

    process.stderr.write('[wrightward-mcp] no binding ticket found after ' + POLL_TIMEOUT_MS + 'ms — entering unbound mode\n');
    scheduleRetry();
  }

  /**
   * Atomic read-check-claim over tickets matching `predicate`. Caller-supplied
   * predicate determines which tickets are eligible (ppid-match, freshness
   * window, etc). Returns { sessionId, ticketPath } on success, null otherwise.
   * Serialized under withAgentsLock so two concurrent MCP servers cannot
   * both claim the same ticket.
   *
   * When `requireUnique` is true, scanAndClaim refuses to claim if more than
   * one ticket matches the predicate. Used by the fallback scan where picking
   * newest-by-time could silently cross-bind concurrent sessions on Windows
   * shared shells — better to stay unbound and error on tool calls than route
   * messages to the wrong session.
   */
  function scanAndClaim(predicate, op, requireUnique = false) {
    let claimed = null;
    try {
      withAgentsLock(collabDir, () => {
        let files;
        try {
          files = fs.readdirSync(bindingsDir);
        } catch (err) {
          if (err.code !== 'ENOENT') {
            process.stderr.write('[wrightward-mcp] ' + op + ' readdir: ' + err.message + '\n');
          }
          return;
        }

        let best = null;
        let bestTs = 0;
        let matchCount = 0;

        for (const file of files) {
          if (!file.endsWith('.json')) continue;
          const fp = path.join(bindingsDir, file);
          let data;
          try {
            data = JSON.parse(fs.readFileSync(fp, 'utf8'));
          } catch (err) {
            if (err.code !== 'ENOENT') {
              process.stderr.write('[wrightward-mcp] ' + op + ' parse ' + file + ': ' + err.message + '\n');
            }
            continue;
          }
          if (!data || !data.session_id || data.claimed) continue;
          if (!predicate(file, data)) continue;
          matchCount++;
          if (data.created_at > bestTs) {
            best = { sessionId: data.session_id, file, data };
            bestTs = data.created_at;
          }
        }

        if (requireUnique && matchCount > 1) {
          process.stderr.write('[wrightward-mcp] ' + op + ' refusing to bind: ' +
            matchCount + ' candidate tickets are ambiguous — staying unbound to avoid ' +
            'misrouting. Launch sessions further apart or ensure process.ppid matches ' +
            'the hook-writing process.\n');
          return;
        }

        if (best) {
          const fp = path.join(bindingsDir, best.file);
          atomicWriteJson(fp, {
            ...best.data,
            claimed: true,
            mcp_pid: process.pid
          });
          claimed = { sessionId: best.sessionId, ticketPath: fp };
        }
      });
    } catch (err) {
      process.stderr.write('[wrightward-mcp] ' + op + ' failed: ' + (err.message || err) + '\n');
      return null;
    }
    return claimed;
  }

  /** Finds tickets whose filename starts with <claudePid>- and picks the newest unclaimed. */
  function tryClaimByPpid() {
    const prefix = ppidPrefix(claudePid);
    return scanAndClaim(
      (file) => file.startsWith(prefix),
      'tryClaimByPpid'
    );
  }

  /**
   * Scans across all ppids for an unclaimed ticket within the freshness window.
   * Used when no ticket matches process.ppid (Windows intermediate shell, custom
   * launcher). Refuses to bind if >1 candidate ticket exists: with two
   * near-simultaneous sessions there is no correlation to pick the right one,
   * and silent misrouting is worse than staying unbound.
   */
  function tryFallbackScan() {
    const freshnessCutoff = Date.now() - 10000;
    return scanAndClaim(
      (_file, data) => data.created_at > freshnessCutoff,
      'fallbackScan',
      true
    );
  }

  function tryReadTicket() {
    if (!ticketPath) return null;
    let raw;
    try {
      raw = fs.readFileSync(ticketPath, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') {
        // Ticket was deleted (cleanup or crash). Clear the cached session so
        // tools return an honest "unbound" error rather than targeting a
        // stale session until restart.
        if (boundSessionId !== null) {
          process.stderr.write('[wrightward-mcp] ticket disappeared — dropping bound session\n');
          boundSessionId = null;
        }
      } else {
        process.stderr.write('[wrightward-mcp] ticket read failed: ' + err.message + '\n');
      }
      return null;
    }
    try {
      const data = JSON.parse(raw);
      if (data && data.session_id) return data.session_id;
    } catch (err) {
      process.stderr.write('[wrightward-mcp] ticket parse failed: ' + err.message + '\n');
    }
    return null;
  }

  /**
   * Re-asserts this process's claim on the ticket (e.g. after resume detection).
   * Serialized under withAgentsLock for consistency with the initial claim —
   * the lock is cheap (ticketPath is already pid-scoped) and keeps all ticket
   * mutations under one rule so we don't have to reason about exceptions.
   */
  function claimTicket(sessionId) {
    try {
      withAgentsLock(collabDir, () => {
        atomicWriteJson(ticketPath, {
          session_id: sessionId,
          created_at: Date.now(),
          claimed: true,
          mcp_pid: process.pid
        });
      });
    } catch (err) {
      process.stderr.write('[wrightward-mcp] claimTicket failed: ' + (err.message || err) + '\n');
    }
  }

  function scheduleRetry() {
    if (retryTimer) return;
    let attempts = 0;
    retryTimer = setInterval(() => {
      attempts++;
      // Use the same ppid+fallback pairing bind() uses. On Windows where
      // process.ppid points to an intermediate shell (not the Claude CLI),
      // ppid-only scans never match — the fallback's freshness-window scan
      // is how those setups recover. Omitting it here would strand the
      // server in unbound mode forever.
      let claimed = tryClaimByPpid();
      let viaFallback = false;
      if (!claimed) {
        claimed = tryFallbackScan();
        viaFallback = true;
      }
      if (claimed) {
        boundSessionId = claimed.sessionId;
        ticketPath = claimed.ticketPath;
        const suffix = viaFallback ? ' (via fallback scan; unique candidate)' : '';
        process.stderr.write('[wrightward-mcp] late-bound to session ' + claimed.sessionId + suffix + '\n');
        clearInterval(retryTimer);
        retryTimer = null;
        return;
      }
      if (attempts >= RETRY_MAX_ATTEMPTS) {
        process.stderr.write('[wrightward-mcp] giving up on binding after ' +
          RETRY_MAX_ATTEMPTS + ' retries — tools will remain unbound\n');
        clearInterval(retryTimer);
        retryTimer = null;
      }
    }, RETRY_INTERVAL_MS);
    if (retryTimer.unref) retryTimer.unref();
  }

  /**
   * Re-reads the ticket to detect session resume (--resume / --continue).
   * Call this on every tool invocation.
   */
  function refreshBinding() {
    const sessionId = tryReadTicket();
    if (sessionId && sessionId !== boundSessionId) {
      const oldId = boundSessionId;
      boundSessionId = sessionId;
      claimTicket(sessionId);
      process.stderr.write('[wrightward-mcp] re-bound to session ' + sessionId + ' (resume detected, was ' + oldId + ')\n');
    }
  }

  function getSessionId() {
    return boundSessionId;
  }

  function isBound() {
    return boundSessionId !== null;
  }

  function cleanup() {
    if (retryTimer) {
      clearInterval(retryTimer);
      retryTimer = null;
    }
  }

  return { bind, getSessionId, isBound, refreshBinding, cleanup };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
