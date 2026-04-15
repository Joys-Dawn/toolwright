'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { ensureCollabDir } = require('../../lib/collab-dir');
const { registerAgent } = require('../../lib/agents');
const { writeContext, readContext } = require('../../lib/context');

const HOOK = path.resolve(__dirname, '../../hooks/register.js');

function runHook(input, env) {
  return execFileSync('node', [HOOK], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    timeout: 5000,
    env: { ...process.env, ...env }
  });
}

describe('register hook', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collab-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates .claude/collab directory and registers agent', () => {
    runHook({ session_id: 'test-sess-1', cwd: tmpDir });

    assert.ok(fs.existsSync(path.join(tmpDir, '.claude', 'collab')));
    assert.ok(fs.existsSync(path.join(tmpDir, '.claude', 'collab', 'context')));
    assert.ok(fs.existsSync(path.join(tmpDir, '.claude', 'collab', 'context-hash')));

    const agents = JSON.parse(fs.readFileSync(path.join(tmpDir, '.claude', 'collab', 'agents.json'), 'utf8'));
    assert.ok(agents['test-sess-1']);
    assert.ok(agents['test-sess-1'].registered_at > 0);
  });

  it('appends .claude/collab/ to an existing .gitignore', () => {
    fs.writeFileSync(path.join(tmpDir, '.gitignore'), 'node_modules\n', 'utf8');
    runHook({ session_id: 'test-sess-1', cwd: tmpDir });
    const gitignore = fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf8');
    assert.match(gitignore, /node_modules/, 'pre-existing entries must survive');
    assert.match(gitignore, /\.claude\/collab\//);
  });

  it('does NOT create .gitignore when one does not exist', () => {
    // Launching `claude` from a non-VCS directory (e.g. ~) must not leave a
    // .gitignore behind. Two sessions in such a directory still get a shared
    // .claude/collab/ for coordination — they just don't pollute the parent.
    runHook({ session_id: 'test-sess-1', cwd: tmpDir });
    assert.ok(fs.existsSync(path.join(tmpDir, '.claude', 'collab')),
      'collab dir must still be created so multi-session coordination works');
    assert.ok(!fs.existsSync(path.join(tmpDir, '.gitignore')),
      'must not create a .gitignore where none existed');
  });

  it('registers multiple agents', () => {
    runHook({ session_id: 'sess-a', cwd: tmpDir });
    runHook({ session_id: 'sess-b', cwd: tmpDir });
    const agents = JSON.parse(fs.readFileSync(path.join(tmpDir, '.claude', 'collab', 'agents.json'), 'utf8'));
    assert.ok(agents['sess-a']);
    assert.ok(agents['sess-b']);
  });

  it('does nothing when ENABLED is false', () => {
    const claudeDir = path.join(tmpDir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(path.join(claudeDir, 'wrightward.json'), JSON.stringify({ ENABLED: false }));
    runHook({ session_id: 'test-sess-1', cwd: tmpDir });
    assert.ok(!fs.existsSync(path.join(tmpDir, '.claude', 'collab')));
  });

  it('sweeps expired file entries on SessionStart (reopened-session cleanup)', () => {
    // Simulate a session reopened after 3 days: an existing agent with old
    // planned files that are long past the 15-minute timeout. Reopening the
    // session must not leave those claims in place to block other sessions.
    const collabDir = ensureCollabDir(tmpDir);
    registerAgent(collabDir, 'stale-sess');
    const ancient = Date.now() - (3 * 24 * 60 * 60 * 1000); // 3 days ago
    writeContext(collabDir, 'stale-sess', {
      task: 'old work from days ago',
      files: [
        { path: 'src/ghost.js', prefix: '~', source: 'planned',
          declaredAt: ancient, lastTouched: ancient, reminded: false }
      ],
      status: 'in-progress'
    });

    runHook({ session_id: 'stale-sess', cwd: tmpDir });

    const ctx = readContext(collabDir, 'stale-sess');
    assert.equal(ctx.files.length, 0, 'expired planned file should have been scavenged on SessionStart');
  });

  it('also sweeps stale entries from OTHER sessions on SessionStart', () => {
    // A fresh session starting up should clean out any other session's stale
    // entries too, so it doesn't immediately hit ghost claims from dead agents.
    const collabDir = ensureCollabDir(tmpDir);
    registerAgent(collabDir, 'other-sess');
    const ancient = Date.now() - (3 * 24 * 60 * 60 * 1000);
    writeContext(collabDir, 'other-sess', {
      task: 'ancient claim',
      files: [
        { path: 'src/ghost.js', prefix: '~', source: 'planned',
          declaredAt: ancient, lastTouched: ancient, reminded: false }
      ],
      status: 'in-progress'
    });

    runHook({ session_id: 'new-sess', cwd: tmpDir });

    const ctx = readContext(collabDir, 'other-sess');
    assert.equal(ctx.files.length, 0, 'other session\'s expired entries should have been scavenged');
  });

  // Bus-specific tests
  it('creates bus subdirectories', () => {
    runHook({ session_id: 'test-sess-1', cwd: tmpDir });
    const collabDir = path.join(tmpDir, '.claude', 'collab');
    assert.ok(fs.existsSync(path.join(collabDir, 'bus-delivered')));
    assert.ok(fs.existsSync(path.join(collabDir, 'bus-index')));
    assert.ok(fs.existsSync(path.join(collabDir, 'mcp-bindings')));
  });

  it('writes MCP binding ticket', () => {
    runHook({ session_id: 'test-sess-1', cwd: tmpDir });
    const bindingsDir = path.join(tmpDir, '.claude', 'collab', 'mcp-bindings');
    const files = fs.readdirSync(bindingsDir);
    assert.ok(files.length >= 1, 'Expected at least one binding ticket');
    const ticket = JSON.parse(fs.readFileSync(path.join(bindingsDir, files[0]), 'utf8'));
    assert.equal(ticket.session_id, 'test-sess-1');
    assert.ok(ticket.created_at > 0);
    assert.ok(ticket.hook_pid > 0);
  });

  it('appends session_started event to bus.jsonl on source=startup', () => {
    runHook({ session_id: 'test-sess-1', cwd: tmpDir, source: 'startup' });
    const busFile = path.join(tmpDir, '.claude', 'collab', 'bus.jsonl');
    assert.ok(fs.existsSync(busFile));
    const content = fs.readFileSync(busFile, 'utf8').trim();
    const event = JSON.parse(content);
    assert.equal(event.type, 'session_started');
    assert.equal(event.from, 'test-sess-1');
    assert.equal(event.to, 'all');
    assert.equal(event.meta.hook_source, 'startup');
  });

  it('appends session_started when source is omitted (back-compat fallback)', () => {
    // Older Claude Code versions may not send `source`. Treat undefined as startup
    // so wrightward keeps announcing sessions on those hosts.
    runHook({ session_id: 'test-sess-1', cwd: tmpDir });
    const busFile = path.join(tmpDir, '.claude', 'collab', 'bus.jsonl');
    assert.ok(fs.existsSync(busFile));
    const event = JSON.parse(fs.readFileSync(busFile, 'utf8').trim());
    assert.equal(event.type, 'session_started');
    assert.equal(event.meta.hook_source, 'startup');
  });

  it('appends session_started when source is resume', () => {
    runHook({ session_id: 'test-sess-1', cwd: tmpDir, source: 'resume' });
    const busFile = path.join(tmpDir, '.claude', 'collab', 'bus.jsonl');
    assert.ok(fs.existsSync(busFile));
    const event = JSON.parse(fs.readFileSync(busFile, 'utf8').trim());
    assert.equal(event.type, 'session_started');
    assert.equal(event.meta.hook_source, 'resume');
  });

  it('does NOT append session_started when source is clear', () => {
    runHook({ session_id: 'test-sess-1', cwd: tmpDir, source: 'clear' });
    const busFile = path.join(tmpDir, '.claude', 'collab', 'bus.jsonl');
    const hasBus = fs.existsSync(busFile);
    if (hasBus) {
      const content = fs.readFileSync(busFile, 'utf8');
      assert.ok(!content.includes('session_started'),
        'clear source must not produce a session_started event');
    }
  });

  it('does NOT append session_started when source is compact', () => {
    // This is the root-cause fix: a long-lived session that auto-compacts must
    // not re-announce itself to the bus (and therefore to Discord).
    runHook({ session_id: 'test-sess-1', cwd: tmpDir, source: 'compact' });
    const busFile = path.join(tmpDir, '.claude', 'collab', 'bus.jsonl');
    const hasBus = fs.existsSync(busFile);
    if (hasBus) {
      const content = fs.readFileSync(busFile, 'utf8');
      assert.ok(!content.includes('session_started'),
        'compact source must not produce a session_started event');
    }
  });

  it('still registers agent and writes ticket on source=clear (heartbeat refresh)', () => {
    runHook({ session_id: 'sess-clear', cwd: tmpDir, source: 'clear' });
    const collabDir = path.join(tmpDir, '.claude', 'collab');
    const agents = JSON.parse(fs.readFileSync(path.join(collabDir, 'agents.json'), 'utf8'));
    assert.ok(agents['sess-clear'], 'agent must be registered even when announce is suppressed');
    const tickets = fs.readdirSync(path.join(collabDir, 'mcp-bindings'));
    assert.ok(tickets.length >= 1, 'binding ticket must be written on clear');
  });

  it('still registers agent and writes ticket on source=compact (heartbeat refresh)', () => {
    runHook({ session_id: 'sess-compact', cwd: tmpDir, source: 'compact' });
    const collabDir = path.join(tmpDir, '.claude', 'collab');
    const agents = JSON.parse(fs.readFileSync(path.join(collabDir, 'agents.json'), 'utf8'));
    assert.ok(agents['sess-compact'], 'agent must be registered even when announce is suppressed');
    const tickets = fs.readdirSync(path.join(collabDir, 'mcp-bindings'));
    assert.ok(tickets.length >= 1, 'binding ticket must be written on compact');
  });

  it('does not write bus files when BUS_ENABLED is false', () => {
    const claudeDir = path.join(tmpDir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(path.join(claudeDir, 'wrightward.json'), JSON.stringify({ BUS_ENABLED: false }));
    runHook({ session_id: 'test-sess-1', cwd: tmpDir });
    const busFile = path.join(tmpDir, '.claude', 'collab', 'bus.jsonl');
    assert.ok(!fs.existsSync(busFile));
  });

  it('snapshot bypass fires before bus emission', () => {
    const snapshotDir = path.join(os.tmpdir(), 'agentwright-snapshots', 'snap-test-' + Date.now());
    fs.mkdirSync(snapshotDir, { recursive: true });
    try {
      runHook({ session_id: 'snap-sess', cwd: snapshotDir });
      const busFile = path.join(snapshotDir, '.claude', 'collab', 'bus.jsonl');
      assert.ok(!fs.existsSync(busFile));
    } finally {
      fs.rmSync(snapshotDir, { recursive: true, force: true });
    }
  });

  it('persists session env vars for later Bash commands when CLAUDE_ENV_FILE is set', () => {
    const envFile = path.join(tmpDir, 'session-env.sh');

    runHook(
      { session_id: 'sess-env', cwd: tmpDir },
      { CLAUDE_ENV_FILE: envFile }
    );

    const envContent = fs.readFileSync(envFile, 'utf8');
    assert.match(envContent, /export COLLAB_SESSION_ID='sess-env'/);
    assert.ok(envContent.includes(`export COLLAB_PROJECT_CWD='${tmpDir}'`),
      `expected COLLAB_PROJECT_CWD='${tmpDir}' in env file, got: ${envContent}`);
  });
});
