'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { readAgents } = require('../../lib/agents');
const { getLastSeenHash } = require('../../lib/last-seen');

const SCRIPT = path.resolve(__dirname, '../../scripts/context.js');

function runScript(args, options) {
  const result = spawnSync('node', [SCRIPT, ...args], {
    encoding: 'utf8',
    timeout: 5000,
    input: options.input || '',
    env: {
      ...process.env,
      ...options.env
    },
    cwd: options.cwd
  });
  return {
    exitCode: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || ''
  };
}

describe('context script', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collab-script-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes context for the current session from stdin JSON', () => {
    const result = runScript([], {
      cwd: tmpDir,
      env: {
        COLLAB_SESSION_ID: 'sess-1',
        COLLAB_PROJECT_CWD: tmpDir
      },
      input: JSON.stringify({
        task: 'Implement command bridge',
        files: ['~commands/collab-context.md'],
        functions: ['+persistSessionEnv'],
        status: 'in-progress'
      })
    });

    assert.equal(result.exitCode, 0);

    const context = JSON.parse(
      fs.readFileSync(path.join(tmpDir, '.collab', 'context', 'sess-1.json'), 'utf8')
    );
    assert.equal(context.task, 'Implement command bridge');
    assert.deepEqual(context.files, ['~commands/collab-context.md']);
    assert.deepEqual(context.functions, ['+persistSessionEnv']);
    assert.equal(context.status, 'in-progress');
  });

  it('cleans up the current session when --done is used', () => {
    runScript([], {
      cwd: tmpDir,
      env: {
        COLLAB_SESSION_ID: 'sess-1',
        COLLAB_PROJECT_CWD: tmpDir
      },
      input: JSON.stringify({
        task: 'Finish current task',
        files: ['~README.md'],
        functions: [],
        status: 'in-progress'
      })
    });

    const result = runScript(['--done'], {
      cwd: tmpDir,
      env: {
        COLLAB_SESSION_ID: 'sess-1',
        COLLAB_PROJECT_CWD: tmpDir
      }
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout.includes('Cleared collab state'), true);
    assert.equal(fs.existsSync(path.join(tmpDir, '.collab', 'context', 'sess-1.json')), false);
  });

  it('fully cleans up state when marking the current session done', () => {
    runScript([], {
      cwd: tmpDir,
      env: {
        COLLAB_SESSION_ID: 'sess-1',
        COLLAB_PROJECT_CWD: tmpDir
      },
      input: JSON.stringify({
        task: 'Finish current task',
        files: ['~README.md'],
        functions: [],
        status: 'in-progress'
      })
    });

    const lastSeenDir = path.join(tmpDir, '.collab', 'last-seen');
    fs.mkdirSync(lastSeenDir, { recursive: true });
    fs.writeFileSync(path.join(lastSeenDir, 'sess-1.json'), JSON.stringify({ hash: 'abc' }), 'utf8');

    const result = runScript(['--done'], {
      cwd: tmpDir,
      env: {
        COLLAB_SESSION_ID: 'sess-1',
        COLLAB_PROJECT_CWD: tmpDir
      }
    });

    assert.equal(result.exitCode, 0);
    assert.equal(fs.existsSync(path.join(tmpDir, '.collab', 'context', 'sess-1.json')), false);
    assert.equal(readAgents(path.join(tmpDir, '.collab'))['sess-1'], undefined);
    assert.equal(getLastSeenHash(path.join(tmpDir, '.collab'), 'sess-1'), null);
  });

  it('re-registers the session when a new context is declared after done cleanup', () => {
    runScript([], {
      cwd: tmpDir,
      env: {
        COLLAB_SESSION_ID: 'sess-1',
        COLLAB_PROJECT_CWD: tmpDir
      },
      input: JSON.stringify({
        task: 'First task',
        files: ['~README.md'],
        functions: [],
        status: 'in-progress'
      })
    });

    runScript(['--done'], {
      cwd: tmpDir,
      env: {
        COLLAB_SESSION_ID: 'sess-1',
        COLLAB_PROJECT_CWD: tmpDir
      }
    });

    const result = runScript([], {
      cwd: tmpDir,
      env: {
        COLLAB_SESSION_ID: 'sess-1',
        COLLAB_PROJECT_CWD: tmpDir
      },
      input: JSON.stringify({
        task: 'Second task',
        files: ['~src/next.js'],
        functions: [],
        status: 'in-progress'
      })
    });

    assert.equal(result.exitCode, 0);
    assert.ok(readAgents(path.join(tmpDir, '.collab'))['sess-1']);
    const context = JSON.parse(
      fs.readFileSync(path.join(tmpDir, '.collab', 'context', 'sess-1.json'), 'utf8')
    );
    assert.equal(context.task, 'Second task');
  });

  it('fails clearly when session env vars are missing', () => {
    const result = runScript([], {
      cwd: tmpDir,
      env: {
        COLLAB_SESSION_ID: '',
        COLLAB_PROJECT_CWD: ''
      },
      input: JSON.stringify({
        task: 'Missing env case',
        files: [],
        functions: [],
        status: 'in-progress'
      })
    });

    assert.equal(result.exitCode, 1);
    assert.ok(result.stderr.includes('COLLAB_SESSION_ID'));
  });

  it('rejects invalid JSON on stdin', () => {
    const result = runScript([], {
      cwd: tmpDir,
      env: {
        COLLAB_SESSION_ID: 'sess-1',
        COLLAB_PROJECT_CWD: tmpDir
      },
      input: 'not valid json{'
    });

    assert.equal(result.exitCode, 1);
  });

  it('rejects payload with missing task field', () => {
    const result = runScript([], {
      cwd: tmpDir,
      env: {
        COLLAB_SESSION_ID: 'sess-1',
        COLLAB_PROJECT_CWD: tmpDir
      },
      input: JSON.stringify({
        files: ['~foo.js'],
        status: 'in-progress'
      })
    });

    assert.equal(result.exitCode, 1);
    assert.ok(result.stderr.includes('task'));
  });

  it('rejects payload with invalid status value', () => {
    const result = runScript([], {
      cwd: tmpDir,
      env: {
        COLLAB_SESSION_ID: 'sess-1',
        COLLAB_PROJECT_CWD: tmpDir
      },
      input: JSON.stringify({
        task: 'valid task',
        status: 'invalid-status'
      })
    });

    assert.equal(result.exitCode, 1);
    assert.ok(result.stderr.includes('status'));
  });

  it('rejects payload with non-string items in files array', () => {
    const result = runScript([], {
      cwd: tmpDir,
      env: {
        COLLAB_SESSION_ID: 'sess-1',
        COLLAB_PROJECT_CWD: tmpDir
      },
      input: JSON.stringify({
        task: 'valid task',
        files: [123, null],
        status: 'in-progress'
      })
    });

    assert.equal(result.exitCode, 1);
    assert.ok(result.stderr.includes('files'));
  });

  it('strips files already claimed by another agent', () => {
    // Agent A declares context with foo.js
    runScript([], {
      cwd: tmpDir,
      env: { COLLAB_SESSION_ID: 'sess-a', COLLAB_PROJECT_CWD: tmpDir },
      input: JSON.stringify({
        task: 'Working on foo',
        files: ['~foo.js', '+bar.js'],
        status: 'in-progress'
      })
    });

    // Agent B tries to claim foo.js and baz.js
    const result = runScript([], {
      cwd: tmpDir,
      env: { COLLAB_SESSION_ID: 'sess-b', COLLAB_PROJECT_CWD: tmpDir },
      input: JSON.stringify({
        task: 'Working on baz',
        files: ['+foo.js', '~baz.js'],
        status: 'in-progress'
      })
    });

    assert.equal(result.exitCode, 0);
    assert.ok(result.stderr.includes('foo.js'));

    const ctx = JSON.parse(
      fs.readFileSync(path.join(tmpDir, '.collab', 'context', 'sess-b.json'), 'utf8')
    );
    // foo.js stripped, baz.js kept
    assert.deepEqual(ctx.files, ['~baz.js']);
  });

  it('allows same agent to re-declare its own files', () => {
    runScript([], {
      cwd: tmpDir,
      env: { COLLAB_SESSION_ID: 'sess-a', COLLAB_PROJECT_CWD: tmpDir },
      input: JSON.stringify({
        task: 'Working on foo',
        files: ['~foo.js'],
        status: 'in-progress'
      })
    });

    // Same agent updates context with same file
    const result = runScript([], {
      cwd: tmpDir,
      env: { COLLAB_SESSION_ID: 'sess-a', COLLAB_PROJECT_CWD: tmpDir },
      input: JSON.stringify({
        task: 'Still working on foo',
        files: ['~foo.js', '+new.js'],
        status: 'in-progress'
      })
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.stderr, '');

    const ctx = JSON.parse(
      fs.readFileSync(path.join(tmpDir, '.collab', 'context', 'sess-a.json'), 'utf8')
    );
    assert.deepEqual(ctx.files, ['~foo.js', '+new.js']);
  });

  it('strips files regardless of prefix mismatch', () => {
    // Agent A has +foo.js
    runScript([], {
      cwd: tmpDir,
      env: { COLLAB_SESSION_ID: 'sess-a', COLLAB_PROJECT_CWD: tmpDir },
      input: JSON.stringify({
        task: 'Creating foo',
        files: ['+foo.js'],
        status: 'in-progress'
      })
    });

    // Agent B tries to claim ~foo.js (different prefix, same file)
    const result = runScript([], {
      cwd: tmpDir,
      env: { COLLAB_SESSION_ID: 'sess-b', COLLAB_PROJECT_CWD: tmpDir },
      input: JSON.stringify({
        task: 'Editing foo',
        files: ['~foo.js'],
        status: 'in-progress'
      })
    });

    assert.equal(result.exitCode, 0);
    const ctx = JSON.parse(
      fs.readFileSync(path.join(tmpDir, '.collab', 'context', 'sess-b.json'), 'utf8')
    );
    assert.deepEqual(ctx.files, []);
  });

  it('fails when --done is used without existing context', () => {
    const result = runScript(['--done'], {
      cwd: tmpDir,
      env: {
        COLLAB_SESSION_ID: 'sess-never-registered',
        COLLAB_PROJECT_CWD: tmpDir
      }
    });

    assert.equal(result.exitCode, 1);
    assert.ok(result.stderr.includes('No existing collab context'));
  });
});
