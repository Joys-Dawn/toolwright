'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { ensureCollabDir } = require('../../lib/collab-dir');
const { registerAgent, readAgents } = require('../../lib/agents');
const { writeContext, readContext } = require('../../lib/context');
const { setLastSeenHash, getLastSeenHash } = require('../../lib/last-seen');

const HOOK = path.resolve(__dirname, '../../hooks/cleanup.js');

function runHook(input) {
  return execFileSync('node', [HOOK], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    timeout: 5000
  });
}

describe('cleanup hook', () => {
  let tmpDir;
  let collabDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collab-test-'));
    collabDir = ensureCollabDir(tmpDir);
    registerAgent(collabDir, 'sess-1');
    writeContext(collabDir, 'sess-1', { task: 'test', status: 'in-progress' });
    setLastSeenHash(collabDir, 'sess-1', 'abc');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('removes context, last-seen, and agent entry', () => {
    runHook({ session_id: 'sess-1', cwd: tmpDir });

    assert.equal(readContext(collabDir, 'sess-1'), null);
    assert.equal(getLastSeenHash(collabDir, 'sess-1'), null);
    assert.equal(readAgents(collabDir)['sess-1'], undefined);
  });

  it('does not affect other agents', () => {
    registerAgent(collabDir, 'sess-2');
    writeContext(collabDir, 'sess-2', { task: 'other', status: 'in-progress' });

    runHook({ session_id: 'sess-1', cwd: tmpDir });

    assert.ok(readAgents(collabDir)['sess-2']);
    assert.deepEqual(readContext(collabDir, 'sess-2'), { task: 'other', status: 'in-progress' });
  });

  it('exits cleanly when .claude/collab does not exist', () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collab-empty-'));
    try {
      runHook({ session_id: 'sess-1', cwd: emptyDir });
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});
