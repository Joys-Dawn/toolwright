'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { createSnapshot } = require('../lib/snapshot');
const { computeDiff, restoreSnapshot } = require('../lib/restore');
const { isStale, getSnapshotDir } = require('../lib/state');
const {
  cleanup,
  git,
  initRepoWithCommit,
  writeFile,
  readFileIfExists,
  isGitAvailable
} = require('./helpers');

describe('computeDiff', () => {
  let cwd;

  afterEach(() => {
    cleanup(cwd);
    cwd = null;
  });

  it('throws when no snapshot exists', (t) => {
    if (!isGitAvailable()) { t.skip(); return; }
    ({ cwd } = initRepoWithCommit({ 'a.txt': 'a\n' }));

    assert.throws(
      () => computeDiff(cwd),
      /No snapshot to undo to/
    );
  });

  it('reports hasChanges=false and empty lists immediately after snapshot', (t) => {
    if (!isGitAvailable()) { t.skip(); return; }
    ({ cwd } = initRepoWithCommit({
      'a.txt': 'alpha\n',
      'b.txt': 'bravo\n'
    }));
    createSnapshot(cwd);

    const diff = computeDiff(cwd);

    assert.deepEqual(diff.modified, []);
    assert.deepEqual(diff.added, []);
    assert.deepEqual(diff.removed, []);
  });

  it('lists a modified tracked file under `modified`', (t) => {
    if (!isGitAvailable()) { t.skip(); return; }
    ({ cwd } = initRepoWithCommit({ 'a.txt': 'alpha\n' }));
    createSnapshot(cwd);

    writeFile(cwd, 'a.txt', 'MUTATED\n');
    const diff = computeDiff(cwd);

    assert.ok(diff.modified.includes('a.txt'));
    assert.deepEqual(diff.added, []);
    assert.deepEqual(diff.removed, []);
  });

  it('lists a newly-created file under `added`', (t) => {
    if (!isGitAvailable()) { t.skip(); return; }
    ({ cwd } = initRepoWithCommit({ 'a.txt': 'alpha\n' }));
    createSnapshot(cwd);

    writeFile(cwd, 'brand-new.txt', 'fresh');
    const diff = computeDiff(cwd);

    assert.ok(diff.added.includes('brand-new.txt'));
    assert.deepEqual(diff.modified, []);
    assert.deepEqual(diff.removed, []);
  });

  it('lists a deleted file under `removed`', (t) => {
    if (!isGitAvailable()) { t.skip(); return; }
    ({ cwd } = initRepoWithCommit({
      'a.txt': 'alpha\n',
      'b.txt': 'bravo\n'
    }));
    createSnapshot(cwd);

    fs.unlinkSync(path.join(cwd, 'b.txt'));
    const diff = computeDiff(cwd);

    assert.ok(diff.removed.includes('b.txt'));
    assert.deepEqual(diff.modified, []);
    assert.deepEqual(diff.added, []);
  });

  it('detects headDrift when git HEAD moves after the snapshot was taken', (t) => {
    if (!isGitAvailable()) { t.skip(); return; }
    ({ cwd } = initRepoWithCommit({ 'a.txt': 'alpha\n' }));
    createSnapshot(cwd);

    // Make another commit — HEAD moves
    writeFile(cwd, 'a.txt', 'updated\n');
    git(cwd, ['add', '.']);
    git(cwd, ['commit', '-q', '-m', 'second']);

    const diff = computeDiff(cwd);

    assert.ok(diff.headDrift, 'headDrift should be populated after external git movement');
    assert.notEqual(diff.headDrift.snapshot, diff.headDrift.current);
    assert.equal(typeof diff.headDrift.snapshot, 'string');
    assert.equal(typeof diff.headDrift.current, 'string');
  });

  it('correctly distinguishes modified from unchanged files via byte compare', (t) => {
    if (!isGitAvailable()) { t.skip(); return; }
    ({ cwd } = initRepoWithCommit({
      'stable.txt': 'never-changes\n',
      'will-change.txt': 'original\n'
    }));
    createSnapshot(cwd);

    writeFile(cwd, 'will-change.txt', 'mutated\n');
    const diff = computeDiff(cwd);

    assert.ok(diff.modified.includes('will-change.txt'));
    assert.ok(!diff.modified.includes('stable.txt'),
      'unchanged file should NOT appear in modified');
  });

  it('handles large files via streaming compare without running out of memory', (t) => {
    if (!isGitAvailable()) { t.skip(); return; }
    // 2 MB of identical content — exceeds the 1 MB inline-compare threshold
    // and must be routed through streamCompare.
    const large = Buffer.alloc(2 * 1024 * 1024, 0x41); // 2 MB of 'A'
    ({ cwd } = initRepoWithCommit({ 'keep.txt': 'anchor' }));
    fs.writeFileSync(path.join(cwd, 'big.bin'), large);
    createSnapshot(cwd);

    // Don't touch the file — streamCompare should report it as unchanged.
    const diff = computeDiff(cwd);
    assert.ok(!diff.modified.includes('big.bin'),
      'unchanged large file should not appear in modified');
    assert.ok(!diff.added.includes('big.bin'),
      'unchanged large file should not appear in added (it was in the snapshot)');

    // Now mutate one byte deep inside the file and verify it's caught.
    const mutated = Buffer.from(large);
    mutated[1024 * 1024 + 500] = 0x42; // flip one byte at ~1 MB offset
    fs.writeFileSync(path.join(cwd, 'big.bin'), mutated);

    const diff2 = computeDiff(cwd);
    assert.ok(diff2.modified.includes('big.bin'),
      'a single mutated byte in a large file must be detected');
  });
});

