'use strict';

const SESSION_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

// Reserved sender identifier used by the bus runtime for synthetic events
// (e.g., TOCTOU race-recovery file_freed). Kept in sync with
// bus-schema.SYNTHETIC_SENDER; validateSessionId rejects this exact value so
// no real agent can register under it and impersonate the runtime.
//
// Contains a colon so SESSION_ID_PATTERN (/^[a-zA-Z0-9_-]+$/) naturally
// rejects it — defense in depth beyond the explicit equality check.
const RESERVED_SYNTHETIC_SENDER = 'wrightward:runtime';

// Reserved bookmark-only identifier for the Phase 3 Discord bridge daemon.
// Matches SESSION_ID_PATTERN so the bus-log bookmarkPath builder will happily
// accept it as a filename component, but validateSessionId rejects it for
// real session paths (context, agent registration, createEvent `from`).
const BRIDGE_SESSION_ID = '__bridge__';

// Peer set of IDs that are syntactically valid session-id shapes but are
// reserved for wrightward-internal use. validateSessionId walks this set.
const RESERVED_SESSION_IDS = new Set([RESERVED_SYNTHETIC_SENDER, BRIDGE_SESSION_ID]);

function validateSessionId(sessionId) {
  if (!sessionId || !SESSION_ID_PATTERN.test(sessionId)) {
    throw new Error(`Invalid session ID: ${sessionId}`);
  }
  if (RESERVED_SESSION_IDS.has(sessionId)) {
    throw new Error(`Invalid session ID: ${sessionId} is reserved for wrightward runtime`);
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

// Display-only truncation length for session IDs in Discord thread names,
// `@agent-<shortId>` mentions, and formatter suffixes. Shared across
// discord/* and lib/discord-sanitize to keep mention parsing symmetric with
// thread naming (if these drifted, a user's short-ID mention wouldn't match
// the short-ID suffix rendered in their thread title).
const SHORT_ID_LEN = 8;

module.exports = {
  SESSION_ID_PATTERN,
  RESERVED_SYNTHETIC_SENDER,
  BRIDGE_SESSION_ID,
  RESERVED_SESSION_IDS,
  validateSessionId,
  isWriteTool,
  WRITE_TOOLS,
  SHORT_ID_LEN
};
