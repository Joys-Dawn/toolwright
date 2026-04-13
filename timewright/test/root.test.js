'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  getGitToplevel,
  getTimewrightDir,
  getRootFilePath,
  writeRootFile,
  readRootFile,
  walkUpForRoot,
  resolveRepoRoot
} = require('../lib/root');
const {
  makeTmpDir,
  cleanup,
  initGitRepo,
  initRepoWithCommit,
  writeFile,
  isGitAvailable
} = require('./helpers');

describe('getGitToplevel', () => {
  let cwd;

  afterEach(() => {
    cleanup(cwd);
    cwd = null;
  });

  it('returns the repo root when called from the root itself', (t) => {
    if (!isGitAvailable()) { t.skip(); return; }
    ({ cwd } = initRepoWithCommit({ 'a.txt': 'a\n' }));

    const top = getGitToplevel(cwd);
    assert.equal(top, fs.realpathSync(cwd));
  });

  it('returns the repo root when called from a subdirectory', (t) => {
    if (!isGitAvailable()) { t.skip(); return; }
    ({ cwd } = initRepoWithCommit({ 'pkg/frontend/a.txt': 'a\n' }));
    const sub = path.join(cwd, 'pkg', 'frontend');

    const top = getGitToplevel(sub);
    // show-toplevel resolves symlinks, so compare against the realpath of
    // the repo root rather than cwd literally.
    assert.equal(top, fs.realpathSync(cwd));
  });

  it('returns null for a non-git directory', (t) => {
    if (!isGitAvailable()) { t.skip(); return; }
    cwd = makeTmpDir('tw-root-nongit-');
    assert.equal(getGitToplevel(cwd), null);
  });
});

describe('writeRootFile / readRootFile', () => {
  let cwd;

  beforeEach(() => {
    cwd = makeTmpDir('tw-root-file-');
  });

  afterEach(() => {
    cleanup(cwd);
  });

  it('round-trips the repo root path', () => {
    writeRootFile(cwd);
    const read = readRootFile(getTimewrightDir(cwd));
    assert.equal(read, cwd);
  });

  it('getRootFilePath points inside the timewright dir', () => {
    assert.equal(
      getRootFilePath(cwd),
      path.join(cwd, '.claude', 'timewright', 'root')
    );
  });

  it('returns null when the root file does not exist', () => {
    const twDir = getTimewrightDir(cwd);
    fs.mkdirSync(twDir, { recursive: true });
    assert.equal(readRootFile(twDir), null);
  });

  it('returns null when the timewright directory itself does not exist', () => {
    const twDir = getTimewrightDir(cwd);
    // Dir was never created — readRootFile should not throw, just return null.
    assert.equal(readRootFile(twDir), null);
  });

  it('returns null when root file is corrupt and points to a nonexistent dir', () => {
    const twDir = getTimewrightDir(cwd);
    fs.mkdirSync(twDir, { recursive: true });
    fs.writeFileSync(
      path.join(twDir, 'root'),
      path.join(cwd, 'nope-does-not-exist'),
      'utf8'
    );

    assert.equal(readRootFile(twDir), null);
  });

  it('does NOT heal arbitrary .claude/timewright dirs (no file creation side effect)', () => {
    // Regression: an earlier version regenerated the root file whenever
    // heal was true and the timewright dir existed — even if that dir
    // happened to exist in an unrelated parent directory (e.g., the user's
    // home dir). That wrote root files in places that weren't project
    // roots. readRootFile is now purely read-only.
    const twDir = getTimewrightDir(cwd);
    fs.mkdirSync(twDir, { recursive: true });
    // Directory exists but has no snapshot, no metadata, no root file —
    // a "hollow" timewright dir. readRootFile must not write anything.

    const result = readRootFile(twDir);

    assert.equal(result, null);
    assert.equal(
      fs.existsSync(getRootFilePath(cwd)), false,
      'readRootFile must never create the root file as a side effect'
    );
  });
});

describe('walkUpForRoot', () => {
  let cwd;

  afterEach(() => {
    cleanup(cwd);
    cwd = null;
  });

  it('finds the anchor when cwd IS the anchored root', () => {
    cwd = makeTmpDir('tw-walk-root-');
    writeRootFile(cwd);
    assert.equal(walkUpForRoot(cwd), cwd);
  });

  it('finds the anchor when cwd is a subdirectory of the anchored root', () => {
    cwd = makeTmpDir('tw-walk-sub-');
    writeRootFile(cwd);
    const sub = path.join(cwd, 'src', 'deep', 'nested');
    fs.mkdirSync(sub, { recursive: true });

    assert.equal(walkUpForRoot(sub), cwd);
  });

  it('returns null when no anchor exists anywhere up the tree', () => {
    cwd = makeTmpDir('tw-walk-nil-');
    const sub = path.join(cwd, 'a', 'b');
    fs.mkdirSync(sub, { recursive: true });

    assert.equal(walkUpForRoot(sub), null);
  });
});

