'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { readAgents } = require('../../lib/agents');
const { readContext } = require('../../lib/context');
const { getContextHash } = require('../../lib/context-hash');

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
      fs.readFileSync(path.join(tmpDir, '.claude', 'collab', 'context', 'sess-1.json'), 'utf8')
    );
    assert.equal(context.task, 'Implement command bridge');
    assert.equal(context.files.length, 1);
    assert.equal(context.files[0].path, 'commands/collab-context.md');
    assert.equal(context.files[0].prefix, '~');
    assert.equal(context.files[0].source, 'planned');
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
    assert.equal(fs.existsSync(path.join(tmpDir, '.claude', 'collab', 'context', 'sess-1.json')), false);
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

    const contextHashDir = path.join(tmpDir, '.claude', 'collab', 'context-hash');
    fs.mkdirSync(contextHashDir, { recursive: true });
    fs.writeFileSync(path.join(contextHashDir, 'sess-1.json'), JSON.stringify({ hash: 'abc' }), 'utf8');

    const result = runScript(['--done'], {
      cwd: tmpDir,
      env: {
        COLLAB_SESSION_ID: 'sess-1',
        COLLAB_PROJECT_CWD: tmpDir
      }
    });

    assert.equal(result.exitCode, 0);
    assert.equal(fs.existsSync(path.join(tmpDir, '.claude', 'collab', 'context', 'sess-1.json')), false);
    assert.equal(readAgents(path.join(tmpDir, '.claude', 'collab'))['sess-1'], undefined);
    assert.equal(getContextHash(path.join(tmpDir, '.claude', 'collab'), 'sess-1'), null);
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
    assert.ok(readAgents(path.join(tmpDir, '.claude', 'collab'))['sess-1']);
    const context = JSON.parse(
      fs.readFileSync(path.join(tmpDir, '.claude', 'collab', 'context', 'sess-1.json'), 'utf8')
    );
    assert.equal(context.task, 'Second task');
  });

  it('fails clearly when session id is missing from both CLI args and env vars', () => {
    const result = runScript([], {
      cwd: tmpDir,
      env: {
        COLLAB_SESSION_ID: '',
        COLLAB_PROJECT_CWD: ''
      },
      input: JSON.stringify({
        task: 'Missing session case',
        files: [],
        functions: [],
        status: 'in-progress'
      })
    });

    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /session_id/);
  });

  it('accepts session id via --session-id CLI arg (no env vars)', () => {
    const result = runScript(['--session-id', 'cli-session-id'], {
      cwd: tmpDir,
      env: {
        COLLAB_SESSION_ID: '',
        COLLAB_PROJECT_CWD: tmpDir
      },
      input: JSON.stringify({
        task: 'CLI arg case',
        files: [],
        functions: [],
        status: 'in-progress'
      })
    });

    assert.equal(result.exitCode, 0);
    const collabDir = path.join(tmpDir, '.claude', 'collab');
    const context = readContext(collabDir, 'cli-session-id');
    assert.ok(context);
    assert.equal(context.task, 'CLI arg case');
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
    assert.match(result.stderr, /task/);
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
    assert.match(result.stderr, /status/);
  });

  it('rejects payload with invalid items in files array', () => {
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
    assert.match(result.stderr, /prefixed string/);
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
    assert.match(result.stderr, /foo\.js/);

    const ctx = JSON.parse(
      fs.readFileSync(path.join(tmpDir, '.claude', 'collab', 'context', 'sess-b.json'), 'utf8')
    );
    // foo.js stripped, baz.js kept
    assert.equal(ctx.files.length, 1);
    assert.equal(ctx.files[0].path, 'baz.js');
    assert.equal(ctx.files[0].prefix, '~');
  });

  it('records interest for stripped files so the agent wakes when they free up', () => {
    // Mirrors the behavior of the guard hook's blocked-write path — a
    // well-behaved agent that declares up front should not have to attempt
    // a blocked Write just to register interest.
    runScript([], {
      cwd: tmpDir,
      env: { COLLAB_SESSION_ID: 'sess-a', COLLAB_PROJECT_CWD: tmpDir },
      input: JSON.stringify({
        task: 'Claiming foo.js',
        files: ['~foo.js'],
        status: 'in-progress'
      })
    });

    const result = runScript([], {
      cwd: tmpDir,
      env: { COLLAB_SESSION_ID: 'sess-b', COLLAB_PROJECT_CWD: tmpDir },
      input: JSON.stringify({
        task: 'Also wants foo.js',
        files: ['+foo.js'],
        status: 'in-progress'
      })
    });

    assert.equal(result.exitCode, 0);
    assert.match(result.stderr, /Interest recorded/,
      'stderr must tell the agent interest was recorded so it knows a wake-up is coming, got: ' + result.stderr);

    const busPath = path.join(tmpDir, '.claude', 'collab', 'bus.jsonl');
    const events = fs.readFileSync(busPath, 'utf8').trim().split('\n').map(JSON.parse);
    const interest = events.find(e => e.type === 'interest' && e.from === 'sess-b' && e.meta && e.meta.file === 'foo.js');
    assert.ok(interest, 'expected an interest event from sess-b for foo.js in bus.jsonl, got: ' + JSON.stringify(events.map(e => ({ type: e.type, from: e.from, file: e.meta && e.meta.file }))));
  });

  it('omits the interest-recorded line when BUS_ENABLED is false', () => {
    fs.mkdirSync(path.join(tmpDir, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.claude', 'wrightward.json'), JSON.stringify({ BUS_ENABLED: false }));

    runScript([], {
      cwd: tmpDir,
      env: { COLLAB_SESSION_ID: 'sess-a', COLLAB_PROJECT_CWD: tmpDir },
      input: JSON.stringify({
        task: 'Claiming foo.js',
        files: ['~foo.js'],
        status: 'in-progress'
      })
    });

    const result = runScript([], {
      cwd: tmpDir,
      env: { COLLAB_SESSION_ID: 'sess-b', COLLAB_PROJECT_CWD: tmpDir },
      input: JSON.stringify({
        task: 'Also wants foo.js',
        files: ['+foo.js'],
        status: 'in-progress'
      })
    });

    assert.equal(result.exitCode, 0);
    assert.match(result.stderr, /Removed files already claimed/);
    assert.doesNotMatch(result.stderr, /Interest recorded/,
      'must not claim interest was recorded when BUS_ENABLED is false');
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
      fs.readFileSync(path.join(tmpDir, '.claude', 'collab', 'context', 'sess-a.json'), 'utf8')
    );
    assert.equal(ctx.files.length, 2);
    assert.equal(ctx.files[0].path, 'foo.js');
    assert.equal(ctx.files[0].prefix, '~');
    assert.equal(ctx.files[1].path, 'new.js');
    assert.equal(ctx.files[1].prefix, '+');
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
      fs.readFileSync(path.join(tmpDir, '.claude', 'collab', 'context', 'sess-b.json'), 'utf8')
    );
    assert.equal(ctx.files.length, 0);
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
    assert.match(result.stderr, /No existing collab context/);
  });

  describe('context_updated bus emission', () => {
    function readBusEvents(tmpDir) {
      const busPath = path.join(tmpDir, '.claude', 'collab', 'bus.jsonl');
      if (!fs.existsSync(busPath)) return [];
      return fs.readFileSync(busPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
    }

    it('emits context_updated on first context set (prev_task=null)', () => {
      runScript([], {
        cwd: tmpDir,
        env: { COLLAB_SESSION_ID: 'sess-1', COLLAB_PROJECT_CWD: tmpDir },
        input: JSON.stringify({ task: 'Initial task', files: [], status: 'in-progress' })
      });

      const events = readBusEvents(tmpDir);
      const updated = events.find(e => e.type === 'context_updated' && e.from === 'sess-1');
      assert.ok(updated, 'expected a context_updated event on first context set');
      assert.equal(updated.meta.prev_task, null);
      assert.equal(updated.meta.new_task, 'Initial task');
      assert.equal(updated.to, 'all');
    });

    it('emits context_updated when task string changes between writes', () => {
      runScript([], {
        cwd: tmpDir,
        env: { COLLAB_SESSION_ID: 'sess-1', COLLAB_PROJECT_CWD: tmpDir },
        input: JSON.stringify({ task: 'First task', files: [], status: 'in-progress' })
      });
      runScript([], {
        cwd: tmpDir,
        env: { COLLAB_SESSION_ID: 'sess-1', COLLAB_PROJECT_CWD: tmpDir },
        input: JSON.stringify({ task: 'Second task', files: [], status: 'in-progress' })
      });

      const events = readBusEvents(tmpDir).filter(e => e.type === 'context_updated');
      assert.equal(events.length, 2, 'expected exactly two context_updated events, got ' + events.length);
      assert.equal(events[0].meta.prev_task, null);
      assert.equal(events[0].meta.new_task, 'First task');
      assert.equal(events[1].meta.prev_task, 'First task');
      assert.equal(events[1].meta.new_task, 'Second task');
    });

    it('does NOT emit context_updated when task is unchanged', () => {
      runScript([], {
        cwd: tmpDir,
        env: { COLLAB_SESSION_ID: 'sess-1', COLLAB_PROJECT_CWD: tmpDir },
        input: JSON.stringify({ task: 'Same task', files: [], status: 'in-progress' })
      });
      runScript([], {
        cwd: tmpDir,
        env: { COLLAB_SESSION_ID: 'sess-1', COLLAB_PROJECT_CWD: tmpDir },
        input: JSON.stringify({ task: 'Same task', files: ['~new-file.js'], status: 'in-progress' })
      });

      const events = readBusEvents(tmpDir).filter(e => e.type === 'context_updated');
      assert.equal(events.length, 1, 'expected exactly one context_updated event (the first one only), got ' + events.length);
    });

    it('does NOT emit context_updated when BUS_ENABLED is false', () => {
      fs.mkdirSync(path.join(tmpDir, '.claude'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, '.claude', 'wrightward.json'), JSON.stringify({ BUS_ENABLED: false }));

      runScript([], {
        cwd: tmpDir,
        env: { COLLAB_SESSION_ID: 'sess-1', COLLAB_PROJECT_CWD: tmpDir },
        input: JSON.stringify({ task: 'task', files: [], status: 'in-progress' })
      });

      const events = readBusEvents(tmpDir);
      assert.equal(events.length, 0, 'no bus events expected when BUS_ENABLED=false, got ' + events.length);
    });

    it('exits 0 and writes context when context_updated append throws (bus write failure)', () => {
      // Simulate a bus append failure by creating bus.jsonl as a DIRECTORY
      // before the script runs — any subsequent fs.appendFileSync hits EISDIR.
      // The script's try/catch at scripts/context.js:167-175 must swallow
      // the error and continue: context write is load-bearing, bus emission
      // is advisory.
      const collabDir = path.join(tmpDir, '.claude', 'collab');
      fs.mkdirSync(collabDir, { recursive: true });
      fs.mkdirSync(path.join(collabDir, 'bus.jsonl'));

      const result = runScript([], {
        cwd: tmpDir,
        env: { COLLAB_SESSION_ID: 'sess-1', COLLAB_PROJECT_CWD: tmpDir },
        input: JSON.stringify({ task: 'Probe task', files: [], status: 'in-progress' })
      });

      assert.equal(result.exitCode, 0,
        'script must exit 0 despite bus write failure; stderr=' + result.stderr);
      assert.match(result.stderr, /\[collab\/context\] context_updated append failed:/,
        'stderr must carry the advisory warning');
      const ctx = readContext(collabDir, 'sess-1');
      assert.ok(ctx, 'context file must be written even when bus emission fails');
      assert.equal(ctx.task, 'Probe task');
    });
  });
});
