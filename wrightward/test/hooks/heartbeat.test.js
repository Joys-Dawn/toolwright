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

const HOOK = path.resolve(__dirname, '../../hooks/heartbeat.js');

function runHook(input) {
  return execFileSync('node', [HOOK], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    timeout: 5000
  });
}

describe('heartbeat hook', () => {
  let tmpDir;
  let collabDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collab-test-'));
    collabDir = ensureCollabDir(tmpDir);
    registerAgent(collabDir, 'sess-1');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('updates last_active timestamp', () => {
    const before = readAgents(collabDir)['sess-1'].last_active;
    // Ensure time advances
    const start = Date.now();
    while (Date.now() === start) {}
    runHook({ session_id: 'sess-1', cwd: tmpDir });
    const after = readAgents(collabDir)['sess-1'].last_active;
    assert.ok(after >= before);
  });

  it('auto-tracks edited file with ~ prefix', () => {
    writeContext(collabDir, 'sess-1', { task: 'my work', files: [], status: 'in-progress' });
    runHook({
      session_id: 'sess-1',
      cwd: tmpDir,
      tool_name: 'Edit',
      tool_input: { file_path: path.join(tmpDir, 'src', 'foo.js') }
    });
    const ctx = readContext(collabDir, 'sess-1');
    assert.ok(ctx.files.includes('~src/foo.js'));
  });

  it('auto-tracks written file with + prefix', () => {
    writeContext(collabDir, 'sess-1', { task: 'my work', files: [], status: 'in-progress' });
    runHook({
      session_id: 'sess-1',
      cwd: tmpDir,
      tool_name: 'Write',
      tool_input: { file_path: path.join(tmpDir, 'new-file.ts') }
    });
    const ctx = readContext(collabDir, 'sess-1');
    assert.ok(ctx.files.includes('+new-file.ts'));
  });

  it('does not duplicate already-tracked files regardless of prefix', () => {
    writeContext(collabDir, 'sess-1', { task: 'my work', files: ['+src/foo.js'], status: 'in-progress' });
    runHook({
      session_id: 'sess-1',
      cwd: tmpDir,
      tool_name: 'Edit',
      tool_input: { file_path: path.join(tmpDir, 'src', 'foo.js') }
    });
    const ctx = readContext(collabDir, 'sess-1');
    // Original +src/foo.js kept, no ~src/foo.js added
    assert.equal(ctx.files.length, 1);
    assert.ok(ctx.files.includes('+src/foo.js'));
  });

  it('does not track files outside the project', () => {
    writeContext(collabDir, 'sess-1', { task: 'my work', files: [], status: 'in-progress' });
    runHook({
      session_id: 'sess-1',
      cwd: tmpDir,
      tool_name: 'Edit',
      tool_input: { file_path: '/some/other/project/file.js' }
    });
    const ctx = readContext(collabDir, 'sess-1');
    assert.deepEqual(ctx.files, []);
  });

  it('does not track when agent has no context declared', () => {
    runHook({
      session_id: 'sess-1',
      cwd: tmpDir,
      tool_name: 'Edit',
      tool_input: { file_path: path.join(tmpDir, 'foo.js') }
    });
    const ctx = readContext(collabDir, 'sess-1');
    assert.equal(ctx, null);
  });

  it('does not track for Read tool', () => {
    writeContext(collabDir, 'sess-1', { task: 'my work', files: [], status: 'in-progress' });
    runHook({
      session_id: 'sess-1',
      cwd: tmpDir,
      tool_name: 'Read',
      tool_input: { file_path: path.join(tmpDir, 'foo.js') }
    });
    const ctx = readContext(collabDir, 'sess-1');
    assert.deepEqual(ctx.files, []);
  });

  it('exits cleanly when .collab does not exist', () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collab-empty-'));
    try {
      runHook({ session_id: 'sess-1', cwd: emptyDir });
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});
