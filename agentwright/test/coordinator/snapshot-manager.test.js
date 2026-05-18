'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const { createGroupSnapshot, cleanupOrphanedSnapshots } = require('../../coordinator/snapshot-manager');
const {
  groupSnapshotFile,
  getManagedSnapshotRoot,
  getClaudeProjectsDir,
  claudeProjectSlug,
  managedSnapshotProjectSlugPrefix
} = require('../../coordinator/paths');
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
    // Snapshot root is namespaced by cwd — compute it BEFORE removing tmpDir
    // so realpath in projectSnapshotKey still resolves the same key it did
    // when the snapshot was created.
    const root = getManagedSnapshotRoot(tmpDir);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (fs.existsSync(root)) {
      for (const entry of fs.readdirSync(root)) {
        if (entry.startsWith('test-snapshot-')) {
          const entryPath = path.join(root, entry);
          spawnSync('git', ['worktree', 'remove', '--force', entryPath], { cwd: os.tmpdir(), encoding: 'utf8' });
          fs.rmSync(entryPath, { recursive: true, force: true });
        }
      }
      // Remove the per-project root too — it's a fresh tmpdir per test.
      fs.rmSync(root, { recursive: true, force: true });
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

  describe('git worktree with dirty overlay', () => {
    it('creates a worktree snapshot with dirty files overlaid when tree is dirty', function() {
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
      assert.equal(snapshot.type, 'git-worktree');
      assert.equal(snapshot.dirtyOverlay, true);
      assert.ok(Array.isArray(snapshot.dirtyFiles));
      assert.ok(snapshot.dirtyFiles.includes('uncommitted.txt'));
      assert.ok(fs.existsSync(snapshot.path));
      // Committed file should be present (from worktree checkout)
      assert.equal(fs.readFileSync(path.join(snapshot.path, 'committed.txt'), 'utf8'), 'in HEAD');
      // Dirty file should be overlaid on top
      assert.ok(fs.existsSync(path.join(snapshot.path, 'uncommitted.txt')));
      assert.equal(fs.readFileSync(path.join(snapshot.path, 'uncommitted.txt'), 'utf8'), 'not in HEAD');
      // git status should show the overlaid file as a change in the worktree
      const status = spawnSync('git', ['status', '--porcelain'], { cwd: snapshot.path, encoding: 'utf8' });
      assert.ok(status.stdout.includes('uncommitted.txt'), 'git status should show overlaid dirty files');

      spawnSync('git', ['worktree', 'remove', '--force', snapshot.path], { cwd: tmpDir });
      fs.rmSync(snapshot.path, { recursive: true, force: true });
    });

    it('removes deleted files from the snapshot overlay', function() {
      if (!isGitAvailable) {
        this.skip();
        return;
      }
      spawnSync('git', ['init'], { cwd: tmpDir });
      spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmpDir });
      spawnSync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir });
      fs.writeFileSync(path.join(tmpDir, 'keep.txt'), 'stays', 'utf8');
      fs.writeFileSync(path.join(tmpDir, 'delete-me.txt'), 'going away', 'utf8');
      spawnSync('git', ['add', '.'], { cwd: tmpDir });
      spawnSync('git', ['commit', '-m', 'initial'], { cwd: tmpDir });

      // Delete a tracked file in the working tree
      fs.unlinkSync(path.join(tmpDir, 'delete-me.txt'));

      const snapshot = createGroupSnapshot(tmpDir, 'test-snapshot-delete', 0);
      assert.equal(snapshot.type, 'git-worktree');
      assert.equal(snapshot.dirtyOverlay, true);
      // Kept file should still be present
      assert.ok(fs.existsSync(path.join(snapshot.path, 'keep.txt')));
      // Deleted file should be absent from the snapshot
      assert.ok(!fs.existsSync(path.join(snapshot.path, 'delete-me.txt')), 'Deleted file should be removed from snapshot');

      spawnSync('git', ['worktree', 'remove', '--force', snapshot.path], { cwd: tmpDir });
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

  describe('cleanupOrphanedSnapshots — leaked transcript dir sweep', () => {
    const ORIGINAL_CFG = process.env.CLAUDE_CONFIG_DIR;
    let cfgDir;
    let projectsDir;

    beforeEach(() => {
      cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-cfg-'));
      process.env.CLAUDE_CONFIG_DIR = cfgDir;
      projectsDir = path.join(cfgDir, 'projects');
      fs.mkdirSync(projectsDir, { recursive: true });
    });

    afterEach(() => {
      if (ORIGINAL_CFG === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = ORIGINAL_CFG;
      fs.rmSync(cfgDir, { recursive: true, force: true });
    });

    // Mimics a real Claude Code transcript dir: a memory/ subdir + a session
    // .jsonl, so the test exercises a recursive removal, not an empty rmdir.
    function mkProjectDir(name) {
      const d = path.join(projectsDir, name);
      fs.mkdirSync(path.join(d, 'memory'), { recursive: true });
      fs.writeFileSync(path.join(d, 'session.jsonl'), '{}\n', 'utf8');
      return d;
    }

    it('removes leaked auditor transcripts, preserves unrelated + known-run dirs, with the snapshot root absent', () => {
      const prefix = managedSnapshotProjectSlugPrefix(tmpDir);
      const leaked = mkProjectDir(prefix + claudeProjectSlug('2026-01-01T00-00-00-000Z-dead0000-group-0'));
      const knownRunId = '2026-02-02T00-00-00-000Z-live1111';
      const known = mkProjectDir(prefix + claudeProjectSlug(`${knownRunId}-group-0`));
      const unrelated = mkProjectDir('C--Users-someone-my-project');

      // Backlog case: the tmp snapshot root no longer exists, only the
      // leaked transcript dirs remain.
      assert.ok(!fs.existsSync(getManagedSnapshotRoot(tmpDir)));

      const fakeListRuns = () => [{ runId: knownRunId, run: { groups: [{ index: 0 }] } }];
      const removed = cleanupOrphanedSnapshots(tmpDir, fakeListRuns);

      assert.ok(!fs.existsSync(leaked), 'leaked transcript dir should be removed');
      assert.ok(fs.existsSync(known), 'known run transcript dir must be preserved (not raced)');
      assert.ok(fs.existsSync(unrelated), 'unrelated user project dir must never be touched');
      assert.equal(getClaudeProjectsDir(), projectsDir);
      assert.ok(removed.includes(path.basename(leaked)));
      assert.ok(!removed.includes(path.basename(known)));
      assert.ok(!removed.includes(path.basename(unrelated)));
    });

    it('does not throw when the projects dir does not exist', () => {
      fs.rmSync(projectsDir, { recursive: true, force: true });
      assert.deepEqual(cleanupOrphanedSnapshots(tmpDir, () => []), []);
    });
  });
});
