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
  const parts = relativePath.split(/[\\/]/);
  const basename = path.basename(relativePath);
  return parts.some(p => EXCLUDED_ROOTS.has(p))
    || basename === '.env'
    || basename.startsWith('.env.');
}

function getGitTrackedFiles(cwd) {
  const result = spawnSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024
  });
  if (result.status !== 0) {
    return null;
  }
  return result.stdout.split('\0').filter(f => f.length > 0);
}

function copyWorkspaceToSnapshot(cwd, snapshotDir) {
  const gitFiles = isGitRepo(cwd) ? getGitTrackedFiles(cwd) : null;
  if (gitFiles) {
    for (const relFile of gitFiles) {
      if (shouldExclude(relFile)) continue;
      const srcPath = path.join(cwd, relFile);
      const destPath = path.join(snapshotDir, relFile);
      try {
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        fs.copyFileSync(srcPath, destPath);
      } catch (err) {
        process.stderr.write(`Warning: failed to copy ${relFile}: ${err.message}\n`);
      }
    }
  } else {
    fs.cpSync(cwd, snapshotDir, {
      recursive: true,
      filter(sourcePath) {
        const relativePath = path.relative(cwd, sourcePath);
        return !shouldExclude(relativePath);
      }
    });
  }
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

/**
 * Scans the managed snapshot root for directories that are not referenced
 * by any active run. Removes orphans left behind by crashed processes.
 * @param {string} cwd - Project working directory.
 * @param {function} listRuns - Returns [{runId, run}] for all known runs.
 */
function cleanupOrphanedSnapshots(cwd, listRuns) {
  const snapshotRoot = getManagedSnapshotRoot();
  if (!fs.existsSync(snapshotRoot)) {
    return [];
  }
  const knownPrefixes = new Set();
  for (const entry of listRuns(cwd)) {
    const groups = entry.run.groups || [];
    for (const group of groups) {
      knownPrefixes.add(`${entry.runId}-group-${group.index}`);
    }
  }
  const removed = [];
  for (const entry of fs.readdirSync(snapshotRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (knownPrefixes.has(entry.name)) continue;
    const orphanPath = path.join(snapshotRoot, entry.name);
    try {
      const wtResult = spawnSync('git', ['worktree', 'remove', '--force', orphanPath], {
        cwd,
        encoding: 'utf8'
      });
      if (wtResult.status !== 0 && fs.existsSync(orphanPath)) {
        fs.rmSync(orphanPath, { recursive: true, force: true });
      }
      removed.push(entry.name);
    } catch (err) {
      process.stderr.write(`Warning: failed to remove orphaned snapshot ${entry.name}: ${err.message}\n`);
    }
  }
  return removed;
}

module.exports = {
  createGroupSnapshot,
  cleanupOrphanedSnapshots
};
