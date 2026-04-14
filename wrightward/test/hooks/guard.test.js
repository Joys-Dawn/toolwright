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
const { withAgentsLock } = require('../../lib/agents');
const { append, busPath, readBookmark } = require('../../lib/bus-log');
const { createEvent } = require('../../lib/bus-schema');
const interestIndex = require('../../lib/interest-index');

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
    assert.match(result.stderr, /collab-context/);
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
    assert.match(result.stderr, /their work/);
    assert.match(result.stderr, /foo\.js/);
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
    assert.match(parsed.hookSpecificOutput.additionalContext, /their work/);
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
    assert.match(result.stderr, /new task/);
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
    assert.match(output.hookSpecificOutput.additionalContext, /collab-context/);
    assert.match(output.hookSpecificOutput.additionalContext, /inactive/);
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
    assert.match(parsed.hookSpecificOutput.additionalContext, /their work/);
    assert.match(parsed.hookSpecificOutput.additionalContext, /src\/shared\.js/);
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
    assert.match(parsed.hookSpecificOutput.additionalContext, /their work/);
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
    assert.match(parsed.hookSpecificOutput.additionalContext, /their work/);
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
    assert.match(parsed.hookSpecificOutput.additionalContext, /their work/);
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
    assert.match(parsed.hookSpecificOutput.additionalContext, /their work/);
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
    assert.match(result.stderr, /their work/);
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
    assert.match(result.stderr, /agent-two task/);
    assert.match(result.stderr, /agent-three task/);
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
      assert.match(result.stderr, /BLOCKED/);
      assert.match(result.stderr, /\.claude\/collab\//);
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
      assert.match(result.stderr, /BLOCKED/);
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
      assert.match(result.stderr, /BLOCKED/);
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
      assert.match(result.stderr, /BLOCKED/);
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
      assert.match(result.stderr, /BLOCKED/);
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
      assert.match(result.stderr, /BLOCKED/);
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

  // Bus-specific tests
  describe('bus integration', () => {
    it('emits interest event when Write is blocked by overlap', () => {
      registerAgent(collabDir, 'sess-1');
      registerAgent(collabDir, 'sess-2');
      writeContext(collabDir, 'sess-1', { task: 'my work', status: 'in-progress' });
      writeContext(collabDir, 'sess-2', { task: 'their work', files: [fe('~', 'target.js')], status: 'in-progress' });

      runHook({
        session_id: 'sess-1',
        cwd: tmpDir,
        tool_name: 'Write',
        tool_input: { file_path: path.join(tmpDir, 'target.js') }
      });

      // Check bus for interest event
      const bp = busPath(collabDir);
      assert.ok(fs.existsSync(bp), 'bus.jsonl must exist after Write block');
      const events = fs.readFileSync(bp, 'utf8').trim().split('\n').map(l => JSON.parse(l));
      const interest = events.find(e => e.type === 'interest');
      assert.ok(interest, 'Expected interest event on bus');
      assert.equal(interest.from, 'sess-1');
      assert.equal(interest.meta.file, 'target.js');
    });

    it('updates interest index when Write is blocked', () => {
      registerAgent(collabDir, 'sess-1');
      registerAgent(collabDir, 'sess-2');
      writeContext(collabDir, 'sess-1', { task: 'my work', status: 'in-progress' });
      writeContext(collabDir, 'sess-2', { task: 'their work', files: [fe('~', 'blocked.js')], status: 'in-progress' });

      runHook({
        session_id: 'sess-1',
        cwd: tmpDir,
        tool_name: 'Write',
        tool_input: { file_path: path.join(tmpDir, 'blocked.js') }
      });

      const idx = interestIndex.read(collabDir);
      const entries = idx['blocked.js'] || [];
      assert.ok(entries.some(e => e.sessionId === 'sess-1'));
    });

    it('block message informs the agent that interest was recorded and it will be notified', () => {
      // Without this signal, the blocked agent has no idea the plugin will
      // notify it when the file frees up — it may just move on assuming the
      // file is permanently off-limits. Pin the user-facing line.
      registerAgent(collabDir, 'sess-1');
      registerAgent(collabDir, 'sess-2');
      writeContext(collabDir, 'sess-1', { task: 'my work', status: 'in-progress' });
      writeContext(collabDir, 'sess-2', { task: 'their work', files: [fe('~', 'target.js')], status: 'in-progress' });

      const result = runHook({
        session_id: 'sess-1',
        cwd: tmpDir,
        tool_name: 'Write',
        tool_input: { file_path: path.join(tmpDir, 'target.js') }
      });
      assert.equal(result.exitCode, 2, 'Write should be blocked');
      assert.match(result.stderr, /interest has been recorded/i);
      assert.match(result.stderr, /notification will wake you when this file frees up/i);
      // Time-expectation guidance lets the agent decide whether to wait or ask the user.
      assert.match(result.stderr, /auto-tracked.+2 min|declared.+15 min/i);
    });

    it('block message omits the interest-recorded line when BUS_ENABLED is false', () => {
      // When the bus is off, no interest is recorded and the agent will NOT
      // receive a notification. Telling it otherwise would be a lie.
      registerAgent(collabDir, 'sess-1');
      registerAgent(collabDir, 'sess-2');
      writeContext(collabDir, 'sess-1', { task: 'my work', status: 'in-progress' });
      writeContext(collabDir, 'sess-2', { task: 'their work', files: [fe('~', 'target.js')], status: 'in-progress' });

      const claudeDir = path.join(tmpDir, '.claude');
      fs.writeFileSync(path.join(claudeDir, 'wrightward.json'), JSON.stringify({ BUS_ENABLED: false }));

      const result = runHook({
        session_id: 'sess-1',
        cwd: tmpDir,
        tool_name: 'Write',
        tool_input: { file_path: path.join(tmpDir, 'target.js') }
      });
      assert.equal(result.exitCode, 2, 'Write should still be blocked');
      assert.doesNotMatch(result.stderr, /interest has been recorded/i);
    });

    it('injects urgent inbox events as additionalContext', () => {
      registerAgent(collabDir, 'sess-1');
      registerAgent(collabDir, 'sess-2');
      writeContext(collabDir, 'sess-2', { task: 'their work', files: [fe('~', 'other.js')], status: 'in-progress' });

      // Pre-seed an urgent event for sess-1
      withAgentsLock(collabDir, (token) => {
        append(token, collabDir, createEvent('sess-2', 'sess-1', 'handoff', 'take over the auth work'));
      });

      const result = runHook({
        session_id: 'sess-1',
        cwd: tmpDir,
        tool_name: 'Read',
        tool_input: { file_path: path.join(tmpDir, 'other.js') }
      });

      assert.equal(result.exitCode, 0);
      const parsed = JSON.parse(result.stdout);
      assert.match(parsed.hookSpecificOutput.additionalContext, /take over the auth work/);
      assert.match(parsed.hookSpecificOutput.additionalContext, /Urgent messages/);
    });

    it('advances bookmark after inbox injection', () => {
      registerAgent(collabDir, 'sess-1');
      registerAgent(collabDir, 'sess-2');
      writeContext(collabDir, 'sess-2', { task: 'work', files: [fe('~', 'x.js')], status: 'in-progress' });

      withAgentsLock(collabDir, (token) => {
        append(token, collabDir, createEvent('sess-2', 'sess-1', 'handoff', 'task for you'));
      });

      runHook({
        session_id: 'sess-1',
        cwd: tmpDir,
        tool_name: 'Read',
        tool_input: { file_path: path.join(tmpDir, 'x.js') }
      });

      const bm = readBookmark(collabDir, 'sess-1');
      assert.ok(bm.lastDeliveredOffset > 0);
      assert.ok(bm.lastScannedOffset > 0);
    });

    it('does not create bus files when BUS_ENABLED is false', () => {
      registerAgent(collabDir, 'sess-1');
      registerAgent(collabDir, 'sess-2');
      writeContext(collabDir, 'sess-1', { task: 'my work', status: 'in-progress' });
      writeContext(collabDir, 'sess-2', { task: 'their work', files: [fe('~', 'target.js')], status: 'in-progress' });

      const claudeDir = path.join(tmpDir, '.claude');
      fs.writeFileSync(path.join(claudeDir, 'wrightward.json'), JSON.stringify({ BUS_ENABLED: false }));

      runHook({
        session_id: 'sess-1',
        cwd: tmpDir,
        tool_name: 'Write',
        tool_input: { file_path: path.join(tmpDir, 'target.js') }
      });

      assert.ok(!fs.existsSync(busPath(collabDir)));
    });

    it('injects inbox events even with no other agents', () => {
      registerAgent(collabDir, 'sess-1');

      // Pre-seed a broadcast event from a now-dead session
      withAgentsLock(collabDir, (token) => {
        append(token, collabDir, createEvent('sess-dead', 'sess-1', 'file_freed', 'auth.ts is free', { file: 'auth.ts' }));
      });

      const result = runHook({
        session_id: 'sess-1',
        cwd: tmpDir,
        tool_name: 'Read',
        tool_input: { file_path: path.join(tmpDir, 'whatever.js') }
      });

      assert.equal(result.exitCode, 0);
      const parsed = JSON.parse(result.stdout);
      assert.match(parsed.hookSpecificOutput.additionalContext, /auth\.ts is free/);
    });
  });

  it('blocked Write acquires the agents lock exactly once (Sg2)', () => {
    // Pre-Sg2, scanInbox + writeInterest each took the lock — two acquisitions
    // per blocked Write. Now both happen inside one withAgentsLock block.
    // Instrument require cache so the in-process counter survives the spawn.
    // Because runHook spawns a child process we can't share state — instead,
    // verify by monkey-patching agents.js at the source level via env var.
    registerAgent(collabDir, 'sess-1');
    registerAgent(collabDir, 'sess-2');
    writeContext(collabDir, 'sess-1', { task: 'my work', status: 'in-progress' });
    writeContext(collabDir, 'sess-2', { task: 'their work', files: [fe('~', 'blocked.js')], status: 'in-progress' });

    const counterFile = path.join(tmpDir, 'lock-acquisitions.count');
    fs.writeFileSync(counterFile, '0');

    // Wrap node so the spawned guard.js patches withAgentsLock to bump the counter.
    // We do it by setting NODE_OPTIONS to require a tiny shim before guard runs.
    const shimPath = path.join(tmpDir, 'lock-counter-shim.js');
    fs.writeFileSync(shimPath, `
      const fs = require('fs');
      const Module = require('module');
      const origLoad = Module._load;
      Module._load = function(req, parent, isMain) {
        const mod = origLoad.apply(this, arguments);
        if (req.endsWith('lib/agents') || req === '../lib/agents' || req === '../../lib/agents') {
          if (!mod.__counterPatched) {
            const orig = mod.withAgentsLock;
            mod.withAgentsLock = function(dir, fn) {
              const cur = parseInt(fs.readFileSync(${JSON.stringify(counterFile)}, 'utf8'), 10);
              fs.writeFileSync(${JSON.stringify(counterFile)}, String(cur + 1));
              return orig.call(this, dir, fn);
            };
            mod.__counterPatched = true;
          }
        }
        return mod;
      };
    `);

    const env = { ...process.env, NODE_OPTIONS: '--require ' + shimPath };
    try {
      execFileSync('node', [HOOK], {
        input: JSON.stringify({
          session_id: 'sess-1',
          cwd: tmpDir,
          tool_name: 'Write',
          tool_input: { file_path: path.join(tmpDir, 'blocked.js') }
        }),
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['pipe', 'pipe', 'pipe'],
        env
      });
    } catch (_) {
      // exit 2 expected on block
    }

    const acquisitions = parseInt(fs.readFileSync(counterFile, 'utf8'), 10);
    assert.equal(acquisitions, 1, 'blocked Write should acquire the agents lock exactly once, got ' + acquisitions);
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
