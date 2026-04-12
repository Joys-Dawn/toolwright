'use strict';

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { createSnapshot } = require('../lib/snapshot');
const { markStale } = require('../lib/state');
const {
  cleanup,
  initRepoWithCommit,
  writeFile,
  makeTmpDir,
  isGitAvailable,
  binPath
} = require('./helpers');

// Spawns the undo CLI as a child process (same way the slash command does
// via the Bash tool) and returns { status, stdout, stderr, json }.
function runUndo(cwd, args = []) {
  const result = spawnSync(
    process.execPath,
    [binPath('undo.js'), ...args],
    { cwd, encoding: 'utf8' }
  );
  let json = null;
  try { json = JSON.parse(result.stdout); } catch {}
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    json
  };
}

describe('bin/undo.js --diff', () => {
  let cwd;

  afterEach(() => {
    cleanup(cwd);
    cwd = null;
  });

  it('returns ok:true with hasChanges:false when nothing has changed', (t) => {
    if (!isGitAvailable()) { t.skip(); return; }
    ({ cwd } = initRepoWithCommit({ 'a.txt': 'alpha\n' }));
    createSnapshot(cwd);

    const r = runUndo(cwd, ['--diff']);

    assert.equal(r.status, 0);
    assert.ok(r.json);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.hasChanges, false);
    assert.equal(r.json.counts.modified, 0);
    assert.equal(r.json.counts.added, 0);
    assert.equal(r.json.counts.removed, 0);
  });

  it('returns correct counts and file lists when files are mutated', (t) => {
    if (!isGitAvailable()) { t.skip(); return; }
    ({ cwd } = initRepoWithCommit({
      'a.txt': 'alpha\n',
      'b.txt': 'bravo\n'
    }));
    createSnapshot(cwd);

    writeFile(cwd, 'a.txt', 'MUTATED\n');
    writeFile(cwd, 'new.txt', 'added\n');
    fs.unlinkSync(path.join(cwd, 'b.txt'));

    const r = runUndo(cwd, ['--diff']);

    assert.equal(r.status, 0);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.hasChanges, true);
    assert.equal(r.json.counts.modified, 1);
    assert.equal(r.json.counts.added, 1);
    assert.equal(r.json.counts.removed, 1);
    assert.ok(r.json.modified.includes('a.txt'));
    assert.ok(r.json.added.includes('new.txt'));
    assert.ok(r.json.removed.includes('b.txt'));
  });

  it('includes snapshotCreatedAt from metadata', (t) => {
    if (!isGitAvailable()) { t.skip(); return; }
    ({ cwd } = initRepoWithCommit({ 'a.txt': 'a\n' }));
    createSnapshot(cwd);

    const r = runUndo(cwd, ['--diff']);

    assert.equal(r.json.ok, true);
    assert.equal(typeof r.json.snapshotCreatedAt, 'string');
    // Must be a valid ISO date
    assert.ok(!isNaN(Date.parse(r.json.snapshotCreatedAt)));
  });

  it('returns ok:false and exit code 2 when no snapshot exists', (t) => {
    if (!isGitAvailable()) { t.skip(); return; }
    ({ cwd } = initRepoWithCommit({ 'a.txt': 'a\n' }));

    const r = runUndo(cwd, ['--diff']);

    assert.equal(r.status, 2);
    assert.ok(r.json);
    assert.equal(r.json.ok, false);
    assert.equal(typeof r.json.error, 'string');
  });
});

describe('bin/undo.js --apply', () => {
  let cwd;

  afterEach(() => {
    cleanup(cwd);
    cwd = null;
  });

  it('restores files and outputs ok:true, applied:true', (t) => {
    if (!isGitAvailable()) { t.skip(); return; }
    ({ cwd } = initRepoWithCommit({ 'a.txt': 'alpha\n' }));
    createSnapshot(cwd);
    writeFile(cwd, 'a.txt', 'MUTATED\n');

    const r = runUndo(cwd, ['--apply']);

    assert.equal(r.status, 0);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.applied, true);
    assert.equal(r.json.partial, undefined,
      'clean apply should not have partial flag');
    // Verify the file was actually restored
    assert.equal(fs.readFileSync(path.join(cwd, 'a.txt'), 'utf8'), 'alpha\n');
  });

  it('returns ok:false and exit code 2 when no snapshot exists', (t) => {
    if (!isGitAvailable()) { t.skip(); return; }
    ({ cwd } = initRepoWithCommit({ 'a.txt': 'a\n' }));

    const r = runUndo(cwd, ['--apply']);

    assert.equal(r.status, 2);
    assert.equal(r.json.ok, false);
    assert.equal(typeof r.json.error, 'string');
  });

  it('reports partial:true when a file cannot be overwritten', (t) => {
    if (!isGitAvailable()) { t.skip(); return; }
    ({ cwd } = initRepoWithCommit({ 'locked.txt': 'original\n' }));
    createSnapshot(cwd);
    writeFile(cwd, 'locked.txt', 'MUTATED\n');
    fs.chmodSync(path.join(cwd, 'locked.txt'), 0o444);

    let r;
    try {
      r = runUndo(cwd, ['--apply']);
    } finally {
      try { fs.chmodSync(path.join(cwd, 'locked.txt'), 0o644); } catch {}
    }

    assert.equal(r.status, 0, 'partial restore still exits 0');
    assert.equal(r.json.ok, true);
    assert.equal(r.json.applied, true);
    if (r.json.partial) {
      // chmod was honored — verify error details
      assert.ok(Array.isArray(r.json.errors));
      assert.ok(r.json.errors.length > 0);
      assert.equal(r.json.errors[0].file, 'locked.txt');
    } else {
      // Some filesystems ignore chmod 0o444 — skip the partial assertion
      t.diagnostic('filesystem ignored chmod 0o444; skipping partial-failure assertion');
    }
  });
});

describe('bin/undo.js argument handling', () => {
  let cwd;

  afterEach(() => {
    cleanup(cwd);
    cwd = null;
  });

  it('exits with code 1 and usage message when no argument given', (t) => {
    if (!isGitAvailable()) { t.skip(); return; }
    ({ cwd } = initRepoWithCommit({ 'a.txt': 'a\n' }));

    const r = runUndo(cwd, []);

    assert.equal(r.status, 1);
    assert.ok(r.stderr.includes('usage'));
  });

  it('exits with code 1 and usage message for unknown argument', (t) => {
    if (!isGitAvailable()) { t.skip(); return; }
    ({ cwd } = initRepoWithCommit({ 'a.txt': 'a\n' }));

    const r = runUndo(cwd, ['--bogus']);

    assert.equal(r.status, 1);
    assert.ok(r.stderr.includes('usage'));
  });

  it('exits with code 1 for a non-git directory', () => {
    cwd = makeTmpDir('tw-undo-nongit-');
    writeFile(cwd, 'a.txt', 'a');

    const r = runUndo(cwd, ['--diff']);

    assert.equal(r.status, 1);
    assert.ok(r.stderr.includes('not inside a git repository'));
  });
});
