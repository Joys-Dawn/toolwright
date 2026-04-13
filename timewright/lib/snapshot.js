'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { shouldExclude } = require('./excludes');
const {
  getSnapshotDir,
  ensureRoot,
  writeMetadata
} = require('./state');

function runGit(cwd, args) {
  return spawnSync('git', args, { cwd, encoding: 'utf8' });
}

function isGitRepo(cwd) {
  const result = runGit(cwd, ['rev-parse', '--is-inside-work-tree']);
  return result.status === 0;
}

// True only if the repo has at least one commit. A freshly-initialized
// repo (`git init` with nothing committed) is a git repo but has no HEAD,
// so `git worktree add HEAD` would fail with "invalid reference: HEAD".
// Callers should fall back to the direct-copy path in that case.
function hasCommit(cwd) {
  const result = runGit(cwd, ['rev-parse', '--verify', 'HEAD']);
  return result.status === 0;
}

function getRealRepoHead(cwd) {
  const result = runGit(cwd, ['rev-parse', 'HEAD']);
  if (result.status !== 0) return null;
  return result.stdout.trim();
}

// Collects every file git considers "dirty" relative to HEAD:
//   - modified tracked files (git diff)
//   - staged changes (git diff --cached)
//   - untracked files NOT ignored by .gitignore
//
// These files will be overlaid byte-exact on top of the worktree snapshot
// so the snapshot captures the user's actual in-progress state, not just
// the committed state.
function getDirtyFiles(cwd) {
  const unstaged = runGit(cwd, ['diff', '--name-only', '-z']);
  const staged = runGit(cwd, ['diff', '--name-only', '--cached', '-z']);
  const untracked = runGit(cwd, [
    'ls-files', '--others', '--exclude-standard', '-z'
  ]);

  if (unstaged.status !== 0 || staged.status !== 0 || untracked.status !== 0) {
    process.stderr.write(
      'timewright: git commands failed while collecting dirty files; ' +
      'snapshot overlay may be incomplete.\n'
    );
  }

  const split = s => (s || '').split('\0').filter(Boolean);
  const files = new Set([
    ...split(unstaged.stdout),
    ...split(staged.stdout),
    ...split(untracked.stdout)
  ]);

  return [...files].filter(f => !shouldExclude(f));
}

// Overlays byte-exact copies of dirty files on top of the git worktree
// snapshot. For files that git lists as dirty but don't exist in the
// working tree (deletions), removes them from the snapshot.
function overlayDirtyFiles(cwd, snapshotDir, dirtyFiles) {
  for (const relFile of dirtyFiles) {
    const srcPath = path.join(cwd, relFile);
    const destPath = path.join(snapshotDir, relFile);
    try {
      if (!fs.existsSync(srcPath)) {
        fs.rmSync(destPath, { force: true });
        continue;
      }
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.copyFileSync(srcPath, destPath);
    } catch (err) {
      process.stderr.write(
        `timewright: failed to overlay ${relFile}: ${err.message}\n`
      );
    }
  }
}

// Direct-copy fallback used when `git worktree add HEAD` isn't viable
// (unborn HEAD — repo initialized but no commits yet). Lists tracked +
// untracked files via `git ls-files -co --exclude-standard` (same set git
// itself considers "the working copy"), then copies each byte-exact into
// the snapshot directory. Gitignored files are skipped automatically.
function createSnapshotDirectCopy(cwd, snapshotDir) {
  const result = runGit(cwd, [
    'ls-files', '-co', '--exclude-standard', '-z'
  ]);
  if (result.status !== 0) {
    throw new Error(
      `git ls-files failed: ${(result.stderr || '').trim() || 'unknown error'}`
    );
  }
  const files = (result.stdout || '')
    .split('\0')
    .filter(f => f.length > 0)
    .filter(f => !shouldExclude(f));

  for (const relFile of files) {
    const srcPath = path.join(cwd, relFile);
    const destPath = path.join(snapshotDir, relFile);
    try {
      // ls-files may list a tracked file that has been deleted in the
      // working tree — skip silently; absence from the snapshot represents
      // the deletion correctly.
      if (!fs.existsSync(srcPath)) continue;
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.copyFileSync(srcPath, destPath);
    } catch (err) {
      process.stderr.write(
        `timewright: failed to copy ${relFile}: ${err.message}\n`
      );
    }
  }
}

