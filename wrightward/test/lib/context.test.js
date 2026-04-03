'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { readContext, writeContext, removeContext, fileEntryForPath } = require('../../lib/context');

describe('context', () => {
  let collabDir;

  beforeEach(() => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collab-test-'));
    collabDir = path.join(tmpDir, '.claude', 'collab');
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
      const entry = { path: 'a.js', prefix: '+', source: 'planned', declaredAt: 100, lastTouched: 200, reminded: false };
      const data = { task: 'test', files: [entry], functions: [], status: 'in-progress' };
      writeContext(collabDir, 'sess-1', data);
      const result = readContext(collabDir, 'sess-1');
      assert.deepEqual(result.files[0], entry);
      assert.equal(result.task, 'test');
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

  describe('fileEntryForPath', () => {
    it('creates a new file entry with timestamps', () => {
      const before = Date.now();
      const entry = fileEntryForPath('src/foo.js', '+', 'planned');
      const after = Date.now();
      assert.equal(entry.path, 'src/foo.js');
      assert.equal(entry.prefix, '+');
      assert.equal(entry.source, 'planned');
      assert.equal(entry.reminded, false);
      assert.ok(entry.declaredAt >= before && entry.declaredAt <= after);
      assert.ok(entry.lastTouched >= before && entry.lastTouched <= after);
    });

    it('defaults to ~ prefix and auto source', () => {
      const entry = fileEntryForPath('x.js');
      assert.equal(entry.prefix, '~');
      assert.equal(entry.source, 'auto');
    });
  });
});
