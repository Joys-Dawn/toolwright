'use strict';

const fs = require('fs');
const path = require('path');
const { atomicWriteJson } = require('./atomic-write');
const { validateSessionId } = require('./constants');
const { normalizeFilePath } = require('./path-normalize');

function contextPath(collabDir, sessionId) {
  validateSessionId(sessionId);
  return path.join(collabDir, 'context', sessionId + '.json');
}

/**
 * Creates a new file entry object for a given path.
 * Normalizes the path so that context entries, interest-index keys, and
 * bus-event meta.file all agree on format (POSIX separators, no leading ./).
 */
function fileEntryForPath(filePath, prefix, source) {
  const now = Date.now();
  return {
    path: normalizeFilePath(filePath),
    prefix: prefix || '~',
    source: source || 'auto',
    declaredAt: now,
    lastTouched: now,
    reminded: false
  };
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

module.exports = { readContext, writeContext, removeContext, fileEntryForPath };
