'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { hashString } = require('../../lib/hash');

describe('hashString', () => {
  it('returns a 32-char hex string', () => {
    const result = hashString('hello');
    assert.equal(result.length, 32);
    assert.match(result, /^[0-9a-f]{32}$/);
  });

  it('returns consistent results for same input', () => {
    assert.equal(hashString('test'), hashString('test'));
  });

  it('returns different results for different input', () => {
    assert.notEqual(hashString('a'), hashString('b'));
  });

  it('handles empty string', () => {
    const result = hashString('');
    assert.equal(result.length, 32);
  });
});