// Strips symlinks inside the snapshot whose real target is outside the
// snapshot directory. Defense-in-depth: prevents a rewind from following a
// symlink out of the snapshot and writing to unrelated paths on disk.
function removeExternalSymlinks(snapshotDir) {
  let realSnapshotRoot;
  try {
    realSnapshotRoot = fs.realpathSync(snapshotDir);
  } catch {
    return;
  }
  function walk(currentPath) {
    let entries;
    try {
      entries = fs.readdirSync(currentPath, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const entryPath = path.join(currentPath, entry.name);
      if (entry.isSymbolicLink()) {
        try {
          const realTarget = fs.realpathSync(entryPath);
          const rel = path.relative(realSnapshotRoot, realTarget);
          if (rel.startsWith('..') || path.isAbsolute(rel)) {
            fs.rmSync(entryPath, { force: true });
          }
        } catch {
          fs.rmSync(entryPath, { force: true });
        }
        continue;
      }
      if (entry.isDirectory()) {
        walk(entryPath);
      }
    }
  }
  walk(snapshotDir);
}

// Removes the previous snapshot directory, if any. Always runs `git
// worktree remove` unconditionally (not gated on fs.existsSync) because
// the on-disk directory can be deleted externally while the worktree admin
// entry under `.git/worktrees/snapshot/` survives — gating would skip the
// cleanup and break the next `worktree add` with "already exists". Remove
// is tolerant of a missing directory as long as the admin entry is present.
//
// Always follows with `worktree prune --expire=now` to force immediate
// removal of any stale entries (default `gc.pruneExpire` is 3 months,
// which would leave orphans around long enough to break things).
function removePreviousSnapshot(cwd, snapshotDir) {
  // Best effort: remove may fail if the admin entry is missing and the
  // directory is missing. That's fine — both conditions mean "already gone".
  runGit(cwd, ['worktree', 'remove', '--force', snapshotDir]);
  if (fs.existsSync(snapshotDir)) {
    fs.rmSync(snapshotDir, { recursive: true, force: true });
  }
  runGit(cwd, ['worktree', 'prune', '--expire=now']);
}

/**
 * Creates a fresh snapshot of the project at `cwd`, overwriting any
 * previous snapshot. Requires `cwd` to be inside a git working tree.
 *
 * Uses the same hybrid pattern as agentwright's snapshot-manager:
 *   1. `git worktree add --detach HEAD <snapshotDir>` checks out the
 *      committed state (applying smudge filters consistently, matching
 *      what a normal `git checkout` would produce).
 *   2. Dirty files (modified + staged + untracked) are overlaid byte-exact
 *      from the working tree on top of the worktree, so the snapshot
 *      captures the user's in-progress state.
 *
 * Returns metadata describing the snapshot.
 * Throws if `cwd` is not a git repo or if git worktree add fails.
 */
function ensureGitignored(cwd) {
  // Check if .claude/timewright/ is already ignored by any .gitignore rule.
  const check = runGit(cwd, ['check-ignore', '-q', '.claude/timewright/']);
  if (check.status === 0) return; // already ignored

  // Only append to an existing .gitignore — never manifest one from scratch.
  // Creating a .gitignore in a repo that didn't have one imposes git-tracking
  // conventions on a project that may have deliberately opted out. If the
  // user wants the entry, they can add it manually; in the meantime, the
  // snapshot directory is still safe from recursion because EXCLUDED_ROOTS
  // in lib/excludes.js filters `.claude` from the snapshot itself.
  const gitignorePath = path.join(cwd, '.gitignore');
  let content;
  try {
    content = fs.readFileSync(gitignorePath, 'utf8');
  } catch {
    return;
  }

  const entry = '.claude/timewright/';
  const trailing = content.length > 0 && !content.endsWith('\n') ? '\n' : '';
  fs.writeFileSync(gitignorePath, content + trailing + entry + '\n');
}

function createSnapshot(cwd) {
  if (!isGitRepo(cwd)) {
    throw new Error('timewright requires a git repository.');
  }

  ensureRoot(cwd);
  ensureGitignored(cwd);
  const snapshotDir = getSnapshotDir(cwd);
  removePreviousSnapshot(cwd, snapshotDir);

  let dirtyFileCount = 0;

  if (hasCommit(cwd)) {
    // Normal path: worktree add gives us the HEAD-committed state with all
    // smudge filters applied the same way the working tree has them, then
    // dirty files are overlaid byte-exact on top.
    fs.mkdirSync(path.dirname(snapshotDir), { recursive: true });

    const wtAdd = runGit(cwd, [
      'worktree', 'add', '--detach', snapshotDir, 'HEAD'
    ]);
    if (wtAdd.status !== 0) {
      throw new Error(
        `git worktree add failed: ${(wtAdd.stderr || '').trim() || 'unknown error'}`
      );
    }

    const dirtyFiles = getDirtyFiles(cwd);
    dirtyFileCount = dirtyFiles.length;
    if (dirtyFiles.length > 0) {
      overlayDirtyFiles(cwd, snapshotDir, dirtyFiles);
    }
  } else {
    // Unborn HEAD fallback: no commits yet, so `git worktree add HEAD`
    // would fail. Direct-copy every tracked+untracked file instead.
    fs.mkdirSync(snapshotDir, { recursive: true });
    createSnapshotDirectCopy(cwd, snapshotDir);
  }

  removeExternalSymlinks(snapshotDir);

  const head = getRealRepoHead(cwd);
  const metadata = {
    createdAt: new Date().toISOString(),
    cwd,
    realRepoHead: head,
    unbornHead: !hasCommit(cwd),
    dirtyFileCount
  };
  writeMetadata(cwd, metadata);
  return metadata;
}

module.exports = {
  createSnapshot,
  isGitRepo,
  getRealRepoHead,
  runGit
};
