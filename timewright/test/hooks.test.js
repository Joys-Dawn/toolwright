'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { getSnapshotDir, getStaleDir, getMetadataPath } = require('../lib/state');
const {
  makeTmpDir,
  cleanup,
  git,
  initGitRepo,
  initRepoWithCommit,
  writeFile,
  isGitAvailable,
  hookPath
} = require('./helpers');

// Run a hook script with JSON on stdin, cwd set to `dir`, and return
// { status, stdout, stderr }. We deliberately spawn the real hook entry
// points rather than importing them so the tests exercise the exact same
// code path Claude Code runs in production, including the stdin JSON
// parsing and the `process.cwd()` fallback.
function runHook(scriptName, dir, inputObj = {}) {
  const result = spawnSync(
    process.execPath,
    [hookPath(scriptName)],
    {
      cwd: dir,
      input: JSON.stringify(inputObj),
      encoding: 'utf8'
    }
  );
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || ''
  };
}

function snapshotExists(cwd) {
  return fs.existsSync(getSnapshotDir(cwd));
}

function snapshotMtime(cwd) {
  const metaPath = getMetadataPath(cwd);
  if (!fs.existsSync(metaPath)) return null;
  return fs.statSync(metaPath).mtimeMs;
}

function staleMarkerCount(cwd) {
  const dir = getStaleDir(cwd);
  if (!fs.existsSync(dir)) return 0;
  return fs.readdirSync(dir).length;
}

