'use strict';

const SESSION_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

// Reserved sender identifier used by the bus runtime for synthetic events
// (e.g., TOCTOU race-recovery file_freed). Kept in sync with
// bus-schema.SYNTHETIC_SENDER; validateSessionId rejects this exact value so
// no real agent can register under it and impersonate the runtime.
//
// Contains a colon so SESSION_ID_PATTERN (/^[a-zA-Z0-9_-]+$/) naturally
// rejects it — defense in depth beyond the explicit equality check. The
// name must not collide with Phase 3's `'bridge'` sender identifier used
// by the Discord bridge daemon (see docs/v3-message-bus-plan.md §Phase 3).
const RESERVED_SYNTHETIC_SENDER = 'wrightward:runtime';

function validateSessionId(sessionId) {
  if (!sessionId || !SESSION_ID_PATTERN.test(sessionId)) {
    throw new Error(`Invalid session ID: ${sessionId}`);
  }
  if (sessionId === RESERVED_SYNTHETIC_SENDER) {
    throw new Error(`Invalid session ID: ${sessionId} is reserved for bus runtime`);
  }
  return sessionId;
}

// Tools that mutate files. Used by hooks to decide whether to auto-track
// a path, emit interest on overlap, or skip heartbeat scavenge.
// Single source of truth — when a new mutating tool appears (e.g. MultiEdit),
// extend this set instead of hunting down string comparisons across hooks.
const WRITE_TOOLS = new Set(['Edit', 'Write']);

function isWriteTool(toolName) {
  return WRITE_TOOLS.has(toolName);
}

module.exports = { SESSION_ID_PATTERN, RESERVED_SYNTHETIC_SENDER, validateSessionId, isWriteTool, WRITE_TOOLS };
