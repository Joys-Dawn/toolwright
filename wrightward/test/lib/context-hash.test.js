'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { getContextHash, setContextHash, removeContextHash } = require('../../lib/context-hash');

describe('context-hash', () => {
  let collabDir;

  beforeEach(() => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collab-test-'));
    collabDir = path.join(tmpDir, '.claude', 'collab');
    fs.mkdirSync(path.join(collabDir, 'context-hash'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(path.dirname(collabDir), { recursive: true, force: true });
  });

  it('returns null for missing hash', () => {
    assert.equal(getContextHash(collabDir, 'sess-1'), null);
  });

  it('round-trips hash', () => {
    setContextHash(collabDir, 'sess-1', 'abc123');
    assert.equal(getContextHash(collabDir, 'sess-1'), 'abc123');
  });

  it('overwrites previous hash', () => {
    setContextHash(collabDir, 'sess-1', 'first');
    setContextHash(collabDir, 'sess-1', 'second');
    assert.equal(getContextHash(collabDir, 'sess-1'), 'second');
  });

  it('removes context hash file', () => {
    setContextHash(collabDir, 'sess-1', 'abc');
    removeContextHash(collabDir, 'sess-1');
    assert.equal(getContextHash(collabDir, 'sess-1'), null);
  });

  it('does not throw for missing file on remove', () => {
    assert.doesNotThrow(() => removeContextHash(collabDir, 'nonexistent'));
  });
});