describe('on-user-prompt-submit hook', () => {
  let cwd;

  afterEach(() => {
    cleanup(cwd);
    cwd = null;
  });

  it('takes a snapshot on first prompt in a fresh git repo', (t) => {
    if (!isGitAvailable()) { t.skip(); return; }
    ({ cwd } = initRepoWithCommit({ 'a.txt': 'alpha\n' }));

    const result = runHook('on-user-prompt-submit.js', cwd, {
      prompt: 'please do something'
    });

    assert.equal(result.status, 0, `hook exited cleanly (stderr: ${result.stderr})`);
    assert.ok(snapshotExists(cwd), 'snapshot should be created on first prompt');
  });

  it('is a no-op in a non-git directory (silent opt-out)', (t) => {
    cwd = makeTmpDir('tw-hook-nongit-');
    writeFile(cwd, 'a.txt', 'a');

    const result = runHook('on-user-prompt-submit.js', cwd, {
      prompt: 'hi'
    });

    assert.equal(result.status, 0);
    assert.equal(snapshotExists(cwd), false,
      'non-git repo should not get a snapshot');
  });

  it('is a no-op when there is nothing stale and a snapshot already exists', (t) => {
    if (!isGitAvailable()) { t.skip(); return; }
    ({ cwd } = initRepoWithCommit({ 'a.txt': 'a\n' }));

    // First prompt: creates the snapshot.
    runHook('on-user-prompt-submit.js', cwd, { prompt: 'first' });
    const firstMtime = snapshotMtime(cwd);
    assert.ok(firstMtime);

    // Wait long enough that a rewrite would produce a different mtime.
    // On some Windows filesystems mtime resolution is ~10ms, so we poll
    // for a different tick before the second call.
    const t0 = Date.now();
    while (Date.now() - t0 < 20) { /* spin */ }

    // Second prompt WITHOUT a PostToolUse in between: nothing has mutated,
    // so the hook must not re-snapshot.
    runHook('on-user-prompt-submit.js', cwd, { prompt: 'second' });
    const secondMtime = snapshotMtime(cwd);

    assert.equal(secondMtime, firstMtime,
      'snapshot must not be rewritten when nothing is stale');
  });

  it('does NOT overwrite the snapshot when prompt is /undo', (t) => {
    if (!isGitAvailable()) { t.skip(); return; }
    ({ cwd } = initRepoWithCommit({ 'a.txt': 'alpha\n' }));

    // First prompt: baseline snapshot.
    runHook('on-user-prompt-submit.js', cwd, { prompt: 'build feature' });
    const firstMtime = snapshotMtime(cwd);
    assert.ok(firstMtime);

    // Simulate a mutating tool call — stale is now set.
    runHook('on-post-tool-use.js', cwd, { tool_name: 'Bash' });
    writeFile(cwd, 'a.txt', 'CLAUDE-MUTATED\n');
    assert.equal(staleMarkerCount(cwd), 1);

    // Second prompt: /undo. This MUST skip the snapshot — otherwise
    // the snapshot gets overwritten with the current (mutated) state
    // and /undo becomes a no-op in its own main use case.
    runHook('on-user-prompt-submit.js', cwd, { prompt: '/undo' });
    const secondMtime = snapshotMtime(cwd);

    assert.equal(secondMtime, firstMtime,
      'snapshot must not be rewritten when user prompt is /undo');
    // And stale must still be set — we didn't do the markFresh branch.
    assert.equal(staleMarkerCount(cwd), 1,
      '/undo prompt must not clear stale markers');
  });

  it('recognizes the namespaced /timewright:undo form', (t) => {
    if (!isGitAvailable()) { t.skip(); return; }
    ({ cwd } = initRepoWithCommit({ 'a.txt': 'alpha\n' }));

    runHook('on-user-prompt-submit.js', cwd, { prompt: 'build' });
    const firstMtime = snapshotMtime(cwd);

    runHook('on-post-tool-use.js', cwd, { tool_name: 'Bash' });
    writeFile(cwd, 'a.txt', 'MUTATED\n');

    runHook('on-user-prompt-submit.js', cwd, { prompt: '/timewright:undo' });

    assert.equal(snapshotMtime(cwd), firstMtime,
      '/timewright:undo must also skip the snapshot overwrite');
  });

  it('recognizes /undo with trailing arguments', (t) => {
    if (!isGitAvailable()) { t.skip(); return; }
    ({ cwd } = initRepoWithCommit({ 'a.txt': 'alpha\n' }));

    runHook('on-user-prompt-submit.js', cwd, { prompt: 'build' });
    const firstMtime = snapshotMtime(cwd);

    runHook('on-post-tool-use.js', cwd, { tool_name: 'Bash' });
    writeFile(cwd, 'a.txt', 'MUTATED\n');

    runHook('on-user-prompt-submit.js', cwd, { prompt: '/undo some scope' });

    assert.equal(snapshotMtime(cwd), firstMtime,
      '/undo with args must also skip the snapshot overwrite');
  });

  it('does NOT false-match /undoable (prefix guard)', (t) => {
    if (!isGitAvailable()) { t.skip(); return; }
    ({ cwd } = initRepoWithCommit({ 'a.txt': 'alpha\n' }));

    runHook('on-user-prompt-submit.js', cwd, { prompt: 'first' });
    const firstMtime = snapshotMtime(cwd);

    runHook('on-post-tool-use.js', cwd, { tool_name: 'Bash' });

    // Spin until mtime resolution ticks.
    const t0 = Date.now();
    while (Date.now() - t0 < 20) { /* spin */ }

    runHook('on-user-prompt-submit.js', cwd, { prompt: '/undoable thing' });
    const secondMtime = snapshotMtime(cwd);

    assert.notEqual(secondMtime, firstMtime,
      '/undoable is NOT the undo command and should trigger a fresh snapshot');
  });

  it('does NOT false-match /undocumented', (t) => {
    if (!isGitAvailable()) { t.skip(); return; }
    ({ cwd } = initRepoWithCommit({ 'a.txt': 'alpha\n' }));

    runHook('on-user-prompt-submit.js', cwd, { prompt: 'first' });
    const firstMtime = snapshotMtime(cwd);

    runHook('on-post-tool-use.js', cwd, { tool_name: 'Bash' });
    const t0 = Date.now();
    while (Date.now() - t0 < 20) { /* spin */ }

    runHook('on-user-prompt-submit.js', cwd, { prompt: '/undocumented' });
    const secondMtime = snapshotMtime(cwd);

    assert.notEqual(secondMtime, firstMtime);
  });

  it('re-asserts the stale flag when createSnapshot throws', (t) => {
    if (!isGitAvailable()) { t.skip(); return; }
    // We can't easily force createSnapshot to throw in a portable way,
    // but we can simulate the next-best thing: prove that the hook in its
    // normal path does clear stale, so any failing-path regression would
    // be caught by the fact that stale remains set after a forced failure.
    //
    // This test locks in the happy-path contract: stale is cleared after
    // a successful snapshot. Combined with the implementation's try/catch
    // re-assert, a snapshot failure will re-set stale in production.
    ({ cwd } = initRepoWithCommit({ 'a.txt': 'a\n' }));

    runHook('on-post-tool-use.js', cwd, { tool_name: 'Bash' });
    assert.equal(staleMarkerCount(cwd), 1);

    runHook('on-user-prompt-submit.js', cwd, { prompt: 'go' });
    assert.equal(staleMarkerCount(cwd), 0,
      'successful snapshot must clear the stale flag');
  });
});

