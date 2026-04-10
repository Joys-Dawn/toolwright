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

  it('adds .claude/collab/ to .gitignore', () => {
    runHook({ session_id: 'test-sess-1', cwd: tmpDir });
    const gitignore = fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf8');
    assert.ok(gitignore.includes('.claude/collab/'));
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

  it('persists session env vars for later Bash commands when CLAUDE_ENV_FILE is set', () => {
    const envFile = path.join(tmpDir, 'session-env.sh');

    runHook(
      { session_id: 'sess-env', cwd: tmpDir },
      { CLAUDE_ENV_FILE: envFile }
    );

    const envContent = fs.readFileSync(envFile, 'utf8');
    assert.ok(envContent.includes("export COLLAB_SESSION_ID='sess-env'"));
    assert.ok(envContent.includes(`export COLLAB_PROJECT_CWD='${tmpDir}'`));
  });
});
