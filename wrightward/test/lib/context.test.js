'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { readContext, writeContext, removeContext } = require('../../lib/context');

describe('context', () => {
  let collabDir;

  beforeEach(() => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collab-test-'));
    collabDir = path.join(tmpDir, '.collab');
    fs.mkdirSync(path.join(collabDir, 'context'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(path.dirname(collabDir), { recursive: true, force: true });
  });

  describe('readContext / writeContext', () => {
    it('returns null for missing context', () => {
      assert.equal(readContext(collabDir, 'nonexistent'), null);
    });

    it('round-trips context data', () => {
      const data = { task: 'test', files: ['+a.js'], functions: [], status: 'in-progress' };
      writeContext(collabDir, 'sess-1', data);
      assert.deepEqual(readContext(collabDir, 'sess-1'), data);
    });
  });

  describe('removeContext', () => {
    it('removes context file', () => {
      writeContext(collabDir, 'sess-1', { task: 'test', status: 'in-progress' });
      removeContext(collabDir, 'sess-1');
      assert.equal(readContext(collabDir, 'sess-1'), null);
    });

    it('does not throw for missing file', () => {
      assert.doesNotThrow(() => removeContext(collabDir, 'nonexistent'));
    });
  });
});
