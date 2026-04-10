'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { ensureCollabDir } = require('../../lib/collab-dir');
const { registerAgent, readAgents } = require('../../lib/agents');
const { writeContext, fileEntryForPath } = require('../../lib/context');
const { hashString } = require('../../lib/hash');

const HOOK = path.resolve(__dirname, '../../hooks/guard.js');

function fe(prefix, filePath) {
  return { ...fileEntryForPath(filePath, prefix, 'planned'), declaredAt: Date.now(), lastTouched: Date.now() };
}

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

describe('guard hook', () => {
  let tmpDir;
  let collabDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collab-test-'));
    collabDir = ensureCollabDir(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('exits 0 when .claude/collab does not exist', () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collab-empty-'));
    try {
      const result = runHook({ session_id: 'sess-1', cwd: emptyDir });
      assert.equal(result.exitCode, 0);
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it('exits 0 when ENABLED is false even with overlapping files', () => {
    registerAgent(collabDir, 'sess-1');
    registerAgent(collabDir, 'sess-2');
    writeContext(collabDir, 'sess-2', {
      task: 'other work',
      files: [fe('+', 'src/foo.js')],
      status: 'in-progress'
    });
    const claudeDir = path.join(tmpDir, '.claude');
    fs.writeFileSync(path.join(claudeDir, 'wrightward.json'), JSON.stringify({ ENABLED: false }));
    const result = runHook({
      session_id: 'sess-1',
      cwd: tmpDir,
      tool_name: 'Write',
      tool_input: { file_path: path.join(tmpDir, 'src', 'foo.js') }
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, '');
  });

  it('exits 0 when agent has no context but is the only agent', () => {
    registerAgent(collabDir, 'sess-1');
    const result = runHook({ session_id: 'sess-1', cwd: tmpDir });
    assert.equal(result.exitCode, 0);
  });

  it('exits 2 when agent has no context and edit overlaps with another agent', () => {
    registerAgent(collabDir, 'sess-1');
    registerAgent(collabDir, 'sess-2');
    writeContext(collabDir, 'sess-2', { task: 'other work', files: [fe('+', 'target.js')], status: 'in-progress' });
    const result = runHook({
      session_id: 'sess-1',
      cwd: tmpDir,
      tool_name: 'Write',
      tool_input: { file_path: path.join(tmpDir, 'target.js') }
    });
    assert.equal(result.exitCode, 2);
    assert.ok(result.stderr.includes('collab-context'));
  });

  it('exits 0 when agent has no context but edit does not overlap', () => {
    registerAgent(collabDir, 'sess-1');
    registerAgent(collabDir, 'sess-2');
    writeContext(collabDir, 'sess-2', { task: 'other work', files: [fe('+', 'other.js')], status: 'in-progress' });
    const result = runHook({
      session_id: 'sess-1',
      cwd: tmpDir,
      tool_name: 'Write',
      tool_input: { file_path: path.join(tmpDir, 'unrelated.js') }
    });
    assert.equal(result.exitCode, 0);
  });

  it('exits 0 when no other agents', () => {
    registerAgent(collabDir, 'sess-1');
    writeContext(collabDir, 'sess-1', { task: 'my work', status: 'in-progress' });
    const result = runHook({ session_id: 'sess-1', cwd: tmpDir });
    assert.equal(result.exitCode, 0);
  });

  it('blocks when Write targets a file another agent declared', () => {
    registerAgent(collabDir, 'sess-1');
    registerAgent(collabDir, 'sess-2');
    writeContext(collabDir, 'sess-1', { task: 'my work', status: 'in-progress' });
    writeContext(collabDir, 'sess-2', { task: 'their work', files: [fe('~', 'foo.js')], status: 'in-progress' });

    const result = runHook({
      session_id: 'sess-1',
      cwd: tmpDir,
      tool_name: 'Write',
      tool_input: { file_path: path.join(tmpDir, 'foo.js') }
    });
    assert.equal(result.exitCode, 2);
    assert.ok(result.stderr.includes('their work'));
    assert.ok(result.stderr.includes('foo.js'));
  });

  it('injects non-blocking context when Write targets unrelated file', () => {
    registerAgent(collabDir, 'sess-1');
    registerAgent(collabDir, 'sess-2');
    writeContext(collabDir, 'sess-1', { task: 'my work', status: 'in-progress' });
    writeContext(collabDir, 'sess-2', { task: 'their work', files: [fe('~', 'foo.js')], status: 'in-progress' });

    const result = runHook({
      session_id: 'sess-1',
      cwd: tmpDir,
      tool_name: 'Write',
      tool_input: { file_path: path.join(tmpDir, 'unrelated.js') }
    });
    assert.equal(result.exitCode, 0);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.equal(parsed.hookSpecificOutput.permissionDecision, 'allow');
    assert.ok(parsed.hookSpecificOutput.additionalContext.includes('their work'));
  });

  it('exits 0 on second call when nothing changed', () => {
    registerAgent(collabDir, 'sess-1');
    registerAgent(collabDir, 'sess-2');
    writeContext(collabDir, 'sess-1', { task: 'my work', status: 'in-progress' });
    writeContext(collabDir, 'sess-2', { task: 'their work', files: [fe('~', 'foo.js')], status: 'in-progress' });

    // First call injects context (non-blocking, no file overlap)
    const first = runHook({
      session_id: 'sess-1',
      cwd: tmpDir,
      tool_name: 'Write',
      tool_input: { file_path: path.join(tmpDir, 'other.js') }
    });
    assert.equal(first.exitCode, 0);

    // Second call passes (nothing new)
    const second = runHook({
      session_id: 'sess-1',
      cwd: tmpDir,
      tool_name: 'Write',
      tool_input: { file_path: path.join(tmpDir, 'other.js') }
    });
    assert.equal(second.exitCode, 0);
  });

  it('always blocks on file overlap even when context unchanged', () => {
    registerAgent(collabDir, 'sess-1');
    registerAgent(collabDir, 'sess-2');
    writeContext(collabDir, 'sess-1', { task: 'my work', status: 'in-progress' });
    writeContext(collabDir, 'sess-2', { task: 'their work', files: [fe('~', 'shared.js')], status: 'in-progress' });

    // First call blocks
    const first = runHook({
      session_id: 'sess-1',
      cwd: tmpDir,
      tool_name: 'Write',
      tool_input: { file_path: path.join(tmpDir, 'shared.js') }
    });
    assert.equal(first.exitCode, 2);

    // Second call still blocks (file overlap persists regardless of hash)
    const second = runHook({
      session_id: 'sess-1',
      cwd: tmpDir,
      tool_name: 'Write',
      tool_input: { file_path: path.join(tmpDir, 'shared.js') }
    });
    assert.equal(second.exitCode, 2);
  });

  it('blocks again when other agent updates context and file overlaps', () => {
    registerAgent(collabDir, 'sess-1');
    registerAgent(collabDir, 'sess-2');
    writeContext(collabDir, 'sess-1', { task: 'my work', status: 'in-progress' });
    writeContext(collabDir, 'sess-2', { task: 'original task', files: [fe('~', 'shared.js')], status: 'in-progress' });

    // First call blocks (file overlap)
    runHook({
      session_id: 'sess-1',
      cwd: tmpDir,
      tool_name: 'Edit',
      tool_input: { file_path: path.join(tmpDir, 'shared.js') }
    });

    // Agent 2 updates context
    writeContext(collabDir, 'sess-2', { task: 'new task', files: [fe('~', 'shared.js')], status: 'in-progress' });

    // Should block again (file still overlaps + context changed)
    const result = runHook({
      session_id: 'sess-1',
      cwd: tmpDir,
      tool_name: 'Edit',
      tool_input: { file_path: path.join(tmpDir, 'shared.js') }
    });
    assert.equal(result.exitCode, 2);
    assert.ok(result.stderr.includes('new task'));
  });

  it('skips agents with status=done without cleaning them up', () => {
    registerAgent(collabDir, 'sess-1');
    registerAgent(collabDir, 'sess-2');
    writeContext(collabDir, 'sess-1', { task: 'my work', status: 'in-progress' });
    writeContext(collabDir, 'sess-2', { task: 'done work', status: 'done' });

    const result = runHook({ session_id: 'sess-1', cwd: tmpDir, tool_name: 'Write', tool_input: { file_path: path.join(tmpDir, 'x.js') } });
    assert.equal(result.exitCode, 0);

    // Context file for done agent should still exist (cleanup is heartbeat's job)
    const contextFile = path.join(collabDir, 'context', 'sess-2.json');
    assert.ok(fs.existsSync(contextFile));
  });

  it('skips stale agents', () => {
    // Register sess-1 as active
    registerAgent(collabDir, 'sess-1');
    writeContext(collabDir, 'sess-1', { task: 'my work', status: 'in-progress' });

    // Register sess-2 as stale (last active 11 min ago)
    const agents = JSON.parse(fs.readFileSync(path.join(collabDir, 'agents.json'), 'utf8'));
    agents['sess-2'] = { registered_at: Date.now() - 700000, last_active: Date.now() - 700000 };
    fs.writeFileSync(path.join(collabDir, 'agents.json'), JSON.stringify(agents), 'utf8');
    writeContext(collabDir, 'sess-2', { task: 'stale work', status: 'in-progress' });

    const result = runHook({ session_id: 'sess-1', cwd: tmpDir });
    assert.equal(result.exitCode, 0);
  });

  it('ignores agents stale beyond INACTIVE_THRESHOLD_MS via getActiveAgents', () => {
    registerAgent(collabDir, 'sess-1');
    writeContext(collabDir, 'sess-1', { task: 'my work', status: 'in-progress' });

    const agentsFilePath = path.join(collabDir, 'agents.json');
    const agents = JSON.parse(fs.readFileSync(agentsFilePath, 'utf8'));
    agents['sess-2'] = {
      registered_at: Date.now() - 61 * 60 * 1000,
      last_active: Date.now() - 61 * 60 * 1000
    };
    fs.writeFileSync(agentsFilePath, JSON.stringify(agents), 'utf8');

    writeContext(collabDir, 'sess-2', { task: 'ancient work', status: 'in-progress' });

    // Guard ignores stale agents (no scavenging — that's heartbeat's job)
    const result = runHook({ session_id: 'sess-1', cwd: tmpDir, tool_name: 'Write', tool_input: { file_path: path.join(tmpDir, 'x.js') } });
    assert.equal(result.exitCode, 0);
    // Agent entry still exists (not cleaned up by guard)
    assert.ok(readAgents(collabDir)['sess-2'] !== undefined);
  });

  it('injects re-declare reminder when agent resumes after being idle with no context', () => {
    // Register agent and then make it stale (past the inactive threshold)
    const agentsFilePath = path.join(collabDir, 'agents.json');
    const agents = {
      'sess-1': {
        registered_at: Date.now() - 10 * 60 * 1000,
        last_active: Date.now() - 10 * 60 * 1000
      }
    };
    fs.writeFileSync(agentsFilePath, JSON.stringify(agents), 'utf8');
    // No context file — simulates scavenged or never-declared context

    const result = runHook({
      session_id: 'sess-1',
      cwd: tmpDir,
      tool_name: 'Read',
      tool_input: { file_path: path.join(tmpDir, 'anything.js') }
    });
    assert.equal(result.exitCode, 0);
    const output = JSON.parse(result.stdout);
    assert.equal(output.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.equal(output.hookSpecificOutput.permissionDecision, 'allow');
    assert.ok(output.hookSpecificOutput.additionalContext.includes('collab-context'));
    assert.ok(output.hookSpecificOutput.additionalContext.includes('inactive'));
  });

  it('does not inject re-declare reminder when agent is idle but still has context', () => {
    const agentsFilePath = path.join(collabDir, 'agents.json');
    const agents = {
      'sess-1': {
        registered_at: Date.now() - 10 * 60 * 1000,
        last_active: Date.now() - 10 * 60 * 1000
      }
    };
    fs.writeFileSync(agentsFilePath, JSON.stringify(agents), 'utf8');
    writeContext(collabDir, 'sess-1', { task: 'my work', status: 'in-progress' });

    const result = runHook({
      session_id: 'sess-1',
      cwd: tmpDir,
      tool_name: 'Read',
      tool_input: { file_path: path.join(tmpDir, 'anything.js') }
    });
    // Should exit cleanly with no output (no other agents, no reminder)
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, '');
  });

  it('adds non-blocking overlap context for Read on another agent file', () => {
    registerAgent(collabDir, 'sess-1');
    registerAgent(collabDir, 'sess-2');
    writeContext(collabDir, 'sess-1', { task: 'my work', status: 'in-progress' });
    writeContext(collabDir, 'sess-2', {
      task: 'their work',
      files: [fe('~', 'src/shared.js')],
      functions: ['~sharedThing'],
      status: 'in-progress'
    });

    const result = runHook({
      session_id: 'sess-1',
      cwd: tmpDir,
      tool_name: 'Read',
      tool_input: { file_path: path.join(tmpDir, 'src', 'shared.js') }
    });

    assert.equal(result.exitCode, 0);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.equal(parsed.hookSpecificOutput.permissionDecision, 'allow');
    assert.ok(parsed.hookSpecificOutput.additionalContext.includes('their work'));
    assert.ok(parsed.hookSpecificOutput.additionalContext.includes('src/shared.js'));
  });

  it('adds non-blocking overlap context for Glob when glob matches another agent file', () => {
    registerAgent(collabDir, 'sess-1');
    registerAgent(collabDir, 'sess-2');
    writeContext(collabDir, 'sess-1', { task: 'my work', status: 'in-progress' });
    writeContext(collabDir, 'sess-2', {
      task: 'their work',
      files: [fe('~', 'src/shared.js')],
      status: 'in-progress'
    });

    const result = runHook({
      session_id: 'sess-1',
      cwd: tmpDir,
      tool_name: 'Glob',
      tool_input: {
        pattern: '**/*.js',
        path: path.join(tmpDir, 'src')
      }
    });

    assert.equal(result.exitCode, 0);
    const parsed = JSON.parse(result.stdout);
    assert.ok(parsed.hookSpecificOutput.additionalContext.includes('their work'));
  });

  it('adds non-blocking overlap context for Glob without explicit path (defaults to cwd)', () => {
    registerAgent(collabDir, 'sess-1');
    registerAgent(collabDir, 'sess-2');
    writeContext(collabDir, 'sess-1', { task: 'my work', status: 'in-progress' });
    writeContext(collabDir, 'sess-2', {
      task: 'their work',
      files: [fe('~', 'src/shared.js')],
      status: 'in-progress'
    });

    const result = runHook({
      session_id: 'sess-1',
      cwd: tmpDir,
      tool_name: 'Glob',
      tool_input: {
        pattern: '**/*.js'
        // no path — should default to cwd
      }
    });

    assert.equal(result.exitCode, 0);
    const parsed = JSON.parse(result.stdout);
    assert.ok(parsed.hookSpecificOutput.additionalContext.includes('their work'));
  });

  it('adds non-blocking overlap context for Grep without explicit path (defaults to cwd)', () => {
    registerAgent(collabDir, 'sess-1');
    registerAgent(collabDir, 'sess-2');
    writeContext(collabDir, 'sess-1', { task: 'my work', status: 'in-progress' });
    writeContext(collabDir, 'sess-2', {
      task: 'their work',
      files: [fe('~', 'lib/utils.js')],
      status: 'in-progress'
    });

    const result = runHook({
      session_id: 'sess-1',
      cwd: tmpDir,
      tool_name: 'Grep',
      tool_input: {
        pattern: 'someFunction'
        // no path, no glob — should default to cwd
      }
    });

    assert.equal(result.exitCode, 0);
    const parsed = JSON.parse(result.stdout);
    assert.ok(parsed.hookSpecificOutput.additionalContext.includes('their work'));
  });

  it('adds non-blocking overlap context for Grep scoped to another agent file', () => {
    registerAgent(collabDir, 'sess-1');
    registerAgent(collabDir, 'sess-2');
    writeContext(collabDir, 'sess-1', { task: 'my work', status: 'in-progress' });
    writeContext(collabDir, 'sess-2', {
      task: 'their work',
      files: [fe('~', 'src/shared.js')],
      status: 'in-progress'
    });

    const result = runHook({
      session_id: 'sess-1',
      cwd: tmpDir,
      tool_name: 'Grep',
      tool_input: {
        pattern: 'shared',
        path: path.join(tmpDir, 'src'),
        glob: '*.js'
      }
    });

    assert.equal(result.exitCode, 0);
    const parsed = JSON.parse(result.stdout);
    assert.ok(parsed.hookSpecificOutput.additionalContext.includes('their work'));
  });

  it('blocks Edit on overlapping file just like Write', () => {
    registerAgent(collabDir, 'sess-1');
    registerAgent(collabDir, 'sess-2');
    writeContext(collabDir, 'sess-1', { task: 'my work', status: 'in-progress' });
    writeContext(collabDir, 'sess-2', { task: 'their work', files: [fe('~', 'shared.js')], status: 'in-progress' });

    const result = runHook({
      session_id: 'sess-1',
      cwd: tmpDir,
      tool_name: 'Edit',
      tool_input: { file_path: path.join(tmpDir, 'shared.js') }
    });
    assert.equal(result.exitCode, 2);
    assert.ok(result.stderr.includes('their work'));
  });

  it('exits 0 for Read on non-overlapping file', () => {
    registerAgent(collabDir, 'sess-1');
    registerAgent(collabDir, 'sess-2');
    writeContext(collabDir, 'sess-1', { task: 'my work', status: 'in-progress' });
    writeContext(collabDir, 'sess-2', { task: 'their work', files: [fe('~', 'foo.js')], status: 'in-progress' });

    const result = runHook({
      session_id: 'sess-1',
      cwd: tmpDir,
      tool_name: 'Read',
      tool_input: { file_path: path.join(tmpDir, 'unrelated.js') }
    });
    assert.equal(result.exitCode, 0);
    // No overlap means no stdout context injection either
    assert.equal(result.stdout, '');
  });

  it('includes all overlapping agents in summary when multiple overlap', () => {
    registerAgent(collabDir, 'sess-1');
    registerAgent(collabDir, 'sess-2');
    registerAgent(collabDir, 'sess-3');
    writeContext(collabDir, 'sess-1', { task: 'my work', status: 'in-progress' });
    writeContext(collabDir, 'sess-2', { task: 'agent-two task', files: [fe('~', 'shared.js')], status: 'in-progress' });
    writeContext(collabDir, 'sess-3', { task: 'agent-three task', files: [fe('~', 'shared.js')], status: 'in-progress' });

    const result = runHook({
      session_id: 'sess-1',
      cwd: tmpDir,
      tool_name: 'Write',
      tool_input: { file_path: path.join(tmpDir, 'shared.js') }
    });
    assert.equal(result.exitCode, 2);
    assert.ok(result.stderr.includes('agent-two task'));
    assert.ok(result.stderr.includes('agent-three task'));
  });

  it('exits 0 when tool_name is missing (no-op)', () => {
    registerAgent(collabDir, 'sess-1');
    registerAgent(collabDir, 'sess-2');
    writeContext(collabDir, 'sess-1', { task: 'my work', status: 'in-progress' });
    writeContext(collabDir, 'sess-2', { task: 'their work', files: [fe('~', 'target.js')], status: 'in-progress' });

    const result = runHook({
      session_id: 'sess-1',
      cwd: tmpDir,
      // tool_name omitted — guard exits early
      tool_input: { file_path: path.join(tmpDir, 'target.js') }
    });
    assert.equal(result.exitCode, 0);
  });

  describe('hard block on .claude/collab/ files', () => {
    it('blocks Edit on agents.json even when solo', () => {
      registerAgent(collabDir, 'sess-1');
      const result = runHook({
        session_id: 'sess-1',
        cwd: tmpDir,
        tool_name: 'Edit',
        tool_input: { file_path: path.join(collabDir, 'agents.json') }
      });
      assert.equal(result.exitCode, 2);
      assert.ok(result.stderr.includes('BLOCKED'));
      assert.ok(result.stderr.includes('.claude/collab/'));
    });

    it('blocks Write on another agent\'s context file', () => {
      registerAgent(collabDir, 'sess-1');
      registerAgent(collabDir, 'sess-2');
      writeContext(collabDir, 'sess-2', {
        task: 'other work',
        files: [fe('~', 'target.js')],
        status: 'in-progress'
      });
      const result = runHook({
        session_id: 'sess-1',
        cwd: tmpDir,
        tool_name: 'Write',
        tool_input: { file_path: path.join(collabDir, 'context', 'sess-2.json') }
      });
      assert.equal(result.exitCode, 2);
      assert.ok(result.stderr.includes('BLOCKED'));
      // The other agent's context file must still exist — the block prevents the write
      const otherContextPath = path.join(collabDir, 'context', 'sess-2.json');
      assert.ok(fs.existsSync(otherContextPath));
      const stillThere = JSON.parse(fs.readFileSync(otherContextPath, 'utf8'));
      assert.equal(stillThere.task, 'other work');
    });

    it('blocks Edit on own context file', () => {
      registerAgent(collabDir, 'sess-1');
      writeContext(collabDir, 'sess-1', { task: 'my work', status: 'in-progress' });
      const result = runHook({
        session_id: 'sess-1',
        cwd: tmpDir,
        tool_name: 'Edit',
        tool_input: { file_path: path.join(collabDir, 'context', 'sess-1.json') }
      });
      assert.equal(result.exitCode, 2);
      assert.ok(result.stderr.includes('BLOCKED'));
    });

    it('blocks Edit on the root file', () => {
      registerAgent(collabDir, 'sess-1');
      const result = runHook({
        session_id: 'sess-1',
        cwd: tmpDir,
        tool_name: 'Edit',
        tool_input: { file_path: path.join(collabDir, 'root') }
      });
      assert.equal(result.exitCode, 2);
      assert.ok(result.stderr.includes('BLOCKED'));
    });

    it('blocks Write on a new file inside .claude/collab/', () => {
      registerAgent(collabDir, 'sess-1');
      const result = runHook({
        session_id: 'sess-1',
        cwd: tmpDir,
        tool_name: 'Write',
        tool_input: { file_path: path.join(collabDir, 'malicious.json') }
      });
      assert.equal(result.exitCode, 2);
      assert.ok(result.stderr.includes('BLOCKED'));
    });

    it('allows Read on .claude/collab/ files (inspection is fine)', () => {
      registerAgent(collabDir, 'sess-1');
      const result = runHook({
        session_id: 'sess-1',
        cwd: tmpDir,
        tool_name: 'Read',
        tool_input: { file_path: path.join(collabDir, 'agents.json') }
      });
      assert.equal(result.exitCode, 0);
    });

    it('does not block Edit on a file named similarly outside collab dir', () => {
      registerAgent(collabDir, 'sess-1');
      // Path that shares a prefix but isn't actually inside .claude/collab/
      const siblingPath = path.join(tmpDir, '.claude', 'collab-sibling.json');
      const result = runHook({
        session_id: 'sess-1',
        cwd: tmpDir,
        tool_name: 'Edit',
        tool_input: { file_path: siblingPath }
      });
      assert.equal(result.exitCode, 0);
    });

    it('block applies even when ENABLED=true with no other agents', () => {
      registerAgent(collabDir, 'sess-1');
      // No other agents, default config — the block still fires
      const result = runHook({
        session_id: 'sess-1',
        cwd: tmpDir,
        tool_name: 'Edit',
        tool_input: { file_path: path.join(collabDir, 'context', 'sess-2.json') }
      });
      assert.equal(result.exitCode, 2);
      assert.ok(result.stderr.includes('BLOCKED'));
    });

    it('block is skipped when ENABLED=false (plugin disabled)', () => {
      registerAgent(collabDir, 'sess-1');
      const claudeDir = path.join(tmpDir, '.claude');
      fs.writeFileSync(path.join(claudeDir, 'wrightward.json'), JSON.stringify({ ENABLED: false }));
      const result = runHook({
        session_id: 'sess-1',
        cwd: tmpDir,
        tool_name: 'Edit',
        tool_input: { file_path: path.join(collabDir, 'agents.json') }
      });
      assert.equal(result.exitCode, 0);
    });
  });

  it('skips files with deleted prefix (-) from overlap detection', () => {
    registerAgent(collabDir, 'sess-1');
    registerAgent(collabDir, 'sess-2');
    writeContext(collabDir, 'sess-1', { task: 'my work', status: 'in-progress' });
    writeContext(collabDir, 'sess-2', { task: 'removing old code', files: [fe('-', 'obsolete.js')], status: 'in-progress' });

    const result = runHook({
      session_id: 'sess-1',
      cwd: tmpDir,
      tool_name: 'Write',
      tool_input: { file_path: path.join(tmpDir, 'obsolete.js') }
    });
    // Deletion files don't trigger overlap — no conflict if both agents delete
    assert.equal(result.exitCode, 0);
  });

});
