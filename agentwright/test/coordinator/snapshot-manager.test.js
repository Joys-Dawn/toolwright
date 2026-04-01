'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const { createGroupSnapshot } = require('../../coordinator/snapshot-manager');
const { groupSnapshotFile, getManagedSnapshotRoot } = require('../../coordinator/paths');
const { writeJson, readJson } = require('../../coordinator/io');

describe('snapshot-manager', () => {
  let tmpDir;
  let isGitAvailable;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snapshot-test-'));
    const gitCheck = spawnSync('git', ['--version'], { encoding: 'utf8' });
    isGitAvailable = gitCheck.status === 0;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    // Clean up any snapshots we created
    const root = getManagedSnapshotRoot();
    if (fs.existsSync(root)) {
      for (const entry of fs.readdirSync(root)) {
        if (entry.startsWith('test-snapshot-')) {
          const entryPath = path.join(root, entry);
          // Try worktree remove first
          spawnSync('git', ['worktree', 'remove', '--force', entryPath], { cwd: tmpDir, encoding: 'utf8' });
          fs.rmSync(entryPath, { recursive: true, force: true });
        }
      }
    }
  });

  describe('temp-copy fallback (no git)', () => {
    it('creates a snapshot directory with file contents', () => {
      // tmpDir is not a git repo, so it should use temp-copy
      fs.writeFileSync(path.join(tmpDir, 'hello.txt'), 'world', 'utf8');
      fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'src', 'app.js'), 'code', 'utf8');

      const snapshot = createGroupSnapshot(tmpDir, 'test-snapshot-copy', 0);
      assert.equal(snapshot.type, 'temp-copy');
      assert.ok(fs.existsSync(snapshot.path));
      assert.equal(fs.readFileSync(path.join(snapshot.path, 'hello.txt'), 'utf8'), 'world');
      assert.equal(fs.readFileSync(path.join(snapshot.path, 'src', 'app.js'), 'utf8'), 'code');

      // Clean up
      fs.rmSync(snapshot.path, { recursive: true, force: true });
    });

    it('writes snapshot metadata to groupSnapshotFile', () => {
      fs.writeFileSync(path.join(tmpDir, 'test.txt'), 'data', 'utf8');
      createGroupSnapshot(tmpDir, 'test-snapshot-meta', 0);
      const meta = readJson(groupSnapshotFile(tmpDir, 'test-snapshot-meta', 0));
      assert.equal(meta.type, 'temp-copy');
      assert.ok(meta.path);
      assert.ok(meta.createdAt);

      // Clean up
      fs.rmSync(meta.path, { recursive: true, force: true });
    });

    it('excludes .claude directory', () => {
      fs.mkdirSync(path.join(tmpDir, '.claude'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, '.claude', 'secret.json'), '{}', 'utf8');
      fs.writeFileSync(path.join(tmpDir, 'keep.txt'), 'yes', 'utf8');

      const snapshot = createGroupSnapshot(tmpDir, 'test-snapshot-excl1', 0);
      assert.ok(!fs.existsSync(path.join(snapshot.path, '.claude')));
      assert.ok(fs.existsSync(path.join(snapshot.path, 'keep.txt')));

      fs.rmSync(snapshot.path, { recursive: true, force: true });
    });

    it('excludes .claude/collab directory', () => {
      fs.mkdirSync(path.join(tmpDir, '.claude', 'collab'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, '.claude', 'collab', 'agents.json'), '{}', 'utf8');
      fs.writeFileSync(path.join(tmpDir, 'keep.txt'), 'yes', 'utf8');

      const snapshot = createGroupSnapshot(tmpDir, 'test-snapshot-excl2', 0);
      assert.ok(!fs.existsSync(path.join(snapshot.path, '.claude')));
      assert.ok(fs.existsSync(path.join(snapshot.path, 'keep.txt')));

      fs.rmSync(snapshot.path, { recursive: true, force: true });
    });

    it('excludes node_modules', () => {
      fs.mkdirSync(path.join(tmpDir, 'node_modules', 'pkg'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'node_modules', 'pkg', 'index.js'), '', 'utf8');
      fs.writeFileSync(path.join(tmpDir, 'keep.txt'), 'yes', 'utf8');

      const snapshot = createGroupSnapshot(tmpDir, 'test-snapshot-excl3', 0);
      assert.ok(!fs.existsSync(path.join(snapshot.path, 'node_modules')));

      fs.rmSync(snapshot.path, { recursive: true, force: true });
    });

    it('excludes .env files', () => {
      fs.writeFileSync(path.join(tmpDir, '.env'), 'SECRET=x', 'utf8');
      fs.writeFileSync(path.join(tmpDir, '.env.local'), 'SECRET=y', 'utf8');
      fs.writeFileSync(path.join(tmpDir, 'keep.txt'), 'yes', 'utf8');

      const snapshot = createGroupSnapshot(tmpDir, 'test-snapshot-excl4', 0);
      assert.ok(!fs.existsSync(path.join(snapshot.path, '.env')));
      assert.ok(!fs.existsSync(path.join(snapshot.path, '.env.local')));
      assert.ok(fs.existsSync(path.join(snapshot.path, 'keep.txt')));

      fs.rmSync(snapshot.path, { recursive: true, force: true });
    });

    it('excludes build/dist/coverage directories', () => {
      for (const dir of ['dist', 'build', 'coverage', '__pycache__']) {
        fs.mkdirSync(path.join(tmpDir, dir), { recursive: true });
        fs.writeFileSync(path.join(tmpDir, dir, 'file.txt'), '', 'utf8');
      }
      fs.writeFileSync(path.join(tmpDir, 'keep.txt'), 'yes', 'utf8');

      const snapshot = createGroupSnapshot(tmpDir, 'test-snapshot-excl5', 0);
      for (const dir of ['dist', 'build', 'coverage', '__pycache__']) {
        assert.ok(!fs.existsSync(path.join(snapshot.path, dir)), `${dir} should be excluded`);
      }

      fs.rmSync(snapshot.path, { recursive: true, force: true });
    });
  });

  describe('git worktree (clean git repo)', () => {
    it('creates a worktree snapshot when git is clean', function() {
      if (!isGitAvailable) {
        this.skip();
        return;
      }
      // Initialize a git repo and commit a file
      spawnSync('git', ['init'], { cwd: tmpDir });
      spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmpDir });
      spawnSync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir });
      fs.writeFileSync(path.join(tmpDir, 'committed.txt'), 'in HEAD', 'utf8');
      spawnSync('git', ['add', '.'], { cwd: tmpDir });
      spawnSync('git', ['commit', '-m', 'initial'], { cwd: tmpDir });

      const snapshot = createGroupSnapshot(tmpDir, 'test-snapshot-wt', 0);
      assert.equal(snapshot.type, 'git-worktree');
      assert.ok(fs.existsSync(snapshot.path));
      assert.equal(fs.readFileSync(path.join(snapshot.path, 'committed.txt'), 'utf8'), 'in HEAD');

      // Clean up worktree
      spawnSync('git', ['worktree', 'remove', '--force', snapshot.path], { cwd: tmpDir });
      fs.rmSync(snapshot.path, { recursive: true, force: true });
    });
  });

  describe('temp-copy (dirty git repo)', () => {
    it('creates a temp-copy snapshot including uncommitted changes when tree is dirty', function() {
      if (!isGitAvailable) {
        this.skip();
        return;
      }
      spawnSync('git', ['init'], { cwd: tmpDir });
      spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmpDir });
      spawnSync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir });
      fs.writeFileSync(path.join(tmpDir, 'committed.txt'), 'in HEAD', 'utf8');
      spawnSync('git', ['add', '.'], { cwd: tmpDir });
      spawnSync('git', ['commit', '-m', 'initial'], { cwd: tmpDir });

      // Make the tree dirty
      fs.writeFileSync(path.join(tmpDir, 'uncommitted.txt'), 'not in HEAD', 'utf8');

      const snapshot = createGroupSnapshot(tmpDir, 'test-snapshot-dirty', 0);
      assert.equal(snapshot.type, 'temp-copy');
      assert.ok(fs.existsSync(snapshot.path));
      // Committed file should be present
      assert.equal(fs.readFileSync(path.join(snapshot.path, 'committed.txt'), 'utf8'), 'in HEAD');
      // Uncommitted file should also be present (temp-copy captures working state)
      assert.ok(fs.existsSync(path.join(snapshot.path, 'uncommitted.txt')));
      assert.equal(fs.readFileSync(path.join(snapshot.path, 'uncommitted.txt'), 'utf8'), 'not in HEAD');

      fs.rmSync(snapshot.path, { recursive: true, force: true });
    });
  });

  describe('symlink removal', () => {
    it('removes external symlinks from snapshot', function() {
      if (process.platform === 'win32') {
        // Symlinks require elevated permissions on Windows
        this.skip();
        return;
      }
      const externalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'external-'));
      fs.writeFileSync(path.join(externalDir, 'secret.txt'), 'secret', 'utf8');
      fs.writeFileSync(path.join(tmpDir, 'keep.txt'), 'yes', 'utf8');
      fs.symlinkSync(externalDir, path.join(tmpDir, 'external-link'));

      const snapshot = createGroupSnapshot(tmpDir, 'test-snapshot-sym', 0);
      assert.ok(!fs.existsSync(path.join(snapshot.path, 'external-link')));
      assert.ok(fs.existsSync(path.join(snapshot.path, 'keep.txt')));

      fs.rmSync(snapshot.path, { recursive: true, force: true });
      fs.rmSync(externalDir, { recursive: true, force: true });
    });
  });
});
