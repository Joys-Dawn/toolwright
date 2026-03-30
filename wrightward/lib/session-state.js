'use strict';

const { readAgents, removeAgent, withAgentsLock, writeAgents } = require('./agents');
const { removeContext } = require('./context');
const { removeLastSeen } = require('./last-seen');

function removeSessionState(collabDir, sessionId) {
  removeContext(collabDir, sessionId);
  removeLastSeen(collabDir, sessionId);
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
      removeLastSeen(collabDir, sessionId);
      delete agents[sessionId];
    }

    if (expiredIds.length > 0) {
      writeAgents(collabDir, agents);
    }

    removed.push(...expiredIds);
  });

  return removed;
}

module.exports = { removeSessionState, scavengeExpiredSessions };
