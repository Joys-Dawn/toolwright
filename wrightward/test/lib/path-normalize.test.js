'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const pathMod = require('path');
const { normalizeFilePath, projectRelative } = require('../../lib/path-normalize');

describe('normalizeFilePath', () => {
  it('strips leading ./', () => {
    assert.equal(normalizeFilePath('./src/auth.ts'), 'src/auth.ts');
  });

  it('strips repeated leading ./', () => {
    assert.equal(normalizeFilePath('././foo.ts'), 'foo.ts');
  });

  it('converts backslashes to forward slashes', () => {
    assert.equal(normalizeFilePath('src\\auth.ts'), 'src/auth.ts');
  });

  it('handles mixed separators', () => {
    assert.equal(normalizeFilePath('src\\lib/auth.ts'), 'src/lib/auth.ts');
  });

  it('collapses duplicate separators', () => {
    assert.equal(normalizeFilePath('src//lib///auth.ts'), 'src/lib/auth.ts');
  });

  it('strips trailing /', () => {
    assert.equal(normalizeFilePath('src/'), 'src');
  });

  it('preserves already-normalized paths', () => {
    assert.equal(normalizeFilePath('src/auth.ts'), 'src/auth.ts');
  });

  it('handles empty string', () => {
    assert.equal(normalizeFilePath(''), '');
  });

  it('handles non-string gracefully', () => {
    assert.equal(normalizeFilePath(null), null);
    assert.equal(normalizeFilePath(undefined), undefined);
  });

  it('is idempotent', () => {
    const p = './src\\lib//auth.ts';
    assert.equal(normalizeFilePath(normalizeFilePath(p)), normalizeFilePath(p));
  });

  it('does NOT case-normalize', () => {
    assert.equal(normalizeFilePath('Src/Auth.TS'), 'Src/Auth.TS');
  });

  it('does NOT resolve ../ (not its job)', () => {
    assert.equal(normalizeFilePath('../other/file.ts'), '../other/file.ts');
  });
});

describe('projectRelative', () => {
  const root = pathMod.resolve('/some/project');

  it('passes through a simple relative path', () => {
    assert.equal(projectRelative(root, 'src/foo.ts'), 'src/foo.ts');
  });

  it('strips leading ./', () => {
    assert.equal(projectRelative(root, './src/foo.ts'), 'src/foo.ts');
  });

  it('collapses .. segments so src/../foo.ts and foo.ts converge', () => {
    // The whole point: before projectRelative, the interest index would
    // store 'src/../foo.ts' while the guard looked up 'foo.ts' — miss.
    assert.equal(projectRelative(root, 'src/../foo.ts'), 'foo.ts');
    assert.equal(projectRelative(root, 'foo.ts'), 'foo.ts');
  });

  it('resolves an absolute path inside the project to cwd-relative', () => {
    const abs = pathMod.join(root, 'src', 'foo.ts');
    assert.equal(projectRelative(root, abs), 'src/foo.ts');
  });

  it('rejects an absolute path outside the project', () => {
    assert.equal(projectRelative(root, '/elsewhere/foo.ts'), null);
  });

  it('rejects a relative path that escapes via ..', () => {
    assert.equal(projectRelative(root, '../escape.ts'), null);
  });

  it('rejects empty, null, and non-string inputs', () => {
    assert.equal(projectRelative(root, ''), null);
    assert.equal(projectRelative(root, null), null);
    assert.equal(projectRelative(root, undefined), null);
  });

  it('rejects call with no projectRoot', () => {
    assert.equal(projectRelative(null, 'src/foo.ts'), null);
  });

  it('normalizes Windows-style backslashes', () => {
    assert.equal(projectRelative(root, 'src\\lib\\foo.ts'), 'src/lib/foo.ts');
  });
});

describe('normalization integration — coordination round-trip', () => {
  const { ensureCollabDir } = require('../../lib/collab-dir');
  const { registerAgent, withAgentsLock } = require('../../lib/agents');
  const { writeContext, fileEntryForPath } = require('../../lib/context');
  const { findInterested, writeInterest } = require('../../lib/bus-query');
  const { describe: describeBlock, it: itBlock, beforeEach, afterEach } = require('node:test');
  const fs = require('fs');
  const path = require('path');
  const os = require('os');

  let tmpDir;
  let collabDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'path-norm-'));
    collabDir = ensureCollabDir(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('context entry with "./" prefix still matches findInterested called with normalized path', () => {
    registerAgent(collabDir, 'sess-A');
    registerAgent(collabDir, 'sess-B');

    // Session A declares a file with `./` prefix via collab-context
    writeContext(collabDir, 'sess-A', {
      task: 'work',
      files: [fileEntryForPath('./src/auth.ts', '+', 'planned')],
      status: 'in-progress'
    });

    // Session B registers interest in the file using the normalized form (as guard does)
    withAgentsLock(collabDir, (token) => {
      writeInterest(token, collabDir, 'sess-B', 'src/auth.ts', 60000);
    });

    // Now session-state.collectFileFreedEvents would call findInterested with file.path
    // from the context (the `./` form). Thanks to normalization, this should match.
    const ctxA = require('../../lib/context').readContext(collabDir, 'sess-A');
    const pathFromContext = ctxA.files[0].path;
    assert.equal(pathFromContext, 'src/auth.ts', 'context entry must be normalized');

    withAgentsLock(collabDir, (token) => {
      const interested = findInterested(token, collabDir, pathFromContext);
      assert.equal(interested.length, 1);
      assert.equal(interested[0].sessionId, 'sess-B');
    });
  });

  it('Windows-style backslash path in collab-context matches POSIX interest key', () => {
    registerAgent(collabDir, 'sess-A');
    registerAgent(collabDir, 'sess-B');

    writeContext(collabDir, 'sess-A', {
      task: 'work',
      files: [fileEntryForPath('src\\auth.ts', '+', 'planned')],
      status: 'in-progress'
    });

    withAgentsLock(collabDir, (token) => {
      writeInterest(token, collabDir, 'sess-B', 'src/auth.ts', 60000);
    });

    const ctxA = require('../../lib/context').readContext(collabDir, 'sess-A');
    assert.equal(ctxA.files[0].path, 'src/auth.ts');

    withAgentsLock(collabDir, (token) => {
      const interested = findInterested(token, collabDir, ctxA.files[0].path);
      assert.equal(interested.length, 1);
    });
  });

  it('MCP watch_file with raw "./path" normalizes to match context entries', () => {
    registerAgent(collabDir, 'sess-A');
    registerAgent(collabDir, 'sess-B');

    writeContext(collabDir, 'sess-A', {
      task: 'work',
      files: [fileEntryForPath('src/auth.ts', '+', 'planned')],
      status: 'in-progress'
    });

    // Simulate MCP caller passing unnormalized path
    withAgentsLock(collabDir, (token) => {
      writeInterest(token, collabDir, 'sess-B', './src/auth.ts', 60000);
    });

    withAgentsLock(collabDir, (token) => {
      const interested = findInterested(token, collabDir, 'src/auth.ts');
      assert.equal(interested.length, 1, 'normalized interest key must match findInterested lookup');
    });
  });
});
