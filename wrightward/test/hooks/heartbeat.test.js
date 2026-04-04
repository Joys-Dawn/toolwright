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
  try {
    const stdout = execFileSync('node', [HOOK], {
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
    const start = Date.now();
    while (Date.now() === start) {}
    runHook({ session_id: 'sess-1', cwd: tmpDir });
    const after = readAgents(collabDir)['sess-1'].last_active;
    assert.ok(after >= before);
  });

  it('auto-tracks edited file as object entry with ~ prefix', () => {
    writeContext(collabDir, 'sess-1', { task: 'my work', files: [], status: 'in-progress' });
    runHook({
      session_id: 'sess-1',
      cwd: tmpDir,
      tool_name: 'Edit',
      tool_input: { file_path: path.join(tmpDir, 'src', 'foo.js') }
    });
    const ctx = readContext(collabDir, 'sess-1');
    assert.equal(ctx.files.length, 1);
    assert.equal(ctx.files[0].path, 'src/foo.js');
    assert.equal(ctx.files[0].prefix, '~');
    assert.equal(ctx.files[0].source, 'auto');
    assert.equal(ctx.files[0].reminded, false);
  });

  it('auto-tracks written file as object entry with + prefix', () => {
    writeContext(collabDir, 'sess-1', { task: 'my work', files: [], status: 'in-progress' });
    runHook({
      session_id: 'sess-1',
      cwd: tmpDir,
      tool_name: 'Write',
      tool_input: { file_path: path.join(tmpDir, 'new-file.ts') }
    });
    const ctx = readContext(collabDir, 'sess-1');
    assert.equal(ctx.files.length, 1);
    assert.equal(ctx.files[0].path, 'new-file.ts');
    assert.equal(ctx.files[0].prefix, '+');
    assert.equal(ctx.files[0].source, 'auto');
  });

  it('updates lastTouched and resets reminded for existing file', () => {
    const oldTime = Date.now() - 600000;
    writeContext(collabDir, 'sess-1', {
      task: 'my work',
      files: [{
        path: 'src/foo.js', prefix: '+', source: 'planned',
        declaredAt: oldTime, lastTouched: oldTime, reminded: true
      }],
      status: 'in-progress'
    });
    const before = Date.now();
    runHook({
      session_id: 'sess-1',
      cwd: tmpDir,
      tool_name: 'Edit',
      tool_input: { file_path: path.join(tmpDir, 'src', 'foo.js') }
    });
    const ctx = readContext(collabDir, 'sess-1');
    assert.equal(ctx.files.length, 1);
    assert.equal(ctx.files[0].prefix, '+');
    assert.equal(ctx.files[0].source, 'planned');
    assert.ok(ctx.files[0].lastTouched >= before);
    assert.equal(ctx.files[0].reminded, false);
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
    assert.equal(ctx.files.length, 0);
  });

  it('auto-creates context when agent has no context declared', () => {
    runHook({
      session_id: 'sess-1',
      cwd: tmpDir,
      tool_name: 'Edit',
      tool_input: { file_path: path.join(tmpDir, 'foo.js') }
    });
    const ctx = readContext(collabDir, 'sess-1');
    assert.notEqual(ctx, null);
    assert.equal(ctx.task, 'Auto-tracked (no task declared)');
    assert.equal(ctx.files.length, 1);
    assert.equal(ctx.files[0].path, 'foo.js');
    assert.equal(ctx.files[0].source, 'auto');
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
    assert.equal(ctx.files.length, 0);
  });

  it('exits cleanly when .claude/collab does not exist and tool is Read', () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collab-empty-'));
    try {
      const result = runHook({ session_id: 'sess-1', cwd: emptyDir, tool_name: 'Read', tool_input: {} });
      assert.equal(result.exitCode, 0);
      // Should not have created collabDir
      assert.ok(!fs.existsSync(path.join(emptyDir, '.claude', 'collab')));
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it('creates collabDir when .claude/collab does not exist and tool is Edit', () => {
    // Use a dir at filesystem root so walk-up can't find a real .claude/collab
    const { root: fsRoot } = path.parse(tmpDir);
    const emptyDir = path.join(fsRoot, '__collab_heartbeat_test_' + process.pid);
    fs.mkdirSync(emptyDir, { recursive: true });
    try {
      const result = runHook({
        session_id: 'sess-1',
        cwd: emptyDir,
        tool_name: 'Edit',
        tool_input: { file_path: path.join(emptyDir, 'foo.js') }
      });
      assert.equal(result.exitCode, 0);
      assert.ok(fs.existsSync(path.join(emptyDir, '.claude', 'collab')));
      const ctx = readContext(path.join(emptyDir, '.claude', 'collab'), 'sess-1');
      assert.notEqual(ctx, null);
      assert.equal(ctx.files[0].path, 'foo.js');
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it('emits idle reminder for files not touched within REMINDER_IDLE_MS', () => {
    const oldTime = Date.now() - 400000; // 6+ minutes ago
    writeContext(collabDir, 'sess-1', {
      task: 'my work',
      files: [
        { path: 'old.js', prefix: '~', source: 'auto', declaredAt: oldTime, lastTouched: oldTime, reminded: false },
        { path: 'recent.js', prefix: '~', source: 'auto', declaredAt: Date.now(), lastTouched: Date.now(), reminded: false }
      ],
      status: 'in-progress'
    });
    const result = runHook({
      session_id: 'sess-1',
      cwd: tmpDir,
      tool_name: 'Edit',
      tool_input: { file_path: path.join(tmpDir, 'another.js') }
    });
    assert.equal(result.exitCode, 0);
    assert.ok(result.stdout.length > 0);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.hookSpecificOutput.hookEventName, 'PostToolUse');
    assert.ok(parsed.hookSpecificOutput.additionalContext.includes('old.js'));
    assert.ok(!parsed.hookSpecificOutput.additionalContext.includes('recent.js'));

    // Verify reminded flag is set
    const ctx = readContext(collabDir, 'sess-1');
    const oldEntry = ctx.files.find(f => f.path === 'old.js');
    assert.equal(oldEntry.reminded, true);
  });

  it('does not re-emit reminder for already-reminded files', () => {
    const oldTime = Date.now() - 400000;
    writeContext(collabDir, 'sess-1', {
      task: 'my work',
      files: [
        { path: 'old.js', prefix: '~', source: 'auto', declaredAt: oldTime, lastTouched: oldTime, reminded: true }
      ],
      status: 'in-progress'
    });
    const result = runHook({
      session_id: 'sess-1',
      cwd: tmpDir,
      tool_name: 'Edit',
      tool_input: { file_path: path.join(tmpDir, 'another.js') }
    });
    assert.equal(result.exitCode, 0);
    // No reminder emitted (already reminded)
    assert.equal(result.stdout, '');
  });

  it('does not auto-create context when AUTO_TRACK is false', () => {
    // Write config disabling auto-track
    const claudeDir = path.join(tmpDir, '.claude');
    fs.writeFileSync(path.join(claudeDir, 'wrightward.json'), JSON.stringify({ AUTO_TRACK: false }));

    // Remove existing context so we test the no-context path
    const contextFile = path.join(collabDir, 'context', 'sess-1.json');
    try { fs.unlinkSync(contextFile); } catch (_) {}

    runHook({
      session_id: 'sess-1',
      cwd: tmpDir,
      tool_name: 'Edit',
      tool_input: { file_path: path.join(tmpDir, 'foo.js') }
    });
    const ctx = readContext(collabDir, 'sess-1');
    assert.equal(ctx, null);
  });

  it('does nothing when ENABLED is false', () => {
    const claudeDir = path.join(tmpDir, '.claude');
    fs.writeFileSync(path.join(claudeDir, 'wrightward.json'), JSON.stringify({ ENABLED: false }));
    writeContext(collabDir, 'sess-1', { task: 'my work', files: [], status: 'in-progress' });
    const before = readAgents(collabDir)['sess-1'].last_active;
    const start = Date.now();
    while (Date.now() === start) {}
    runHook({
      session_id: 'sess-1',
      cwd: tmpDir,
      tool_name: 'Edit',
      tool_input: { file_path: path.join(tmpDir, 'foo.js') }
    });
    // Heartbeat should not have updated
    const after = readAgents(collabDir)['sess-1'].last_active;
    assert.equal(after, before);
    // File should not have been tracked
    const ctx = readContext(collabDir, 'sess-1');
    assert.equal(ctx.files.length, 0);
  });

  it('does nothing when ENABLED is false and cwd is a subdirectory', () => {
    const claudeDir = path.join(tmpDir, '.claude');
    fs.writeFileSync(path.join(claudeDir, 'wrightward.json'), JSON.stringify({ ENABLED: false }));
    writeContext(collabDir, 'sess-1', { task: 'my work', files: [], status: 'in-progress' });
    const subDir = path.join(tmpDir, 'app', 'src');
    fs.mkdirSync(subDir, { recursive: true });
    const before = readAgents(collabDir)['sess-1'].last_active;
    const start = Date.now();
    while (Date.now() === start) {}
    runHook({
      session_id: 'sess-1',
      cwd: subDir,
      tool_name: 'Edit',
      tool_input: { file_path: path.join(subDir, 'foo.js') }
    });
    const after = readAgents(collabDir)['sess-1'].last_active;
    assert.equal(after, before);
    const ctx = readContext(collabDir, 'sess-1');
    assert.equal(ctx.files.length, 0);
  });

  it('still tracks into existing context when AUTO_TRACK is false', () => {
    const claudeDir = path.join(tmpDir, '.claude');
    fs.writeFileSync(path.join(claudeDir, 'wrightward.json'), JSON.stringify({ AUTO_TRACK: false }));

    writeContext(collabDir, 'sess-1', { task: 'my work', files: [], status: 'in-progress' });
    runHook({
      session_id: 'sess-1',
      cwd: tmpDir,
      tool_name: 'Edit',
      tool_input: { file_path: path.join(tmpDir, 'foo.js') }
    });
    const ctx = readContext(collabDir, 'sess-1');
    assert.equal(ctx.files.length, 1);
    assert.equal(ctx.files[0].path, 'foo.js');
  });
});
