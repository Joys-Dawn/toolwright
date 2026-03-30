'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { getLastSeenHash, setLastSeenHash, removeLastSeen } = require('../../lib/last-seen');

describe('last-seen', () => {
  let collabDir;

  beforeEach(() => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collab-test-'));
    collabDir = path.join(tmpDir, '.collab');
    fs.mkdirSync(path.join(collabDir, 'last-seen'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(path.dirname(collabDir), { recursive: true, force: true });
  });

  it('returns null for missing hash', () => {
    assert.equal(getLastSeenHash(collabDir, 'sess-1'), null);
  });

  it('round-trips hash', () => {
    setLastSeenHash(collabDir, 'sess-1', 'abc123');
    assert.equal(getLastSeenHash(collabDir, 'sess-1'), 'abc123');
  });

  it('overwrites previous hash', () => {
    setLastSeenHash(collabDir, 'sess-1', 'first');
    setLastSeenHash(collabDir, 'sess-1', 'second');
    assert.equal(getLastSeenHash(collabDir, 'sess-1'), 'second');
  });

  it('removes last-seen file', () => {
    setLastSeenHash(collabDir, 'sess-1', 'abc');
    removeLastSeen(collabDir, 'sess-1');
    assert.equal(getLastSeenHash(collabDir, 'sess-1'), null);
  });

  it('does not throw for missing file on remove', () => {
    assert.doesNotThrow(() => removeLastSeen(collabDir, 'nonexistent'));
  });
});
