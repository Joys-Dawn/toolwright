'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { ensureCollabDir } = require('../../lib/collab-dir');
const { writeMarker } = require('../../lib/last-prompt');

const HOOK = path.resolve(__dirname, '../../hooks/ask-user.js');

function runHook(input) {
  return execFileSync('node', [HOOK], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    timeout: 5000
  });
}

describe('ask-user hook (PreToolUse for AskUserQuestion)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-user-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('exits silently when last-prompt marker is missing', () => {
    ensureCollabDir(tmpDir);
    const out = runHook({
      session_id: 'sess-1',
      cwd: tmpDir,
      tool_name: 'AskUserQuestion',
      tool_input: { questions: [] }
    });
    assert.equal(out, '');
  });

  it('exits silently when last-prompt marker is cli', () => {
    const collabDir = ensureCollabDir(tmpDir);
    writeMarker(collabDir, 'sess-1', 'cli');
    const out = runHook({
      session_id: 'sess-1',
      cwd: tmpDir,
      tool_name: 'AskUserQuestion',
      tool_input: { questions: [] }
    });
    assert.equal(out, '');
  });

  it('denies and redirects when last-prompt marker is discord', () => {
    const collabDir = ensureCollabDir(tmpDir);
    writeMarker(collabDir, 'sess-1', 'discord');
    const out = runHook({
      session_id: 'sess-1',
      cwd: tmpDir,
      tool_name: 'AskUserQuestion',
      tool_input: { questions: [] }
    });
    const parsed = JSON.parse(out);
    assert.equal(parsed.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.equal(parsed.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(parsed.hookSpecificOutput.permissionDecisionReason, /wrightward_send_message/);
    assert.match(parsed.hookSpecificOutput.permissionDecisionReason, /audience='user'/);
  });

  it('exits silently when no collab directory exists', () => {
    const { root: fsRoot } = path.parse(tmpDir);
    const isolated = path.join(fsRoot, '__ask_user_test_' + process.pid);
    fs.mkdirSync(isolated, { recursive: true });
    try {
      const out = runHook({
        session_id: 'sess-1',
        cwd: isolated,
        tool_name: 'AskUserQuestion',
        tool_input: { questions: [] }
      });
      assert.equal(out, '');
    } finally {
      fs.rmSync(isolated, { recursive: true, force: true });
    }
  });

  it('exits silently with no session_id', () => {
    ensureCollabDir(tmpDir);
    const out = runHook({ cwd: tmpDir, tool_name: 'AskUserQuestion' });
    assert.equal(out, '');
  });

  it('exits silently when session_id fails validateSessionId (e.g., reserved ID)', () => {
    const collabDir = ensureCollabDir(tmpDir);
    writeMarker(collabDir, 'sess-1', 'discord');
    const out = runHook({
      session_id: 'wrightward:runtime',
      cwd: tmpDir,
      tool_name: 'AskUserQuestion',
      tool_input: { questions: [] }
    });
    assert.equal(out, '');
  });

  it('does nothing when ENABLED is false', () => {
    const collabDir = ensureCollabDir(tmpDir);
    writeMarker(collabDir, 'sess-1', 'discord');
    fs.writeFileSync(path.join(tmpDir, '.claude', 'wrightward.json'),
      JSON.stringify({ ENABLED: false }));
    const out = runHook({
      session_id: 'sess-1',
      cwd: tmpDir,
      tool_name: 'AskUserQuestion',
      tool_input: { questions: [] }
    });
    assert.equal(out, '');
  });
});
