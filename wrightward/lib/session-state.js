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
 * Removes expired file entries from all contexts.
 * - Auto-tracked files: expire after AUTO_TRACKED_FILE_TIMEOUT_MS from lastTouched.
 * - Planned files: expire after PLANNED_FILE_TIMEOUT_MS from declaredAt,
 *   unless touched within PLANNED_FILE_GRACE_MS (extends the claim).
 * Expired entries are removed; the context itself is kept (cleaned up by hard session scavenge).
 */
function scavengeExpiredFiles(collabDir, config, excludeSessionId) {
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
    if (sessionId === excludeSessionId) continue;

    // Lock per session to avoid racing with the owning session's heartbeat,
    // which may be adding auto-tracked files to this same context file.
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
