'use strict';

const fs = require('fs');
const path = require('path');
const { readAgents, removeAgent, withAgentsLock, writeAgents } = require('./agents');
const { readContext, writeContext, removeContext } = require('./context');
const { removeContextHash } = require('./context-hash');

function removeSessionState(collabDir, sessionId) {
  removeContext(collabDir, sessionId);
  removeContextHash(collabDir, sessionId);
  removeAgent(collabDir, sessionId);
}

function scavengeExpiredSessions(collabDir, maxAgeMs, excludeSessionId) {
  const removed = [];

  withAgentsLock(collabDir, () => {
    const agents = readAgents(collabDir);
    const cutoff = Date.now() - maxAgeMs;
    const expiredIds = [];

    for (const [sessionId, data] of Object.entries(agents)) {
      if (sessionId === excludeSessionId) {
        continue;
      }
      if (data.last_active < cutoff) {
        expiredIds.push(sessionId);
      }
    }

    for (const sessionId of expiredIds) {
      removeContext(collabDir, sessionId);
      removeContextHash(collabDir, sessionId);
      delete agents[sessionId];
    }

    if (expiredIds.length > 0) {
      writeAgents(collabDir, agents);
    }

    removed.push(...expiredIds);
  });

  return removed;
}

/**
 * Removes expired file entries from all contexts, including the caller's own.
 * - Auto-tracked files: expire after AUTO_TRACKED_FILE_TIMEOUT_MS from lastTouched.
 * - Planned files: expire after PLANNED_FILE_TIMEOUT_MS from declaredAt,
 *   unless touched within PLANNED_FILE_GRACE_MS (extends the claim).
 * Expired entries are removed; the context itself is kept (cleaned up by hard session scavenge).
 *
 * This intentionally scavenges the current session's own context as well. An earlier
 * version excluded the owning session under the (mistaken) assumption that it would
 * race with the session's own heartbeat adding auto-tracked files — but both paths
 * hold withAgentsLock, so they serialize correctly. Excluding the current session
 * caused long-running sessions to accumulate stale entries that never expired.
 */
function scavengeExpiredFiles(collabDir, config) {
  const contextDir = path.join(collabDir, 'context');
  let entries;
  try {
    entries = fs.readdirSync(contextDir);
  } catch (_) {
    return;
  }

  for (const filename of entries) {
    if (!filename.endsWith('.json')) continue;
    const sessionId = filename.slice(0, -5);

    // Hold the global agents lock to serialize with any concurrent writer.
    withAgentsLock(collabDir, () => {
      const ctx = readContext(collabDir, sessionId);
      if (!ctx || !Array.isArray(ctx.files) || ctx.files.length === 0) return;

      const now = Date.now();
      const surviving = ctx.files.filter(f => {
        if (f.source === 'auto') {
          return (now - f.lastTouched) <= config.AUTO_TRACKED_FILE_TIMEOUT_MS;
        }
        const overallExpired = (now - f.declaredAt) > config.PLANNED_FILE_TIMEOUT_MS;
        if (!overallExpired) return true;
        const recentlyTouched = (now - f.lastTouched) <= config.PLANNED_FILE_GRACE_MS;
        return recentlyTouched;
      });

      if (surviving.length === ctx.files.length) return;

      ctx.files = surviving;
      writeContext(collabDir, sessionId, ctx);
    });
  }
}

module.exports = { removeSessionState, scavengeExpiredSessions, scavengeExpiredFiles };
