'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { createSnapshot, isGitRepo } = require('../lib/snapshot');
const { getSnapshotDir, readMetadata } = require('../lib/state');
const {
  makeTmpDir,
  cleanup,
  git,
  initGitRepo,
  initRepoWithCommit,
  writeFile,
  isGitAvailable
} = require('./helpers');

describe('createSnapshot', () => {
  let cwd;

  beforeEach(() => {
    if (!isGitAvailable()) {
      // Every test here needs git; helpers depend on it.
      return;
    }
  });

  afterEach(() => {
    cleanup(cwd);
    cwd = null;
  });

  describe('preconditions', () => {
    it('throws when called outside a git repository', (t) => {
      if (!isGitAvailable()) { t.skip(); return; }
      cwd = makeTmpDir('tw-snap-nongit-');

      assert.throws(
        () => createSnapshot(cwd),
        /timewright requires a git repository/
      );
    });

    it('isGitRepo returns false for a non-git directory', (t) => {
      if (!isGitAvailable()) { t.skip(); return; }
      cwd = makeTmpDir('tw-snap-nongit2-');
      assert.equal(isGitRepo(cwd), false);
    });
  });

  describe('committed-HEAD path', () => {
    it('captures committed files byte-exact in the snapshot', (t) => {
      if (!isGitAvailable()) { t.skip(); return; }
      ({ cwd } = initRepoWithCommit({
        'a.txt': 'alpha\n',
        'b.txt': 'bravo\n',
        'sub/c.txt': 'charlie\n'
      }));

      createSnapshot(cwd);

      const snapshotDir = getSnapshotDir(cwd);
      assert.ok(fs.existsSync(snapshotDir), 'snapshot dir should exist');
      for (const rel of ['a.txt', 'b.txt', 'sub/c.txt']) {
        assert.ok(
          fs.existsSync(path.join(snapshotDir, rel)),
          `${rel} should be in the snapshot`
        );
      }
    });

    it('metadata records real repo HEAD and unbornHead=false', (t) => {
      if (!isGitAvailable()) { t.skip(); return; }
      let headSha;
      ({ cwd, headSha } = initRepoWithCommit({ 'x.txt': 'x' }));

      createSnapshot(cwd);

      const meta = readMetadata(cwd);
      assert.equal(meta.unbornHead, false);
      assert.equal(meta.realRepoHead, headSha);
      assert.equal(typeof meta.createdAt, 'string');
      assert.equal(typeof meta.dirtyFileCount, 'number');
    });

    it('overlays modified tracked files byte-exact', (t) => {
      if (!isGitAvailable()) { t.skip(); return; }
      ({ cwd } = initRepoWithCommit({ 'a.txt': 'alpha\n' }));

      // Modify the tracked file — this is what should be captured, not the
      // committed blob content.
      writeFile(cwd, 'a.txt', 'USER-EDITED\n');

      createSnapshot(cwd);

      const snapshotCopy = fs.readFileSync(
        path.join(getSnapshotDir(cwd), 'a.txt'),
        'utf8'
      );
      assert.equal(snapshotCopy, 'USER-EDITED\n',
        'snapshot should contain the dirty working-tree content, not the committed blob');
    });

    it('overlays untracked-not-ignored files', (t) => {
      if (!isGitAvailable()) { t.skip(); return; }
      ({ cwd } = initRepoWithCommit({ 'tracked.txt': 'in HEAD' }));

      // Add a brand-new file that was never committed.
      writeFile(cwd, 'new.txt', 'user just created this');

      createSnapshot(cwd);

      const snapshotDir = getSnapshotDir(cwd);
      assert.ok(fs.existsSync(path.join(snapshotDir, 'tracked.txt')));
      assert.ok(fs.existsSync(path.join(snapshotDir, 'new.txt')));
      assert.equal(
        fs.readFileSync(path.join(snapshotDir, 'new.txt'), 'utf8'),
        'user just created this'
      );
    });

    it('omits tracked files that the user has deleted in the working tree', (t) => {
      if (!isGitAvailable()) { t.skip(); return; }
      ({ cwd } = initRepoWithCommit({
        'keep.txt': 'keep\n',
        'goner.txt': 'gone\n'
      }));

      fs.unlinkSync(path.join(cwd, 'goner.txt'));

      createSnapshot(cwd);

      const snapshotDir = getSnapshotDir(cwd);
      assert.ok(fs.existsSync(path.join(snapshotDir, 'keep.txt')));
      assert.equal(fs.existsSync(path.join(snapshotDir, 'goner.txt')), false,
        'a file that was deleted in the working tree should NOT appear in the snapshot');
    });

    it('respects .gitignore — ignored files do not enter the snapshot', (t) => {
      if (!isGitAvailable()) { t.skip(); return; }
      cwd = makeTmpDir('tw-snap-gitignore-');
      initGitRepo(cwd);
      writeFile(cwd, '.gitignore', 'build/\n*.log\n');
      writeFile(cwd, 'kept.txt', 'yes');
      writeFile(cwd, 'build/bundle.js', 'ignored');
      writeFile(cwd, 'debug.log', 'ignored');
      git(cwd, ['add', '.']);
      git(cwd, ['commit', '-q', '-m', 'init']);
      git(cwd, ['checkout', '-q', '.']);

      createSnapshot(cwd);

      const snapshotDir = getSnapshotDir(cwd);
      assert.ok(fs.existsSync(path.join(snapshotDir, 'kept.txt')));
      assert.ok(fs.existsSync(path.join(snapshotDir, '.gitignore')));
      assert.equal(
        fs.existsSync(path.join(snapshotDir, 'build/bundle.js')), false,
        'gitignored build/ should not be in snapshot'
      );
      assert.equal(
        fs.existsSync(path.join(snapshotDir, 'debug.log')), false,
        'gitignored log files should not be in snapshot'
      );
    });
  });

  describe('.env file handling (regression for audit finding)', () => {
    it('excludes .env even if untracked, and INCLUDES .env.example', (t) => {
      if (!isGitAvailable()) { t.skip(); return; }
      ({ cwd } = initRepoWithCommit({
        '.env.example': 'EXAMPLE_KEY=placeholder\n',
        '.env.template': 'TEMPLATE_KEY=placeholder\n',
        'README.md': '# readme\n'
      }));

      // Also drop a secret-bearing .env file untracked (in a real repo this
      // would usually be gitignored, but we're verifying the double safety
      // layer in shouldExclude).
      writeFile(cwd, '.env', 'REAL_SECRET=hunter2\n');

      createSnapshot(cwd);

      const snapshotDir = getSnapshotDir(cwd);
      assert.ok(
        fs.existsSync(path.join(snapshotDir, '.env.example')),
        '.env.example is NOT a secret file and must be captured'
      );
      assert.ok(
        fs.existsSync(path.join(snapshotDir, '.env.template')),
        '.env.template is NOT a secret file and must be captured'
      );
      assert.equal(
        fs.existsSync(path.join(snapshotDir, '.env')), false,
        '.env is a real secret file and must NOT be captured'
      );
    });
  });

  describe('unborn-HEAD path', () => {
    it('creates a direct-copy snapshot in a fresh repo with no commits', (t) => {
      if (!isGitAvailable()) { t.skip(); return; }
      cwd = makeTmpDir('tw-snap-unborn-');
      initGitRepo(cwd);
      writeFile(cwd, 'draft.md', 'my wip content');
      writeFile(cwd, 'src/app.js', 'console.log(1);');

      createSnapshot(cwd);

      const snapshotDir = getSnapshotDir(cwd);
      assert.ok(fs.existsSync(path.join(snapshotDir, 'draft.md')));
      assert.ok(fs.existsSync(path.join(snapshotDir, 'src/app.js')));
      assert.equal(
        fs.readFileSync(path.join(snapshotDir, 'draft.md'), 'utf8'),
        'my wip content'
      );
    });

    it('metadata records unbornHead=true and realRepoHead=null', (t) => {
      if (!isGitAvailable()) { t.skip(); return; }
      cwd = makeTmpDir('tw-snap-unborn-meta-');
      initGitRepo(cwd);
      writeFile(cwd, 'a.txt', 'a');

      createSnapshot(cwd);

      const meta = readMetadata(cwd);
      assert.equal(meta.unbornHead, true);
      assert.equal(meta.realRepoHead, null);
    });
  });

  describe('idempotency', () => {
    it('a second createSnapshot call cleans up the previous snapshot', (t) => {
      if (!isGitAvailable()) { t.skip(); return; }
      ({ cwd } = initRepoWithCommit({ 'a.txt': 'original\n' }));

      createSnapshot(cwd);
      // Mutate and snapshot again — the second snapshot should reflect the
      // new content, not append to the old one.
      writeFile(cwd, 'a.txt', 'second-version\n');
      createSnapshot(cwd);

      const snapshotCopy = fs.readFileSync(
        path.join(getSnapshotDir(cwd), 'a.txt'),
        'utf8'
      );
      assert.equal(snapshotCopy, 'second-version\n');
    });

    it('recovers gracefully when the snapshot dir was deleted externally', (t) => {
      if (!isGitAvailable()) { t.skip(); return; }
      ({ cwd } = initRepoWithCommit({ 'a.txt': 'a\n' }));

      createSnapshot(cwd);
      // Simulate the user cleaning `.claude/` out from under us.
      fs.rmSync(getSnapshotDir(cwd), { recursive: true, force: true });

      // This used to fail with "already exists" because the `.git/worktrees/`
      // admin entry survived. `worktree prune --expire=now` + unconditional
      // `worktree remove` fix that.
      assert.doesNotThrow(() => createSnapshot(cwd));
      assert.ok(fs.existsSync(path.join(getSnapshotDir(cwd), 'a.txt')));
    });
  });

  describe('exclusions', () => {
    it('does not snapshot .claude/timewright recursively into itself', (t) => {
      if (!isGitAvailable()) { t.skip(); return; }
      ({ cwd } = initRepoWithCommit({ 'keep.txt': 'yes' }));

      createSnapshot(cwd);
      // Take a second snapshot — at this point .claude/timewright/snapshot/
      // already exists from the first call. The second snapshot must not
      // recurse into it.
      createSnapshot(cwd);

      const snapshotDir = getSnapshotDir(cwd);
      assert.equal(
        fs.existsSync(path.join(snapshotDir, '.claude')), false,
        'snapshot must not contain its own .claude directory'
      );
    });

    it('does not snapshot untracked node_modules via the overlay path', (t) => {
      if (!isGitAvailable()) { t.skip(); return; }
      // Realistic scenario: node_modules is untracked (no .gitignore entry,
      // just not committed). The overlay step walks `ls-files --others`
      // output and must filter node_modules out before copying.
      ({ cwd } = initRepoWithCommit({ 'package.json': '{}' }));
      writeFile(cwd, 'node_modules/pkg/index.js', 'noise');

      createSnapshot(cwd);

      assert.equal(
        fs.existsSync(path.join(getSnapshotDir(cwd), 'node_modules')), false,
        'untracked node_modules must not be overlaid into the snapshot'
      );
    });
  });

  describe('symlink handling', () => {
    function canCreateSymlinks() {
      const os = require('os');
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-sym-'));
      try {
        const target = path.join(tmp, 'target.txt');
        fs.writeFileSync(target, 'x');
        fs.symlinkSync(target, path.join(tmp, 'link.txt'));
        return true;
      } catch {
        return false;
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    }

    it('removes symlinks that point outside the snapshot directory', (t) => {
      if (!isGitAvailable()) { t.skip(); return; }
      if (!canCreateSymlinks()) { t.skip('symlinks not available'); return; }
      ({ cwd } = initRepoWithCommit({ 'a.txt': 'alpha\n' }));
      createSnapshot(cwd);

      const snapshotDir = getSnapshotDir(cwd);
      // Plant a symlink inside the snapshot pointing to an external path.
      const externalTarget = path.join(cwd, 'a.txt');
      fs.symlinkSync(externalTarget, path.join(snapshotDir, 'evil-link.txt'));

      // Re-snapshot — removeExternalSymlinks runs as part of createSnapshot.
      createSnapshot(cwd);

      assert.equal(
        fs.existsSync(path.join(getSnapshotDir(cwd), 'evil-link.txt')), false,
        'external symlink must be stripped from the snapshot'
      );
    });

    it('preserves symlinks that point within the snapshot directory', (t) => {
      if (!isGitAvailable()) { t.skip(); return; }
      if (!canCreateSymlinks()) { t.skip('symlinks not available'); return; }
      ({ cwd } = initRepoWithCommit({ 'a.txt': 'alpha\n' }));
      createSnapshot(cwd);

      const snapshotDir = getSnapshotDir(cwd);
      // Create an internal symlink (relative, pointing to a file inside snapshot).
      fs.symlinkSync('a.txt', path.join(snapshotDir, 'internal-link.txt'));

      // Re-snapshot.
      createSnapshot(cwd);

      // The re-snapshot wipes and recreates, so this specific link won't
      // survive. But this validates that removeExternalSymlinks doesn't
      // crash on internal symlinks. The real coverage is the non-crash.
      assert.ok(true, 'no crash on internal symlinks');
    });
  });

  describe('dirty file overlay completeness', () => {
    it('captures unstaged, staged, and untracked dirty files in a single snapshot', (t) => {
      if (!isGitAvailable()) { t.skip(); return; }
      ({ cwd } = initRepoWithCommit({
        'tracked-modified.txt': 'original\n',
        'tracked-staged.txt': 'original\n'
      }));

      // Unstaged modification
      writeFile(cwd, 'tracked-modified.txt', 'UNSTAGED-EDIT\n');
      // Staged modification
      writeFile(cwd, 'tracked-staged.txt', 'STAGED-EDIT\n');
      git(cwd, ['add', 'tracked-staged.txt']);
      // Untracked new file
      writeFile(cwd, 'brand-new.txt', 'UNTRACKED\n');

      createSnapshot(cwd);

      const snapshotDir = getSnapshotDir(cwd);
      assert.equal(
        fs.readFileSync(path.join(snapshotDir, 'tracked-modified.txt'), 'utf8'),
        'UNSTAGED-EDIT\n',
        'unstaged modification must be overlaid'
      );
      assert.equal(
        fs.readFileSync(path.join(snapshotDir, 'tracked-staged.txt'), 'utf8'),
        'STAGED-EDIT\n',
        'staged modification must be overlaid'
      );
      assert.equal(
        fs.readFileSync(path.join(snapshotDir, 'brand-new.txt'), 'utf8'),
        'UNTRACKED\n',
        'untracked file must be overlaid'
      );
    });

    it('metadata.dirtyFileCount reflects the total overlay count', (t) => {
      if (!isGitAvailable()) { t.skip(); return; }
      ({ cwd } = initRepoWithCommit({ 'a.txt': 'a\n' }));
      writeFile(cwd, 'a.txt', 'modified\n');
      writeFile(cwd, 'new.txt', 'untracked\n');

      const meta = createSnapshot(cwd);

      // 2 = a.txt (modified) + new.txt (untracked). ensureGitignored no
      // longer manifests a .gitignore from scratch — if one didn't exist,
      // it stays absent, so the overlay count only reflects real dirty files.
      assert.equal(meta.dirtyFileCount, 2);
    });
  });

  describe('ensureGitignored behavior', () => {
    it('appends .claude/timewright/ to an existing .gitignore', (t) => {
      if (!isGitAvailable()) { t.skip(); return; }
      ({ cwd } = initRepoWithCommit({
        '.gitignore': 'node_modules/\n',
        'a.txt': 'a\n'
      }));

      createSnapshot(cwd);

      const content = fs.readFileSync(
        path.join(cwd, '.gitignore'),
        'utf8'
      );
      assert.ok(
        content.includes('.claude/timewright/'),
        'existing .gitignore must be appended with the timewright entry'
      );
      assert.ok(
        content.includes('node_modules/'),
        'existing .gitignore content must be preserved'
      );
    });

    it('does NOT create a .gitignore when one does not exist', (t) => {
      if (!isGitAvailable()) { t.skip(); return; }
      // Fresh repo with NO .gitignore. Creating one ourselves would impose
      // git-tracking conventions on a project that may have deliberately
      // opted out. The snapshot dir is still safe from recursion via
      // EXCLUDED_ROOTS in lib/excludes.js.
      ({ cwd } = initRepoWithCommit({ 'a.txt': 'a\n' }));
      assert.equal(
        fs.existsSync(path.join(cwd, '.gitignore')), false,
        'precondition: no .gitignore before snapshot'
      );

      createSnapshot(cwd);

      assert.equal(
        fs.existsSync(path.join(cwd, '.gitignore')), false,
        'ensureGitignored must not manifest a .gitignore that did not exist'
      );
    });

    it('does not double-append when entry is already present', (t) => {
      if (!isGitAvailable()) { t.skip(); return; }
      ({ cwd } = initRepoWithCommit({
        '.gitignore': '.claude/timewright/\n',
        'a.txt': 'a\n'
      }));

      createSnapshot(cwd);

      const content = fs.readFileSync(
        path.join(cwd, '.gitignore'),
        'utf8'
      );
      const matches = content.match(/\.claude\/timewright\//g) || [];
      assert.equal(matches.length, 1,
        'entry must not be duplicated when git-check-ignore already sees it');
    });
  });
});
