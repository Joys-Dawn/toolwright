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
const { busPath } = require('../../lib/bus-log');
const interestIndex = require('../../lib/interest-index');

const GUARD_HOOK = path.resolve(__dirname, '../../hooks/guard.js');
const CLEANUP_HOOK = path.resolve(__dirname, '../../hooks/cleanup.js');

function fe(prefix, filePath) {
  return { ...fileEntryForPath(filePath, prefix, 'planned'), declaredAt: Date.now(), lastTouched: Date.now() };
}

function runHook(hook, input) {
  try {
    const stdout = execFileSync('node', [hook], {
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

describe('integration: file-freed round trip', () => {
  let tmpDir;
  let collabDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'integ-freed-'));
    collabDir = ensureCollabDir(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('A claims file, B blocked (interest auto-registered), A releases, B gets file_freed', () => {
    // A claims auth.ts
    registerAgent(collabDir, 'sess-A');
    registerAgent(collabDir, 'sess-B');
    writeContext(collabDir, 'sess-A', {
      task: 'auth refactor',
      files: [fe('+', 'auth.ts')],
      status: 'in-progress'
    });
    writeContext(collabDir, 'sess-B', {
      task: 'jwt work',
      status: 'in-progress'
    });

    // B tries to write auth.ts — gets blocked, interest auto-registered
    const blockResult = runHook(GUARD_HOOK, {
      session_id: 'sess-B',
      cwd: tmpDir,
      tool_name: 'Write',
      tool_input: { file_path: path.join(tmpDir, 'auth.ts') }
    });
    assert.equal(blockResult.exitCode, 2);

    // Verify interest was registered
    const idx = interestIndex.read(collabDir);
    assert.ok(idx['auth.ts']);
    assert.ok(idx['auth.ts'].some(e => e.sessionId === 'sess-B'));

    // A releases by ending session (cleanup hook)
    runHook(CLEANUP_HOOK, { session_id: 'sess-A', cwd: tmpDir });

    // Verify file_freed event exists on bus
    const bp = busPath(collabDir);
    assert.ok(fs.existsSync(bp));
    const events = fs.readFileSync(bp, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    const fileFreed = events.find(e => e.type === 'file_freed' && e.meta.file === 'auth.ts' && e.to === 'sess-B');
    assert.ok(fileFreed, 'Expected file_freed event for sess-B');

    // B's next guard run should inject the file_freed event
    const nextResult = runHook(GUARD_HOOK, {
      session_id: 'sess-B',
      cwd: tmpDir,
      tool_name: 'Read',
      tool_input: { file_path: path.join(tmpDir, 'anything.js') }
    });
    assert.equal(nextResult.exitCode, 0);
    if (nextResult.stdout) {
      const parsed = JSON.parse(nextResult.stdout);
      assert.ok(parsed.hookSpecificOutput.additionalContext.includes('auth.ts'));
    }
  });

  it('multiple interested agents all get file_freed', () => {
    registerAgent(collabDir, 'sess-A');
    registerAgent(collabDir, 'sess-B');
    registerAgent(collabDir, 'sess-C');
    writeContext(collabDir, 'sess-A', {
      task: 'owns shared.js',
      files: [fe('+', 'shared.js')],
      status: 'in-progress'
    });
    writeContext(collabDir, 'sess-B', { task: 'b work', status: 'in-progress' });
    writeContext(collabDir, 'sess-C', { task: 'c work', status: 'in-progress' });

    // Both B and C are interested
    withAgentsLock(collabDir, (token) => {
      interestIndex.upsert(token, collabDir, 'shared.js', {
        sessionId: 'sess-B', busEventId: 'e1', declaredAt: Date.now(), expiresAt: null
      });
      interestIndex.upsert(token, collabDir, 'shared.js', {
        sessionId: 'sess-C', busEventId: 'e2', declaredAt: Date.now(), expiresAt: null
      });
    });

    // A releases
    runHook(CLEANUP_HOOK, { session_id: 'sess-A', cwd: tmpDir });

    const events = fs.readFileSync(busPath(collabDir), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    const freedForB = events.find(e => e.type === 'file_freed' && e.to === 'sess-B');
    const freedForC = events.find(e => e.type === 'file_freed' && e.to === 'sess-C');
    assert.ok(freedForB, 'Expected file_freed for sess-B');
    assert.ok(freedForC, 'Expected file_freed for sess-C');
  });

  it('interest index is consistent after release', () => {
    registerAgent(collabDir, 'sess-A');
    registerAgent(collabDir, 'sess-B');
    writeContext(collabDir, 'sess-A', {
      task: 'work',
      files: [fe('+', 'target.js')],
      status: 'in-progress'
    });

    withAgentsLock(collabDir, (token) => {
      // B is interested
      interestIndex.upsert(token, collabDir, 'target.js', {
        sessionId: 'sess-B', busEventId: 'e1', declaredAt: Date.now(), expiresAt: null
      });
      // Also A had some interest in another file
      interestIndex.upsert(token, collabDir, 'other.js', {
        sessionId: 'sess-A', busEventId: 'e2', declaredAt: Date.now(), expiresAt: null
      });
    });

    // A releases
    runHook(CLEANUP_HOOK, { session_id: 'sess-A', cwd: tmpDir });

    // A's interest entries should be removed
    const idx = interestIndex.read(collabDir);
    assert.ok(!idx['other.js'] || idx['other.js'].length === 0);
    // B's interest should still be there
    assert.ok(idx['target.js']);
    assert.ok(idx['target.js'].some(e => e.sessionId === 'sess-B'));
  });
});
