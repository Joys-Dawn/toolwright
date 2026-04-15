'use strict';

const crypto = require('crypto');
const { validateSessionId, RESERVED_SYNTHETIC_SENDER } = require('./constants');

// Synthetic sender ID for events emitted by the bus runtime itself rather
// than a real session (e.g., TOCTOU race-recovery file_freed in writeInterest).
// Sourced from constants.js so validateSessionId can reject this exact value.
const SYNTHETIC_SENDER = RESERVED_SYNTHETIC_SENDER;

const EVENT_TYPES = new Set([
  'note', 'finding', 'decision', 'blocker', 'handoff', 'file_freed',
  'user_message', 'interest', 'ack',
  'session_started', 'session_ended', 'delivery_failed',
  // Phase 3 (Discord bridge):
  //   'rate_limited'    — diagnostic, emitted by bridge when Discord 429 bucket overflows
  //   'context_updated' — emitted by scripts/context.js when a session's task string changes;
  //                       bridge subscribes to this for thread-rename decisions without diffing
  //                       context files. Both are non-urgent (observability-oriented).
  //   'agent_message'   — emitted by wrightward_send_message; mirrors to Discord and (when
  //                       audience='all' or a sessionId) appears in recipient inboxes. URGENT
  //                       so the inbox-listing + doorbell paths actually surface it.
  'rate_limited', 'context_updated', 'agent_message'
]);

const URGENT_TYPES = new Set([
  'handoff', 'file_freed', 'user_message', 'blocker', 'delivery_failed',
  'agent_message',
  // 'ack' routes a handoff acknowledgement to the original sender so they see
  // accepted/rejected/dismissed without grepping bus.jsonl.
  // 'finding' and 'decision' are observability events loud enough that every
  // agent needs to know ("must-know" semantics); 'note' stays non-urgent.
  'ack', 'finding', 'decision'
]);

/**
 * Creates a bus event with validated fields.
 * @param {string} from - Session ID of the sender, or SYNTHETIC_SENDER for runtime events.
 * @param {string|string[]} to - Target: session ID, 'all', 'role:*', or array.
 * @param {string} type - One of EVENT_TYPES.
 * @param {string} body - Human-readable message body.
 * @param {object} meta - Type-specific metadata.
 * @param {string} severity - 'info', 'warn', or 'critical'.
 * @param {number|null} expiresAt - Unix ms timestamp, or null for no expiry.
 * @returns {object} The event object.
 */
function createEvent(from, to, type, body, meta = {}, severity = 'info', expiresAt = null) {
  if (from !== SYNTHETIC_SENDER) {
    validateSessionId(from);
  }
  if (!EVENT_TYPES.has(type)) {
    throw new Error(`Unknown event type: ${type}`);
  }
  if (typeof to !== 'string' && !Array.isArray(to)) {
    throw new Error('to must be a string or array');
  }
  if (Array.isArray(to) && to.length === 0) {
    throw new Error('to array must not be empty');
  }
  const targets = Array.isArray(to) ? to : [to];
  for (const t of targets) {
    if (typeof t === 'string' && t.startsWith('role:')) {
      throw new Error('role:* targets are not yet supported (Phase 1)');
    }
  }

  return {
    id: crypto.randomUUID(),
    ts: Date.now(),
    from,
    to,
    type,
    body: body || '',
    meta: meta || {},
    severity: severity || 'info',
    expires_at: expiresAt
  };
}

/**
 * Returns true if the event type is "urgent" (triggers Path 1/2 delivery).
 */
function isUrgent(event) {
  return URGENT_TYPES.has(event.type);
}

/**
 * Returns true if the event is targeted at the given session.
 * Never matches events sent BY this session (no echo).
 */
function matchesSession(event, sessionId) {
  if (event.from === sessionId) return false;
  if (Array.isArray(event.to)) {
    return event.to.some(t => matchOne(t, sessionId));
  }
  return matchOne(event.to, sessionId);
}

function matchOne(to, sessionId) {
  if (to === sessionId) return true;
  if (to === 'all') return true;
  if (typeof to === 'string' && to.startsWith('role:')) return false; // Phase 1: no roles
  return false;
}

/**
 * Validates a bus event object. Throws on invalid.
 */
function validateEvent(event) {
  if (!event || typeof event !== 'object') throw new Error('Event must be an object');
  if (typeof event.id !== 'string' || event.id.length === 0) throw new Error('Event missing id');
  if (typeof event.ts !== 'number' || event.ts <= 0) throw new Error('Event missing ts');
  if (typeof event.from !== 'string' || event.from.length === 0) throw new Error('Event missing from');
  if (typeof event.to !== 'string' && !Array.isArray(event.to)) throw new Error('Event missing to');
  if (!EVENT_TYPES.has(event.type)) throw new Error(`Unknown event type: ${event.type}`);
}

module.exports = { EVENT_TYPES, URGENT_TYPES, SYNTHETIC_SENDER, createEvent, isUrgent, matchesSession, validateEvent };