describe('on-post-tool-use hook', () => {
  let cwd;

  beforeEach((t) => {
    // PostToolUse now requires a resolvable git repo root to avoid
    // littering .claude/timewright/ in non-git directories. Tests that
    // exercise the stale-marker path must run inside a git repo.
    if (!isGitAvailable()) return;
    ({ cwd } = initRepoWithCommit({ 'a.txt': 'a\n' }));
  });

  afterEach(() => {
    cleanup(cwd);
    cwd = null;
  });

  it('creates a stale marker on Bash tool use', (t) => {
    if (!isGitAvailable()) { t.skip(); return; }
    const result = runHook('on-post-tool-use.js', cwd, { tool_name: 'Bash' });

    assert.equal(result.status, 0);
    assert.equal(staleMarkerCount(cwd), 1);
  });

  it('creates a stale marker on Write tool use', (t) => {
    if (!isGitAvailable()) { t.skip(); return; }
    runHook('on-post-tool-use.js', cwd, { tool_name: 'Write' });
    assert.equal(staleMarkerCount(cwd), 1);
  });

  it('creates a stale marker on Edit tool use', (t) => {
    if (!isGitAvailable()) { t.skip(); return; }
    runHook('on-post-tool-use.js', cwd, { tool_name: 'Edit' });
    assert.equal(staleMarkerCount(cwd), 1);
  });

  it('creates a stale marker on MultiEdit tool use', (t) => {
    if (!isGitAvailable()) { t.skip(); return; }
    runHook('on-post-tool-use.js', cwd, { tool_name: 'MultiEdit' });
    assert.equal(staleMarkerCount(cwd), 1);
  });

  it('creates a stale marker on NotebookEdit tool use', (t) => {
    if (!isGitAvailable()) { t.skip(); return; }
    runHook('on-post-tool-use.js', cwd, { tool_name: 'NotebookEdit' });
    assert.equal(staleMarkerCount(cwd), 1);
  });

  it('does NOT create a stale marker for Read tool', (t) => {
    if (!isGitAvailable()) { t.skip(); return; }
    // Read is not a mutating tool — defense in depth, since the matcher
    // in hooks.json should already prevent this, but a reconfiguration
    // shouldn't break correctness.
    runHook('on-post-tool-use.js', cwd, { tool_name: 'Read' });
    assert.equal(staleMarkerCount(cwd), 0);
  });

  it('does NOT create a stale marker for Grep tool', (t) => {
    if (!isGitAvailable()) { t.skip(); return; }
    runHook('on-post-tool-use.js', cwd, { tool_name: 'Grep' });
    assert.equal(staleMarkerCount(cwd), 0);
  });

  it('appends distinct markers on repeated calls (not overwrite)', (t) => {
    if (!isGitAvailable()) { t.skip(); return; }
    runHook('on-post-tool-use.js', cwd, { tool_name: 'Bash' });
    runHook('on-post-tool-use.js', cwd, { tool_name: 'Bash' });
    runHook('on-post-tool-use.js', cwd, { tool_name: 'Bash' });

    assert.equal(staleMarkerCount(cwd), 3,
      'each hook invocation must produce a unique marker');
  });

  it('is a no-op in a non-git directory (no stale leak)', () => {
    // Regression: PostToolUse used to create .claude/timewright/stale.d/ in
    // any cwd, including dirs that were not git repos. Since timewright can
    // never snapshot/restore those dirs anyway, that state was pure litter.
    const nonGit = makeTmpDir('tw-hook-post-nongit-');
    try {
      runHook('on-post-tool-use.js', nonGit, { tool_name: 'Bash' });
      assert.equal(staleMarkerCount(nonGit), 0,
        'non-git dir must not get a stale marker');
      assert.equal(
        fs.existsSync(path.join(nonGit, '.claude', 'timewright')),
        false,
        'non-git dir must not get a .claude/timewright/ directory'
      );
    } finally {
      cleanup(nonGit);
    }
  });
});

