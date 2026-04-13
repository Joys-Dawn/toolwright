'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { validateSessionId, SESSION_ID_PATTERN } = require('../../lib/constants');

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
});
