'use strict';

const SESSION_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

function validateSessionId(sessionId) {
  if (!sessionId || !SESSION_ID_PATTERN.test(sessionId)) {
    throw new Error(`Invalid session ID: ${sessionId}`);
  }
  return sessionId;
}

module.exports = { SESSION_ID_PATTERN, validateSessionId };
