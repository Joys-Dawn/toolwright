'use strict';

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const {
  cleanup,
  initGitRepo,
  initRepoWithCommit,
  writeFile,
  makeTmpDir,
  isGitAvailable,
  binPath
} = require('./helpers');
const { markStale, isStale, readMetadata } = require('../lib/state');

function runSnapshot(cwd) {
  const result = spawnSync(
    process.execPath,
    [binPath('snapshot.js')],
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

describe('bin/snapshot.js', () => {
  let cwd;

  afterEach(() => {
    cleanup(cwd);
    cwd = null;
  });

  it('creates a fresh snapshot and reports the full documented JSON contract', (t) => {
    if (!isGitAvailable()) { t.skip(); return; }
    ({ cwd } = initRepoWithCommit({ 'a.txt': 'alpha\n' }));

    const r = runSnapshot(cwd);

    assert.equal(r.status, 0);
    assert.ok(r.json);
    assert.equal(r.json.ok, true);
    assert.equal(typeof r.json.createdAt, 'string');
    assert.ok(!isNaN(Date.parse(r.json.createdAt)));
    assert.equal(typeof r.json.dirtyFileCount, 'number');
    assert.equal(typeof r.json.realRepoHead, 'string');
    assert.equal(r.json.realRepoHead.length, 40, 'SHA-1 should be 40 hex chars');
    assert.equal(r.json.unbornHead, false);
    // Snapshot directory must exist with the file in it
    assert.ok(fs.existsSync(path.join(cwd, '.claude', 'timewright', 'snapshot', 'a.txt')));
  });

  it('snapshots an unborn-HEAD repo (init with no commits) and reports unbornHead:true', (t) => {
    if (!isGitAvailable()) { t.skip(); return; }
    cwd = makeTmpDir('tw-snapshot-unborn-');
    initGitRepo(cwd);
    writeFile(cwd, 'a.txt', 'alpha\n');

    const r = runSnapshot(cwd);

    assert.equal(r.status, 0);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.unbornHead, true);
    assert.equal(r.json.realRepoHead, null);
    // File still lands in the snapshot via the direct-copy fallback path
    assert.ok(fs.existsSync(path.join(cwd, '.claude', 'timewright', 'snapshot', 'a.txt')));
  });

  it('overwrites the existing snapshot rather than stacking', (t) => {
    if (!isGitAvailable()) { t.skip(); return; }
    ({ cwd } = initRepoWithCommit({ 'a.txt': 'v1\n' }));

    const first = runSnapshot(cwd);
    assert.equal(first.json.ok, true);

    // Mutate, then re-snapshot
    writeFile(cwd, 'a.txt', 'v2\n');
    const second = runSnapshot(cwd);

    assert.equal(second.json.ok, true);
    // The snapshot now reflects v2 — proves the slot was overwritten
    const snapshotted = fs.readFileSync(
      path.join(cwd, '.claude', 'timewright', 'snapshot', 'a.txt'),
      'utf8'
    );
    assert.equal(snapshotted, 'v2\n');
    // Metadata reflects the second run
    const meta = readMetadata(cwd);
    assert.equal(meta.createdAt, second.json.createdAt);
  });

  it('clears stale markers so the next prompt does not immediately re-snapshot', (t) => {
    if (!isGitAvailable()) { t.skip(); return; }
    ({ cwd } = initRepoWithCommit({ 'a.txt': 'alpha\n' }));
    markStale(cwd);
    assert.equal(isStale(cwd), true);

    const r = runSnapshot(cwd);

    assert.equal(r.json.ok, true);
    assert.equal(isStale(cwd), false);
  });

  it('exits with code 1 and ok:false outside a git repo', () => {
    cwd = makeTmpDir('tw-snapshot-nongit-');
    writeFile(cwd, 'a.txt', 'a');

    const r = runSnapshot(cwd);

    assert.equal(r.status, 1);
    assert.ok(r.json);
    assert.equal(r.json.ok, false);
    assert.equal(r.json.error, 'not inside a git repository');
  });
});