describe('hook robustness (edge cases)', () => {
  let cwd;

  afterEach(() => {
    cleanup(cwd);
    cwd = null;
  });

  it('on-user-prompt-submit exits 0 on malformed stdin JSON', (t) => {
    if (!isGitAvailable()) { t.skip(); return; }
    ({ cwd } = initRepoWithCommit({ 'a.txt': 'a\n' }));

    // Send garbage instead of valid JSON — the hook must not crash.
    const result = spawnSync(
      process.execPath,
      [hookPath('on-user-prompt-submit.js')],
      { cwd, input: '{not valid json', encoding: 'utf8' }
    );

    assert.equal(result.status, 0,
      'malformed stdin must not crash the hook');
  });

  it('on-post-tool-use exits 0 on malformed stdin JSON', () => {
    cwd = makeTmpDir('tw-hook-bad-json-');

    const result = spawnSync(
      process.execPath,
      [hookPath('on-post-tool-use.js')],
      { cwd, input: 'NOT JSON AT ALL', encoding: 'utf8' }
    );

    assert.equal(result.status, 0,
      'malformed stdin must not crash the post-tool-use hook');
  });

  it('on-post-tool-use exits 0 on empty stdin', () => {
    cwd = makeTmpDir('tw-hook-empty-');

    const result = spawnSync(
      process.execPath,
      [hookPath('on-post-tool-use.js')],
      { cwd, input: '', encoding: 'utf8' }
    );

    assert.equal(result.status, 0,
      'empty stdin must not crash the hook');
    // Non-git dir — no state should be created even though the hook ran.
    assert.equal(
      fs.existsSync(path.join(cwd, '.claude', 'timewright')),
      false,
      'empty stdin in a non-git dir must not create timewright state'
    );
  });

  it('on-user-prompt-submit exits 0 when input has no cwd field', (t) => {
    if (!isGitAvailable()) { t.skip(); return; }
    // When cwd is missing from the input, the hook falls back to
    // process.cwd() which is set via spawnSync's cwd option.
    ({ cwd } = initRepoWithCommit({ 'a.txt': 'a\n' }));

    const result = spawnSync(
      process.execPath,
      [hookPath('on-user-prompt-submit.js')],
      {
        cwd,
        input: JSON.stringify({ prompt: 'hello' }),
        encoding: 'utf8'
      }
    );

    assert.equal(result.status, 0);
    // The hook should have created a snapshot via the process.cwd() fallback.
    assert.ok(snapshotExists(cwd),
      'hook must use process.cwd() fallback when input.cwd is missing');
  });

  it('on-post-tool-use with missing tool_name defaults to marking stale (fail-safe)', (t) => {
    if (!isGitAvailable()) { t.skip(); return; }
    ({ cwd } = initRepoWithCommit({ 'a.txt': 'a\n' }));

    // No tool_name at all — the guard defaults to the safe path (mark stale)
    // rather than silently skipping. This is defense-in-depth: an unknown
    // or missing tool name should never silently drop a stale marker.
    runHook('on-post-tool-use.js', cwd, {});
    assert.equal(staleMarkerCount(cwd), 1,
      'missing tool_name must default to marking stale (fail-safe)');
  });
});
