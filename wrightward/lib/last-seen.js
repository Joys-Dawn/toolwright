'use strict';

const fs = require('fs');
const path = require('path');
const { atomicWriteJson } = require('./atomic-write');
const { validateSessionId } = require('./constants');

function lastSeenPath(collabDir, sessionId) {
  validateSessionId(sessionId);
  return path.join(collabDir, 'last-seen', sessionId + '.json');
}

/**
 * Gets the last-seen context hash for an agent. Returns null if missing.
 */
function getLastSeenHash(collabDir, sessionId) {
  try {
    const data = JSON.parse(fs.readFileSync(lastSeenPath(collabDir, sessionId), 'utf8'));
    return data.hash || null;
  } catch (e) {
    return null;
  }
}

/**
 * Stores the last-seen context hash for an agent atomically.
 */
function setLastSeenHash(collabDir, sessionId, hash) {
  atomicWriteJson(lastSeenPath(collabDir, sessionId), { hash });
}

/**
 * Removes the last-seen file for an agent.
 */
function removeLastSeen(collabDir, sessionId) {
  try {
    fs.unlinkSync(lastSeenPath(collabDir, sessionId));
  } catch (e) {
    // Already gone
  }
}

module.exports = { getLastSeenHash, setLastSeenHash, removeLastSeen };
