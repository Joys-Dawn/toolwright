'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { ensureCollabDir } = require('../../lib/collab-dir');
const { registerAgent, readAgents } = require('../../lib/agents');
const { writeContext, readContext } = require('../../lib/context');

const SCRIPT = path.resolve(__dirname, '../../scripts/release-file.js');

function runScript(input, envOrArgs, maybeEnv) {
  // runScript(input, env) — backward compat
  // runScript(input, args, env) — with CLI args
  let args = [];
  let env = envOrArgs;
  if (Array.isArray(envOrArgs)) {
    args = envOrArgs;
    env = maybeEnv || {};
  }
  const result = spawnSync('node', [SCRIPT, ...args], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    timeout: 5000,
    env: { ...process.env, ...env }
  });
  return {
    exitCode: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || ''
  };
}

describe('release-file script', () => {
  let tmpDir;
  let collabDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collab-release-'));
    collabDir = ensureCollabDir(tmpDir);
    registerAgent(collabDir, 'sess-1');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const env = () => ({ COLLAB_SESSION_ID: 'sess-1', COLLAB_PROJECT_CWD: tmpDir });

  it('releases specified files from context', () => {
    writeContext(collabDir, 'sess-1', {
      task: 'my work',
      files: [
        { path: 'a.js', prefix: '~', source: 'planned', declaredAt: 1, lastTouched: 2, reminded: false },
        { path: 'b.js', prefix: '+', source: 'auto', declaredAt: 1, lastTouched: 2, reminded: false }
      ],
      status: 'in-progress'
    });

    const result = runScript({ files: ['a.js'] }, env());
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /Released/);

    const ctx = readContext(collabDir, 'sess-1');
    assert.equal(ctx.files.length, 1);
    assert.equal(ctx.files[0].path, 'b.js');
  });

  it('reports not-found files on stderr', () => {
    writeContext(collabDir, 'sess-1', {
      task: 'my work',
      files: [{ path: 'a.js', prefix: '~', source: 'planned', declaredAt: 1, lastTouched: 2, reminded: false }],
      status: 'in-progress'
    });

    const result = runScript({ files: ['nonexistent.js'] }, env());
    assert.equal(result.exitCode, 0);
    assert.match(result.stderr, /nonexistent\.js/);
  });

  it('keeps context with empty files after releasing all files', () => {
    writeContext(collabDir, 'sess-1', {
      task: 'my work',
      files: [{ path: 'only.js', prefix: '~', source: 'auto', declaredAt: 1, lastTouched: 2, reminded: false }],
      status: 'in-progress'
    });

    const result = runScript({ files: ['only.js'] }, env());
    assert.equal(result.exitCode, 0);

    const ctx = readContext(collabDir, 'sess-1');
    assert.notEqual(ctx, null);
    assert.equal(ctx.files.length, 0);
  });

  it('fails when no context exists', () => {
    const result = runScript({ files: ['foo.js'] }, env());
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /No collab context/);
  });

  it('fails when files array is empty', () => {
    writeContext(collabDir, 'sess-1', {
      task: 'my work',
      files: [],
      status: 'in-progress'
    });

    const result = runScript({ files: [] }, env());
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /non-empty/);
  });

  it('fails when session id is missing from both CLI args and env vars', () => {
    const result = runScript({ files: ['foo.js'] }, { COLLAB_SESSION_ID: '', COLLAB_PROJECT_CWD: '' });
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /session_id/);
  });

  it('accepts session id via --session-id CLI arg (no env vars)', () => {
    writeContext(collabDir, 'cli-sess', {
      task: 'cli test',
      files: [{ path: 'x.js', prefix: '~', source: 'planned', declaredAt: 1, lastTouched: 2, reminded: false }],
      status: 'in-progress'
    });

    const result = runScript(
      { files: ['x.js'] },
      ['--session-id', 'cli-sess', '--cwd', tmpDir],
      { COLLAB_SESSION_ID: '', COLLAB_PROJECT_CWD: '' }
    );
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /Released/);

    const ctx = readContext(collabDir, 'cli-sess');
    assert.equal(ctx.files.length, 0);
  });
});
