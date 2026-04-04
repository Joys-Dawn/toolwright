'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { ensureCollabDir } = require('../../lib/collab-dir');
const { registerAgent } = require('../../lib/agents');

const HOOK = path.resolve(__dirname, '../../hooks/plan-exit.js');

function runHook(input) {
  const result = execFileSync('node', [HOOK], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    timeout: 5000
  });
  return result;
}

describe('plan-exit hook', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collab-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('exits silently when no collab directory exists', () => {
    // Use a dir at the filesystem root so walk-up can't find a real .claude/collab
    const { root: fsRoot } = path.parse(tmpDir);
    const isolated = path.join(fsRoot, '__collab_plan_exit_test_' + process.pid);
    fs.mkdirSync(isolated, { recursive: true });
    try {
      const output = runHook({ session_id: 'sess-1', cwd: isolated });
      assert.equal(output, '');
    } finally {
      fs.rmSync(isolated, { recursive: true, force: true });
    }
  });

  it('exits silently when solo agent', () => {
    const collabDir = ensureCollabDir(tmpDir);
    registerAgent(collabDir, 'sess-1');

    const output = runHook({ session_id: 'sess-1', cwd: tmpDir });
    assert.equal(output, '');
  });

  it('injects reminder when other agents are active', () => {
    const collabDir = ensureCollabDir(tmpDir);
    registerAgent(collabDir, 'sess-1');
    registerAgent(collabDir, 'sess-2');

    const output = runHook({ session_id: 'sess-1', cwd: tmpDir });
    const parsed = JSON.parse(output);
    assert.equal(parsed.hookSpecificOutput.hookEventName, 'PostToolUse');
    assert.equal(parsed.hookSpecificOutput.permissionDecision, 'allow');
    assert.ok(parsed.hookSpecificOutput.additionalContext.includes('collab-context'));
  });

  it('exits silently with no cwd', () => {
    const output = runHook({ session_id: 'sess-1' });
    assert.equal(output, '');
  });
});
