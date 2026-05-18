'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  assertPathWithin,
  getManagedSnapshotRoot,
  getClaudeProjectsDir,
  claudeProjectSlug,
  managedSnapshotProjectSlugPrefix,
  groupSnapshotFile
} = require('./paths');
const { writeJson } = require('./io');
const { shouldExclude, EXCLUDED_ROOTS, SECRET_ENV_NAMES } = require('./exclude-rules');

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


function createGitWorktreeSnapshot(cwd, runId, snapshotLabel) {
  const snapshotDir = path.join(
    getManagedSnapshotRoot(cwd),
    `${runId}-${snapshotLabel}`
  );
  assertPathWithin(getManagedSnapshotRoot(cwd), snapshotDir, 'Snapshot');
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

function getDirtyFiles(cwd) {
  const unstaged = spawnSync('git', ['diff', '--name-only'], { cwd, encoding: 'utf8' });
  const staged = spawnSync('git', ['diff', '--name-only', '--cached'], { cwd, encoding: 'utf8' });
  const untracked = spawnSync('git', ['ls-files', '--others', '--exclude-standard'], { cwd, encoding: 'utf8' });
  if (unstaged.status !== 0 || staged.status !== 0 || untracked.status !== 0) {
    process.stderr.write('Warning: git commands failed while collecting dirty files; overlay may be incomplete.\n');
  }
  const files = new Set([
    ...(unstaged.stdout || '').split('\n').map(f => f.trim()).filter(Boolean),
    ...(staged.stdout || '').split('\n').map(f => f.trim()).filter(Boolean),
    ...(untracked.stdout || '').split('\n').map(f => f.trim()).filter(Boolean)
  ]);
  return [...files].filter(f => !shouldExclude(f));
}

function overlayDirtyFiles(cwd, snapshotDir, dirtyFiles) {
  for (const relFile of dirtyFiles) {
    const srcPath = path.join(cwd, relFile);
    const destPath = path.join(snapshotDir, relFile);
    try {
      if (!fs.existsSync(srcPath)) {
        // File was deleted in the working tree — remove from snapshot too
        fs.rmSync(destPath, { force: true });
        continue;
      }
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.copyFileSync(srcPath, destPath);
    } catch (err) {
      process.stderr.write(`Warning: failed to overlay ${relFile}: ${err.message}\n`);
    }
  }
}

function createGroupSnapshot(cwd, runId, groupIndex) {
  let snapshot;
  if (isGitRepo(cwd)) {
    snapshot = createGitWorktreeSnapshot(cwd, runId, `group-${groupIndex}`);
    const dirtyFiles = getDirtyFiles(cwd);
    if (dirtyFiles.length > 0) {
      overlayDirtyFiles(cwd, snapshot.path, dirtyFiles);
      snapshot.dirtyOverlay = true;
      snapshot.dirtyFiles = dirtyFiles;
    } else {
      snapshot.dirtyOverlay = false;
    }
  } else {
    // Non-git project: use temp-copy as fallback.
    const snapshotDir = path.join(
      getManagedSnapshotRoot(cwd),
      `${runId}-group-${groupIndex}`
    );
    assertPathWithin(getManagedSnapshotRoot(cwd), snapshotDir, 'Snapshot');
    fs.rmSync(snapshotDir, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(snapshotDir), { recursive: true });
    copyWorkspaceToSnapshot(cwd, snapshotDir);
    snapshot = {
      type: 'temp-copy',
      path: snapshotDir,
      createdAt: new Date().toISOString(),
      sourcePath: cwd,
      excludedRoots: [...EXCLUDED_ROOTS, ...SECRET_ENV_NAMES]
    };
  }
  removeExternalSymlinks(snapshot.path);
  writeJson(groupSnapshotFile(cwd, runId, groupIndex), snapshot);
  return snapshot;
}

/**
 * Scans the managed snapshot root for directories that are not referenced
 * by any active run. Removes orphans left behind by crashed processes.
 *
 * The snapshot root is per-project (see `projectSnapshotKey` in paths.js),
 * so this sweep only sees this project's snapshots — concurrent audits in
 * other projects on the same machine are namespaced into sibling subdirs
 * and remain invisible (and untouched) here.
 *
 * Also sweeps leaked Claude Code transcript dirs: spawned auditors run with
 * cwd = a snapshot dir, so Claude Code writes a transcript dir under
 * <projects>/<slug-of-snapshot-dir>/ that survives snapshot teardown (its
 * own GC is 30 days out). Any projects dir whose name starts with this
 * project's managed-snapshot slug prefix is unambiguously one of ours —
 * the prefix embeds 'agentwright-snapshots' and a per-project sha256. This
 * runs even when the snapshot root no longer exists, which is exactly the
 * leaked-backlog case (tmp snapshots already gone, transcripts left behind).
 *
 * @param {string} cwd - Project working directory.
 * @param {function} listRuns - Returns [{runId, run}] for all known runs.
 */
function cleanupOrphanedSnapshots(cwd, listRuns) {
  const removed = [];
  // Group-snapshot dir names referenced by a still-known run (any status,
  // until pruneTerminalRuns removes its run.json). A known run's snapshot and
  // transcript are torn down deliberately by removeSnapshotFromFile when its
  // group completes — the sweeps below must NOT race that by deleting them
  // out from under a concurrently active auditor.
  const knownGroupDirs = new Set();
  const slugPrefix = managedSnapshotProjectSlugPrefix(cwd);
  const knownTranscriptDirs = new Set();
  for (const entry of listRuns(cwd)) {
    for (const group of entry.run.groups || []) {
      const groupDir = `${entry.runId}-group-${group.index}`;
      knownGroupDirs.add(groupDir);
      knownTranscriptDirs.add(slugPrefix + claudeProjectSlug(groupDir));
    }
  }

  const snapshotRoot = getManagedSnapshotRoot(cwd);
  if (fs.existsSync(snapshotRoot)) {
    for (const entry of fs.readdirSync(snapshotRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (knownGroupDirs.has(entry.name)) continue;
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
  }
  const projectsDir = getClaudeProjectsDir();
  if (fs.existsSync(projectsDir)) {
    for (const entry of fs.readdirSync(projectsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (!entry.name.startsWith(slugPrefix)) continue;
      if (knownTranscriptDirs.has(entry.name)) continue;
      const target = path.join(projectsDir, entry.name);
      try {
        assertPathWithin(projectsDir, target, 'Claude project transcript');
        fs.rmSync(target, { recursive: true, force: true });
        removed.push(entry.name);
      } catch (err) {
        process.stderr.write(`Warning: failed to remove leaked transcript dir ${entry.name}: ${err.message}\n`);
      }
    }
  }
  return removed;
}

module.exports = {
  createGroupSnapshot,
  cleanupOrphanedSnapshots
};
