'use strict';

const fs = require('fs');
const path = require('path');
const { atomicWriteJson } = require('./atomic-write');
const { validateSessionId } = require('./constants');

function contextHashPath(collabDir, sessionId) {
  validateSessionId(sessionId);
  return path.join(collabDir, 'context-hash', sessionId + '.json');
}

/**
 * Gets the last injected context summary hash for an agent.
 * Used to deduplicate guard context injection — if the hash hasn't changed,
 * the same summary doesn't need to be shown again.
 * Returns null if missing.
 */
function getContextHash(collabDir, sessionId) {
  try {
    const data = JSON.parse(fs.readFileSync(contextHashPath(collabDir, sessionId), 'utf8'));
    return data.hash || null;
  } catch (e) {
    return null;
  }
}

/**
 * Stores the context summary hash for an agent atomically.
 */
function setContextHash(collabDir, sessionId, hash) {
  atomicWriteJson(contextHashPath(collabDir, sessionId), { hash });
}

/**
 * Removes the context hash file for an agent.
 */
function removeContextHash(collabDir, sessionId) {
  try {
    fs.unlinkSync(contextHashPath(collabDir, sessionId));
  } catch (e) {
    // Already gone
  }
}

module.exports = { getContextHash, setContextHash, removeContextHash };