describe('resolveRepoRoot', () => {
  let cwd;

  afterEach(() => {
    cleanup(cwd);
    cwd = null;
  });

  it('returns null for a non-git directory with no anchor', (t) => {
    if (!isGitAvailable()) { t.skip(); return; }
    cwd = makeTmpDir('tw-resolve-nongit-');
    assert.equal(resolveRepoRoot(cwd), null);
  });

  it('returns git toplevel when called from the repo root', (t) => {
    if (!isGitAvailable()) { t.skip(); return; }
    ({ cwd } = initRepoWithCommit({ 'a.txt': 'a\n' }));
    const real = fs.realpathSync(cwd);

    assert.equal(resolveRepoRoot(cwd), real);
  });

  it('returns git toplevel when called from a subdirectory of the repo', (t) => {
    if (!isGitAvailable()) { t.skip(); return; }
    // This is the key correctness test for the "launched from subdir" bug:
    // the subdir must resolve to the git toplevel, NOT to itself, otherwise
    // a full-repo snapshot would land inside the subdir.
    ({ cwd } = initRepoWithCommit({ 'pkg/frontend/a.txt': 'a\n' }));
    const sub = path.join(cwd, 'pkg', 'frontend');
    const real = fs.realpathSync(cwd);

    assert.equal(resolveRepoRoot(sub), real);
  });

  it('establish: true persists the anchor file at the toplevel', (t) => {
    if (!isGitAvailable()) { t.skip(); return; }
    ({ cwd } = initRepoWithCommit({ 'pkg/frontend/a.txt': 'a\n' }));
    const sub = path.join(cwd, 'pkg', 'frontend');
    const real = fs.realpathSync(cwd);

    resolveRepoRoot(sub, { establish: true });

    const rootFile = path.join(real, '.claude', 'timewright', 'root');
    assert.equal(fs.existsSync(rootFile), true,
      'establish: true must persist the anchor at the resolved toplevel');
    assert.equal(fs.readFileSync(rootFile, 'utf8'), real);
  });

  it('prefers an existing anchor over re-resolving via git', (t) => {
    if (!isGitAvailable()) { t.skip(); return; }
    ({ cwd } = initRepoWithCommit({ 'pkg/frontend/a.txt': 'a\n' }));

    // Plant an anchor that points back to cwd (normal case).
    writeRootFile(cwd);

    const sub = path.join(cwd, 'pkg', 'frontend');
    const resolved = resolveRepoRoot(sub);

    // The anchor value wins. Its content (cwd) is returned directly without
    // running git commands — which matters for mid-session cd shifts where
    // re-running show-toplevel could land in a different repo.
    assert.equal(resolved, cwd);
  });

  it('does not create anchor files when establish is false', (t) => {
    if (!isGitAvailable()) { t.skip(); return; }
    ({ cwd } = initRepoWithCommit({ 'a.txt': 'a\n' }));

    resolveRepoRoot(cwd); // default establish: false

    assert.equal(
      fs.existsSync(path.join(cwd, '.claude', 'timewright', 'root')),
      false,
      'without establish, resolveRepoRoot must not create side-effect state'
    );
  });

  it('subsequent calls without establish still resolve the existing anchor', (t) => {
    if (!isGitAvailable()) { t.skip(); return; }
    ({ cwd } = initRepoWithCommit({ 'a.txt': 'a\n' }));
    const real = fs.realpathSync(cwd);

    // First call establishes.
    resolveRepoRoot(cwd, { establish: true });
    // Second call, from a subdir, finds the anchor via walk-up.
    const sub = path.join(cwd, 'sub');
    fs.mkdirSync(sub, { recursive: true });

    assert.equal(resolveRepoRoot(sub), real);
  });

  it('upgrade path: writes anchor on first hook run when pre-anchor install exists', (t) => {
    if (!isGitAvailable()) { t.skip(); return; }
    // Simulate an install from a prior version that never wrote anchors.
    // The .claude/timewright/snapshot/ directory already exists. The first
    // hook to fire under the new version passes establish: true and writes
    // the anchor — so from the second hook onward, walk-up succeeds.
    ({ cwd } = initRepoWithCommit({ 'a.txt': 'a\n' }));
    const real = fs.realpathSync(cwd);
    fs.mkdirSync(path.join(real, '.claude', 'timewright', 'snapshot'), {
      recursive: true
    });

    resolveRepoRoot(cwd, { establish: true });

    const rootFile = path.join(real, '.claude', 'timewright', 'root');
    assert.equal(fs.existsSync(rootFile), true,
      'establish: true on upgrade path must write the anchor');
    assert.equal(fs.readFileSync(rootFile, 'utf8'), real);
  });
});