describe('restoreSnapshot', () => {
  let cwd;

  afterEach(() => {
    cleanup(cwd);
    cwd = null;
  });

  it('throws when no snapshot exists', (t) => {
    if (!isGitAvailable()) { t.skip(); return; }
    ({ cwd } = initRepoWithCommit({ 'a.txt': 'a\n' }));

    assert.throws(
      () => restoreSnapshot(cwd),
      /No snapshot to undo to/
    );
  });

  it('reverts a modified file back to its snapshot content', (t) => {
    if (!isGitAvailable()) { t.skip(); return; }
    ({ cwd } = initRepoWithCommit({ 'a.txt': 'alpha\n' }));
    createSnapshot(cwd);

    writeFile(cwd, 'a.txt', 'MUTATED\n');
    restoreSnapshot(cwd);

    assert.equal(readFileIfExists(cwd, 'a.txt'), 'alpha\n');
  });

  it('deletes files that were added after the snapshot', (t) => {
    if (!isGitAvailable()) { t.skip(); return; }
    ({ cwd } = initRepoWithCommit({ 'a.txt': 'alpha\n' }));
    createSnapshot(cwd);

    writeFile(cwd, 'claude-created.txt', 'evidence');
    restoreSnapshot(cwd);

    assert.equal(readFileIfExists(cwd, 'claude-created.txt'), null,
      'file added after snapshot should be deleted');
  });

  it('restores files that were deleted after the snapshot', (t) => {
    if (!isGitAvailable()) { t.skip(); return; }
    ({ cwd } = initRepoWithCommit({
      'a.txt': 'alpha\n',
      'b.txt': 'bravo\n'
    }));
    createSnapshot(cwd);

    fs.unlinkSync(path.join(cwd, 'b.txt'));
    restoreSnapshot(cwd);

    assert.equal(readFileIfExists(cwd, 'b.txt'), 'bravo\n');
  });

  it('preserves user dirty work that was captured by the dirty overlay', (t) => {
    if (!isGitAvailable()) { t.skip(); return; }
    // Scenario: user had in-progress edits when Claude's turn started.
    // Those edits MUST survive /undo because the snapshot captured them
    // via overlayDirtyFiles.
    ({ cwd } = initRepoWithCommit({ 'auth.ts': 'original auth\n' }));
    writeFile(cwd, 'auth.ts', 'USER-WIP-EDIT\n');
    writeFile(cwd, 'user-notes.md', 'user wrote this before Claude started');

    createSnapshot(cwd);

    // Claude then wrecks everything
    writeFile(cwd, 'auth.ts', 'CLAUDE-BROKE-THIS\n');
    fs.unlinkSync(path.join(cwd, 'user-notes.md'));
    writeFile(cwd, 'claude-garbage.ts', 'unwanted');

    restoreSnapshot(cwd);

    assert.equal(readFileIfExists(cwd, 'auth.ts'), 'USER-WIP-EDIT\n',
      'user WIP edit must be restored, not overwritten with committed blob');
    assert.equal(readFileIfExists(cwd, 'user-notes.md'),
      'user wrote this before Claude started',
      'user untracked file must be restored');
    assert.equal(readFileIfExists(cwd, 'claude-garbage.ts'), null);
  });

  it('returns { errors: [] } when every file restores cleanly', (t) => {
    if (!isGitAvailable()) { t.skip(); return; }
    ({ cwd } = initRepoWithCommit({ 'a.txt': 'alpha\n' }));
    createSnapshot(cwd);
    writeFile(cwd, 'a.txt', 'mutated\n');

    const result = restoreSnapshot(cwd);

    assert.ok(result);
    assert.ok(Array.isArray(result.errors));
    assert.equal(result.errors.length, 0);
  });

  it('returns a populated errors array when a file cannot be overwritten', (t) => {
    if (!isGitAvailable()) { t.skip(); return; }
    // Force a copyfile failure by setting the destination to read-only.
    // On Windows, chmod 0o444 is honored well enough that copyFileSync
    // throws EPERM, which is exactly the partial-failure path we're
    // exercising. Skip only on platforms where this isn't true.
    ({ cwd } = initRepoWithCommit({ 'locked.txt': 'original\n' }));
    createSnapshot(cwd);

    writeFile(cwd, 'locked.txt', 'MUTATED\n');
    fs.chmodSync(path.join(cwd, 'locked.txt'), 0o444);

    let result;
    try {
      result = restoreSnapshot(cwd);
    } finally {
      // Restore write perms so afterEach cleanup can remove the dir.
      try { fs.chmodSync(path.join(cwd, 'locked.txt'), 0o644); } catch {}
    }

    assert.ok(Array.isArray(result.errors));
    if (result.errors.length === 0) {
      // Some filesystems ignore POSIX mode bits (FAT, some Windows configs).
      // Don't fail the whole suite in that case — just skip the assertion.
      t.diagnostic('filesystem ignored chmod 0o444; skipping partial-failure assertion');
      return;
    }
    assert.equal(result.errors[0].file, 'locked.txt');
    assert.equal(result.errors[0].op, 'restore');
    assert.equal(typeof result.errors[0].message, 'string');
  });

  it('clears the stale flag on successful restore', (t) => {
    if (!isGitAvailable()) { t.skip(); return; }
    ({ cwd } = initRepoWithCommit({ 'a.txt': 'a\n' }));
    createSnapshot(cwd);

    // Simulate a mutating tool run — sets stale.
    const { markStale } = require('../lib/state');
    markStale(cwd);
    assert.equal(isStale(cwd), true);

    restoreSnapshot(cwd);

    assert.equal(isStale(cwd), false,
      'stale flag must be cleared after a successful restore');
  });

  it('end-to-end: diff shows changes, apply fixes them, second diff is empty', (t) => {
    if (!isGitAvailable()) { t.skip(); return; }
    ({ cwd } = initRepoWithCommit({
      'a.txt': 'alpha\n',
      'b.txt': 'bravo\n',
      'sub/c.txt': 'charlie\n'
    }));
    createSnapshot(cwd);

    // Mutate all three kinds of change
    writeFile(cwd, 'a.txt', 'MUTATED\n');
    fs.unlinkSync(path.join(cwd, 'b.txt'));
    writeFile(cwd, 'new.txt', 'added\n');

    const diffBefore = computeDiff(cwd);
    assert.equal(diffBefore.modified.length, 1);
    assert.equal(diffBefore.added.length, 1);
    assert.equal(diffBefore.removed.length, 1);

    const result = restoreSnapshot(cwd);
    assert.equal(result.errors.length, 0);

    const diffAfter = computeDiff(cwd);
    assert.equal(diffAfter.modified.length, 0);
    assert.equal(diffAfter.added.length, 0);
    assert.equal(diffAfter.removed.length, 0);

    // Spot-check actual file contents
    assert.equal(readFileIfExists(cwd, 'a.txt'), 'alpha\n');
    assert.equal(readFileIfExists(cwd, 'b.txt'), 'bravo\n');
    assert.equal(readFileIfExists(cwd, 'new.txt'), null);
  });

  it('prunes empty directories left behind after deleting added files', (t) => {
    if (!isGitAvailable()) { t.skip(); return; }
    ({ cwd } = initRepoWithCommit({ 'keep.txt': 'yes\n' }));
    createSnapshot(cwd);

    // Claude creates a deeply nested file that wasn't in the snapshot.
    writeFile(cwd, 'deep/nested/dir/claude-file.txt', 'unwanted');
    assert.ok(fs.existsSync(path.join(cwd, 'deep', 'nested', 'dir')));

    restoreSnapshot(cwd);

    assert.equal(readFileIfExists(cwd, 'deep/nested/dir/claude-file.txt'), null,
      'added file must be deleted');
    assert.equal(fs.existsSync(path.join(cwd, 'deep')), false,
      'empty parent directories must be pruned after file deletion');
  });

  it('does not prune directories that still contain files after restore', (t) => {
    if (!isGitAvailable()) { t.skip(); return; }
    ({ cwd } = initRepoWithCommit({ 'sub/keep.txt': 'kept\n' }));
    createSnapshot(cwd);

    // Add a sibling in the same directory
    writeFile(cwd, 'sub/claude-added.txt', 'unwanted');

    restoreSnapshot(cwd);

    assert.equal(readFileIfExists(cwd, 'sub/claude-added.txt'), null);
    assert.equal(readFileIfExists(cwd, 'sub/keep.txt'), 'kept\n',
      'original file must survive');
    assert.ok(fs.existsSync(path.join(cwd, 'sub')),
      'directory with surviving files must not be pruned');
  });
});
