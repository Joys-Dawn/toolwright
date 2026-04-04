'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

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
