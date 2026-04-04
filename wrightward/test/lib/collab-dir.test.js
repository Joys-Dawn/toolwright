'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { ensureCollabDir, resolveCollabDir } = require('../../lib/collab-dir');

describe('ensureCollabDir', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collab-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates .claude/collab/ and subdirectories', () => {
    const collabDir = ensureCollabDir(tmpDir);
    assert.equal(collabDir, path.join(tmpDir, '.claude', 'collab'));
    assert.ok(fs.existsSync(path.join(tmpDir, '.claude', 'collab')));
    assert.ok(fs.existsSync(path.join(tmpDir, '.claude', 'collab', 'context')));
    assert.ok(fs.existsSync(path.join(tmpDir, '.claude', 'collab', 'context-hash')));
  });

  it('creates .gitignore with .claude/collab/ entry', () => {
    ensureCollabDir(tmpDir);
    const content = fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf8');
    assert.ok(content.includes('.claude/collab/'));
  });

  it('does not duplicate .gitignore entry', () => {
    ensureCollabDir(tmpDir);
    ensureCollabDir(tmpDir);
    const content = fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf8');
    const matches = content.match(/\.claude\/collab\//g);
    assert.equal(matches.length, 1);
  });

  it('appends to existing .gitignore', () => {
    fs.writeFileSync(path.join(tmpDir, '.gitignore'), 'node_modules/\n', 'utf8');
    ensureCollabDir(tmpDir);
    const content = fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf8');
    assert.ok(content.includes('node_modules/'));
    assert.ok(content.includes('.claude/collab/'));
  });

  it('handles .gitignore without trailing newline', () => {
    fs.writeFileSync(path.join(tmpDir, '.gitignore'), 'node_modules/', 'utf8');
    ensureCollabDir(tmpDir);
    const content = fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf8');
    assert.ok(content.includes('node_modules/'));
    assert.ok(content.includes('.claude/collab/'));
    // Should have a newline between entries
    assert.ok(content.includes('node_modules/\n'));
  });

  it('skips gitignore when .claude/ is already ignored', () => {
    fs.writeFileSync(path.join(tmpDir, '.gitignore'), '.claude/\n', 'utf8');
    ensureCollabDir(tmpDir);
    const content = fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf8');
    assert.ok(!content.includes('.claude/collab/'));
  });

  it('is idempotent', () => {
    ensureCollabDir(tmpDir);
    ensureCollabDir(tmpDir);
    assert.ok(fs.existsSync(path.join(tmpDir, '.claude', 'collab')));
  });

  it('writes a root file recording the project root', () => {
    ensureCollabDir(tmpDir);
    const rootFile = path.join(tmpDir, '.claude', 'collab', 'root');
    assert.ok(fs.existsSync(rootFile));
    assert.equal(fs.readFileSync(rootFile, 'utf8'), path.resolve(tmpDir));
  });
});

describe('resolveCollabDir', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collab-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns null when no .claude/collab exists in the walk-up path', () => {
    // Use the filesystem root — no .claude/collab will exist there
    const { root: fsRoot } = path.parse(tmpDir);
    const isolated = path.join(fsRoot, '__collab_test_isolated_' + process.pid);
    fs.mkdirSync(isolated, { recursive: true });
    try {
      assert.equal(resolveCollabDir(isolated), null);
    } finally {
      fs.rmSync(isolated, { recursive: true, force: true });
    }
  });

  it('resolves from the project root directly', () => {
    ensureCollabDir(tmpDir);
    const result = resolveCollabDir(tmpDir);
    assert.notEqual(result, null);
    assert.equal(result.root, path.resolve(tmpDir));
    assert.equal(result.collabDir, path.join(path.resolve(tmpDir), '.claude', 'collab'));
  });

  it('resolves from a subdirectory by walking up', () => {
    ensureCollabDir(tmpDir);
    const subDir = path.join(tmpDir, 'app', 'src');
    fs.mkdirSync(subDir, { recursive: true });
    const result = resolveCollabDir(subDir);
    assert.notEqual(result, null);
    assert.equal(result.root, path.resolve(tmpDir));
    assert.equal(result.collabDir, path.join(path.resolve(tmpDir), '.claude', 'collab'));
  });

  it('does not create .claude/collab in the subdirectory', () => {
    ensureCollabDir(tmpDir);
    const subDir = path.join(tmpDir, 'app');
    fs.mkdirSync(subDir, { recursive: true });
    resolveCollabDir(subDir);
    assert.ok(!fs.existsSync(path.join(subDir, '.claude')));
  });

  it('heals missing root file by regenerating it', () => {
    const collabDir = path.join(tmpDir, '.claude', 'collab');
    fs.mkdirSync(collabDir, { recursive: true });
    // No root file — resolveCollabDir should heal it
    const result = resolveCollabDir(tmpDir);
    assert.notEqual(result, null);
    assert.equal(result.root, path.resolve(tmpDir));
    // Root file should now exist on disk
    assert.ok(fs.existsSync(path.join(collabDir, 'root')));
    assert.equal(fs.readFileSync(path.join(collabDir, 'root'), 'utf8'), path.resolve(tmpDir));
  });

  it('heals corrupted (empty) root file by regenerating it', () => {
    const collabDir = path.join(tmpDir, '.claude', 'collab');
    fs.mkdirSync(collabDir, { recursive: true });
    fs.writeFileSync(path.join(collabDir, 'root'), '', 'utf8');
    const result = resolveCollabDir(tmpDir);
    assert.notEqual(result, null);
    assert.equal(result.root, path.resolve(tmpDir));
    // Root file should be fixed on disk
    assert.equal(fs.readFileSync(path.join(collabDir, 'root'), 'utf8'), path.resolve(tmpDir));
  });
});
