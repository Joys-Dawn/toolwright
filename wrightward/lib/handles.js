'use strict';

const crypto = require('crypto');
const { NAMES } = require('./wordlist');
const { HANDLE_PATTERN, HANDLE_NAME_PATTERN, MAX_HANDLE_NUMBER, BROADCAST_TARGETS } = require('./constants');

const NAME_COUNT = BigInt(NAMES.length);
const NUMBER_RANGE = BigInt(MAX_HANDLE_NUMBER + 1);

/**
 * Deterministic handle for a session UUID. Pure — no I/O, no global state.
 * Same input always yields the same output as long as `NAMES` stays stable.
 *
 * Uses the first 48 bits of sha256(sessionId) (12 hex chars) as an unsigned
 * integer N, then:
 *   name   = NAMES[N mod |NAMES|]
 *   number = (N div |NAMES|) mod 10000
 *
 * BigInt arithmetic avoids Number's 53-bit precision ceiling on the 48-bit
 * intermediate. Collision math: 100 names × 10000 numbers = 1M slots, so
 * birthday-paradox 50%-collision point is ~1183 concurrent sessions —
 * orders of magnitude above realistic load.
 */
function deriveHandle(sessionId) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new Error('deriveHandle requires a non-empty string sessionId');
  }
  const hex = crypto.createHash('sha256').update(sessionId, 'utf8').digest('hex');
  const big = BigInt('0x' + hex.slice(0, 12));
  const nameIdx = Number(big % NAME_COUNT);
  const number = Number((big / NAME_COUNT) % NUMBER_RANGE);
  return NAMES[nameIdx] + '-' + number;
}

/**
 * Returns true when `str` has handle shape (name-number). Does NOT check
 * whether the name is in the wordlist or whether any live session owns it.
 * Use for cheap first-pass routing (is this audience-looking? vs. is it a
 * UUID?) before hitting the roster.
 */
function validateHandle(str) {
  return typeof str === 'string' && HANDLE_PATTERN.test(str);
}

/**
 * Resolves `input` from `wrightward_send_message.audience` / `@agent-<X>` /
 * similar addressing contexts to a canonical target.
 *
 * Resolution order (first match wins):
 *   1. Broadcast targets: 'user' / 'all' — returned as { type: 'broadcast' }.
 *   2. Exact handle match against agents.json roster (e.g. "bob-42").
 *   3. Name-only when unambiguous (e.g. "bob" when only bob-42 is live).
 *      Ambiguous name (>1 match) throws a structured error.
 *   4. Otherwise: structured error listing live handles.
 *
 * The returned target is ALWAYS either a broadcast token ('user'/'all') or
 * a full session UUID — never a handle. Callers pass it straight into
 * createEvent's `to` field.
 *
 * @param {string} collabDir
 * @param {string} input - user-supplied audience token
 * @returns {{ type: 'broadcast'|'sessionId', target: string }}
 */
function resolveAudience(collabDir, input) {
  if (typeof input !== 'string' || input.length === 0) {
    throw audienceError('audience must be a non-empty string', {}, collabDir);
  }
  if (BROADCAST_TARGETS.has(input)) {
    return { type: 'broadcast', target: input };
  }

  const { readAgents } = require('./agents');
  const roster = readAgents(collabDir);

  // Handle-shaped inputs (e.g. `bob-42`) match against the roster's handle
  // index. This is the canonical addressing form — every agent-facing
  // surface renders handles, and SessionStart injects the agent's own
  // handle so every session can self-identify.
  if (HANDLE_PATTERN.test(input)) {
    for (const [sid, row] of Object.entries(roster)) {
      const h = handleFor(sid, row);
      if (h === input) return { type: 'sessionId', target: sid };
    }
  }

  // Bare name (e.g. `bob`) is only meaningful as a handle prefix.
  // Ambiguous → structured error. Single hit → success. Zero hits → fall
  // through so the final error lists live handles with context.
  if (HANDLE_NAME_PATTERN.test(input)) {
    const hits = [];
    for (const [sid, row] of Object.entries(roster)) {
      const h = handleFor(sid, row);
      if (h.startsWith(input + '-')) hits.push(sid);
    }
    if (hits.length === 1) return { type: 'sessionId', target: hits[0] };
    if (hits.length > 1) {
      throw audienceError(`audience '${input}' is ambiguous`, roster, collabDir);
    }
  }

  throw audienceError(`audience '${input}' is not a live agent`, roster, collabDir);
}

/**
 * Returns the handle for a roster entry, preferring the stored value. When a
 * row predates the handle-field rollout, derive on the fly — same algorithm,
 * same result, so callers can trust identity comparisons either way.
 */
function handleFor(sessionId, row) {
  if (row && typeof row.handle === 'string' && HANDLE_PATTERN.test(row.handle)) {
    return row.handle;
  }
  return deriveHandle(sessionId);
}

/**
 * Returns a handle→sessionId map built from a live roster. O(N) on roster
 * size; callers that need repeated lookups should reuse the map.
 */
function handleIndex(roster) {
  const out = new Map();
  if (!roster || typeof roster !== 'object') return out;
  for (const [sid, row] of Object.entries(roster)) {
    out.set(handleFor(sid, row), sid);
  }
  return out;
}

function audienceError(message, roster, collabDir) {
  const liveHandles = roster && typeof roster === 'object'
    ? Object.entries(roster)
        .map(([sid, row]) => handleFor(sid, row))
        .sort()
    : [];
  const hint = liveHandles.length === 0
    ? 'No live agents are registered. Check that BUS_ENABLED=true and at least one session has started.'
    : `Live agents: ${liveHandles.join(', ')}. Use wrightward_whoami to see your own handle.`;
  const err = new Error(message);
  err.audienceError = { message, hint, liveHandles, collabDir };
  return err;
}

module.exports = { deriveHandle, validateHandle, resolveAudience, handleFor, handleIndex };
