'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  assertPathWithin,
  getManagedSnapshotRoot,
  groupSnapshotFile
} = require('./paths');
const { writeJson } = require('./io');

const EXCLUDED_ROOTS = new Set([
  '.claude', '.collab', 'node_modules', '.git',
  'dist', 'build', '.next', '.nuxt', '.output',
  '.turbo', '.vercel', '.svelte-kit',
  'coverage', '__pycache__', '.pytest_cache',
  '.mypy_cache', '.ruff_cache'
]);

function shouldExclude(relativePath) {
  if (!relativePath) {
    return false;
  }
  const parts = relativePath.split(path.sep);
  const basename = path.basename(relativePath);
  return parts.some(p => EXCLUDED_ROOTS.has(p))
    || basename === '.env'
    || basename.startsWith('.env.');
}

function copyWorkspaceToSnapshot(cwd, snapshotDir) {
  fs.cpSync(cwd, snapshotDir, {
    recursive: true,
    filter(sourcePath) {
      const relativePath = path.relative(cwd, sourcePath);
      return !shouldExclude(relativePath);
    }
  });
}

function removeExternalSymlinks(snapshotDir) {
  const realSnapshotRoot = fs.realpathSync(snapshotDir);
  function walk(currentPath) {
    for (const entry of fs.readdirSync(currentPath, { withFileTypes: true })) {
      const entryPath = path.join(currentPath, entry.name);
      if (entry.isSymbolicLink()) {
        try {
          const realTarget = fs.realpathSync(entryPath);
          const relative = path.relative(realSnapshotRoot, realTarget);
          if (relative.startsWith('..') || path.isAbsolute(relative)) {
            fs.rmSync(entryPath, { force: true });
          }
        } catch (error) {
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

function runGit(cwd, args) {
  return spawnSync('git', args, {
    cwd,
    encoding: 'utf8'
  });
}

function isGitRepo(cwd) {
  const repoCheck = runGit(cwd, ['rev-parse', '--is-inside-work-tree']);
  return repoCheck.status === 0;
}

function isCleanWorkingTree(cwd) {
  const statusCheck = runGit(cwd, ['status', '--porcelain']);
  return statusCheck.status === 0 && statusCheck.stdout.trim() === '';
}

function createGitWorktreeSnapshot(cwd, runId, snapshotLabel) {
  const snapshotDir = path.join(
    getManagedSnapshotRoot(),
    `${runId}-${snapshotLabel}`
  );
  assertPathWithin(getManagedSnapshotRoot(), snapshotDir, 'Snapshot');
  fs.rmSync(snapshotDir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(snapshotDir), { recursive: true });
  const result = runGit(cwd, ['worktree', 'add', '--detach', snapshotDir, 'HEAD']);
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || 'Failed to create git worktree snapshot.');
  }
  return {
    type: 'git-worktree',
    path: snapshotDir,
    createdAt: new Date().toISOString(),
    sourcePath: cwd,
    excludedRoots: []
  };
}

function createGroupSnapshot(cwd, runId, groupIndex) {
  let snapshot;
  if (isGitRepo(cwd) && isCleanWorkingTree(cwd)) {
    snapshot = createGitWorktreeSnapshot(cwd, runId, `group-${groupIndex}`);
  } else {
    // Non-git or dirty working tree: use temp-copy so the snapshot reflects
    // the actual working state (staged + unstaged changes), not just HEAD.
    const snapshotDir = path.join(
      getManagedSnapshotRoot(),
      `${runId}-group-${groupIndex}`
    );
    assertPathWithin(getManagedSnapshotRoot(), snapshotDir, 'Snapshot');
    fs.rmSync(snapshotDir, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(snapshotDir), { recursive: true });
    copyWorkspaceToSnapshot(cwd, snapshotDir);
    snapshot = {
      type: 'temp-copy',
      path: snapshotDir,
      createdAt: new Date().toISOString(),
      sourcePath: cwd,
      excludedRoots: ['.claude', '.collab', 'node_modules', '.git', '.env*']
    };
  }
  removeExternalSymlinks(snapshot.path);
  writeJson(groupSnapshotFile(cwd, runId, groupIndex), snapshot);
  return snapshot;
}

module.exports = {
  createGroupSnapshot
};
