'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  validateSessionId,
  SESSION_ID_PATTERN,
  RESERVED_SYNTHETIC_SENDER,
  BRIDGE_SESSION_ID,
  USER_AUDIENCE,
  BROADCAST_TARGETS,
  RESERVED_SESSION_IDS,
  SHORT_ID_LEN
} = require('../../lib/constants');

describe('validateSessionId', () => {
  it('accepts alphanumeric session IDs', () => {
    assert.equal(validateSessionId('abc123'), 'abc123');
  });

  it('accepts hyphens and underscores', () => {
    assert.equal(validateSessionId('sess_one-two-3'), 'sess_one-two-3');
  });

  it('accepts UUID-like strings (hyphenated hex)', () => {
    assert.equal(
      validateSessionId('550e8400-e29b-41d4-a716-446655440000'),
      '550e8400-e29b-41d4-a716-446655440000'
    );
  });

  it('rejects empty string', () => {
    assert.throws(() => validateSessionId(''));
  });

  it('rejects null', () => {
    assert.throws(() => validateSessionId(null));
  });

  it('rejects undefined', () => {
    assert.throws(() => validateSessionId(undefined));
  });

  it('rejects path traversal (..)', () => {
    assert.throws(() => validateSessionId('../evil'));
  });

  it('rejects forward slash', () => {
    assert.throws(() => validateSessionId('a/b'));
  });

  it('rejects backslash', () => {
    assert.throws(() => validateSessionId('a\\b'));
  });

  it('rejects dot', () => {
    assert.throws(() => validateSessionId('a.b'));
  });

  it('rejects spaces', () => {
    assert.throws(() => validateSessionId('a b'));
  });

  it('rejects other special characters', () => {
    for (const ch of ['*', '?', '#', ':', ';', '"', '\'', '`', '$', '&', '|', '<', '>']) {
      assert.throws(() => validateSessionId('a' + ch + 'b'));
    }
  });

  it('exports the regex pattern', () => {
    assert.ok(SESSION_ID_PATTERN instanceof RegExp);
    assert.equal(SESSION_ID_PATTERN.test('ok-id_1'), true);
    assert.equal(SESSION_ID_PATTERN.test('bad/id'), false);
  });

  it('rejects RESERVED_SYNTHETIC_SENDER', () => {
    // The runtime sender identifier must not be usable as a real session ID —
    // otherwise an agent could impersonate the bus runtime on bus.jsonl.
    // Fails the SESSION_ID_PATTERN first (colon isn't in [a-zA-Z0-9_-]) — this
    // is the defense-in-depth layer; the explicit reserved-set check below
    // catches same-shape reserved names like BRIDGE_SESSION_ID.
    assert.throws(() => validateSessionId(RESERVED_SYNTHETIC_SENDER), /Invalid session ID/);
  });

  it('rejects BRIDGE_SESSION_ID for real session paths', () => {
    // The bridge bookmark uses __bridge__ as its key, but validateSessionId
    // (called by context paths, agent registration, createEvent `from`) must
    // reject it so no real session can masquerade as the bridge.
    assert.throws(() => validateSessionId(BRIDGE_SESSION_ID), /reserved/);
  });

  it('rejects USER_AUDIENCE for real session paths', () => {
    // wrightward_send_message uses to:"user" as a Discord-only audience. The
    // literal string "user" passes SESSION_ID_PATTERN, so without an explicit
    // reservation a session could register under sessionId="user" and have
    // matchesSession route every Discord-only reply into its inbox.
    assert.throws(() => validateSessionId(USER_AUDIENCE), /reserved/);
  });
});

describe('RESERVED_SESSION_IDS', () => {
  it('includes RESERVED_SYNTHETIC_SENDER', () => {
    assert.ok(RESERVED_SESSION_IDS.has(RESERVED_SYNTHETIC_SENDER));
  });

  it('includes BRIDGE_SESSION_ID', () => {
    assert.ok(RESERVED_SESSION_IDS.has(BRIDGE_SESSION_ID));
  });

  it('includes USER_AUDIENCE', () => {
    assert.ok(RESERVED_SESSION_IDS.has(USER_AUDIENCE));
  });

  it('BRIDGE_SESSION_ID is a syntactically valid session-id shape', () => {
    // The bookmark path builder uses sessionId as a filename component and
    // does not re-validate — so __bridge__ must match SESSION_ID_PATTERN to
    // form a legal path, even though validateSessionId rejects it.
    assert.equal(SESSION_ID_PATTERN.test(BRIDGE_SESSION_ID), true);
  });

  it('USER_AUDIENCE = "user" — pin the wire-format value', () => {
    // Changing this string is a cross-module break: wrightward_send_message's
    // tool description, README docs, and mirror-policy's BROADCAST_TARGETS
    // all advertise the literal "user". Pin it.
    assert.equal(USER_AUDIENCE, 'user');
  });
});

describe('BROADCAST_TARGETS', () => {
  it('contains "all" and USER_AUDIENCE — single source of truth', () => {
    // mirror-policy uses this set to decide thread-vs-broadcast routing in
    // decide(); mcp/tools.mjs imports the same set instead of redeclaring it.
    // If a third broadcast-only target is added in the future, BOTH consumers
    // pick it up automatically.
    assert.ok(BROADCAST_TARGETS.has('all'));
    assert.ok(BROADCAST_TARGETS.has(USER_AUDIENCE));
    assert.equal(BROADCAST_TARGETS.size, 2);
  });
});

describe('SHORT_ID_LEN', () => {
  // SHORT_ID_LEN drives display-only truncation for Discord thread titles,
  // @agent-<shortId> mention parsing, and formatter suffixes. If the value
  // drifts between modules, a user's short-ID mention won't match the
  // short-ID suffix in the thread title — a pure usability regression.
  // These tests pin the exported value so accidental changes break CI.

  it('is a positive integer', () => {
    assert.equal(typeof SHORT_ID_LEN, 'number');
    assert.ok(Number.isInteger(SHORT_ID_LEN));
    assert.ok(SHORT_ID_LEN > 0);
  });

  it('is 8 — keep thread/mention/formatter short-ID displays symmetric', () => {
    // Changing this value is a cross-module contract break — expected to
    // force a conscious update to this test and to Discord users' muscle
    // memory of the short-ID format.
    assert.equal(SHORT_ID_LEN, 8);
  });
});
