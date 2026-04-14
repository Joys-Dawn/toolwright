'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { ensureCollabDir } = require('../../lib/collab-dir');
const { registerAgent, withAgentsLock } = require('../../lib/agents');
const { writeContext, fileEntryForPath } = require('../../lib/context');
const { append, readBookmark } = require('../../lib/bus-log');
const { createEvent } = require('../../lib/bus-schema');

const GUARD_HOOK = path.resolve(__dirname, '../../hooks/guard.js');

function fe(prefix, filePath) {
  return { ...fileEntryForPath(filePath, prefix, 'planned'), declaredAt: Date.now(), lastTouched: Date.now() };
}

function runHook(input) {
  try {
    const stdout = execFileSync('node', [GUARD_HOOK], {
      input: JSON.stringify(input),
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    return { exitCode: 0, stdout, stderr: '' };
  } catch (e) {
    return { exitCode: e.status, stdout: e.stdout || '', stderr: e.stderr || '' };
  }
}

describe('integration: path dedupe', () => {
  let tmpDir;
  let collabDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'integ-dedupe-'));
    collabDir = ensureCollabDir(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('two guard.js runs in quick succession: inbox consumed only once', () => {
    registerAgent(collabDir, 'sess-1');
    registerAgent(collabDir, 'sess-2');
    writeContext(collabDir, 'sess-2', { task: 'work', files: [fe('~', 'x.js')], status: 'in-progress' });

    // Seed an urgent event
    withAgentsLock(collabDir, (token) => {
      append(token, collabDir, createEvent('sess-2', 'sess-1', 'handoff', 'do this'));
    });

    // First guard call — should inject the handoff + agent summary
    const first = runHook({
      session_id: 'sess-1',
      cwd: tmpDir,
      tool_name: 'Read',
      tool_input: { file_path: path.join(tmpDir, 'x.js') }
    });
    assert.equal(first.exitCode, 0);
    assert.ok(first.stdout.length > 0, 'First call should inject context');
    const parsed1 = JSON.parse(first.stdout);
    assert.match(parsed1.hookSpecificOutput.additionalContext, /do this/, 'First call includes inbox');

    // Second guard call — inbox is consumed (bookmark advanced), but agent summary
    // may still inject (different hash since inbox portion is gone).
    // The key assertion: inbox events are NOT re-injected.
    const second = runHook({
      session_id: 'sess-1',
      cwd: tmpDir,
      tool_name: 'Read',
      tool_input: { file_path: path.join(tmpDir, 'x.js') }
    });
    assert.equal(second.exitCode, 0);
    if (second.stdout) {
      const parsed2 = JSON.parse(second.stdout);
      // Should NOT contain the handoff body again
      assert.doesNotMatch(parsed2.hookSpecificOutput.additionalContext, /do this/,
        'Second call should NOT re-inject inbox events');
    }
  });

  it('bookmark consistent after dedupe', () => {
    registerAgent(collabDir, 'sess-1');

    // Seed two events
    withAgentsLock(collabDir, (token) => {
      append(token, collabDir, createEvent('sess-other', 'sess-1', 'handoff', 'first'));
      append(token, collabDir, createEvent('sess-other', 'sess-1', 'file_freed', 'freed', { file: 'a.ts' }));
    });

    // First call processes both
    runHook({
      session_id: 'sess-1',
      cwd: tmpDir,
      tool_name: 'Read',
      tool_input: { file_path: path.join(tmpDir, 'z.js') }
    });

    const bm = readBookmark(collabDir, 'sess-1');
    assert.ok(bm.lastDeliveredOffset > 0);
    assert.ok(bm.lastScannedOffset >= bm.lastDeliveredOffset);
  });
});
