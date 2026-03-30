'use strict';

const fs = require('fs');
const path = require('path');
const { atomicWriteJson } = require('./atomic-write');
const { validateSessionId } = require('./constants');

function contextPath(collabDir, sessionId) {
  validateSessionId(sessionId);
  return path.join(collabDir, 'context', sessionId + '.json');
}

/**
 * Reads a single agent's context file. Returns null if missing.
 */
function readContext(collabDir, sessionId) {
  try {
    return JSON.parse(fs.readFileSync(contextPath(collabDir, sessionId), 'utf8'));
  } catch (e) {
    return null;
  }
}

/**
 * Writes an agent's context file atomically.
 */
function writeContext(collabDir, sessionId, data) {
  atomicWriteJson(contextPath(collabDir, sessionId), data);
}

/**
 * Removes an agent's context file.
 */
function removeContext(collabDir, sessionId) {
  try {
    fs.unlinkSync(contextPath(collabDir, sessionId));
  } catch (e) {
    // Already gone
  }
}

module.exports = { readContext, writeContext, removeContext };
