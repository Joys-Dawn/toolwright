'use strict';

/** Staleness threshold for active agent detection (6 minutes). */
const INACTIVE_THRESHOLD_MS = 6 * 60 * 1000;

const SESSION_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

function validateSessionId(sessionId) {
  if (!sessionId || !SESSION_ID_PATTERN.test(sessionId)) {
    throw new Error(`Invalid session ID: ${sessionId}`);
  }
  return sessionId;
}

module.exports = { INACTIVE_THRESHOLD_MS, SESSION_ID_PATTERN, validateSessionId };
