'use strict';

const fs = require('fs');
const path = require('path');

const { shouldExclude } = require('./excludes');
const {
  getSnapshotDir,
  readMetadata,
  markFresh
} = require('./state');
const { getRealRepoHead, runGit } = require('./snapshot');

// Files at or below this size are compared via a single readFileSync on
// each side. Anything larger is compared chunk-by-chunk via streamCompare,
// which bounds memory to ~128 KB regardless of file size.
const INLINE_COMPARE_THRESHOLD = 1024 * 1024; // 1 MB
const STREAM_CHUNK = 64 * 1024;

// Walks `rootDir` and yields every file / symlink / directory under it as a
// path relative to `rootDirForRelative`, skipping anything excluded by
// shouldExclude. Yields directories too so the caller can prune empty ones.
//
// Dirent.isDirectory() reflects the entry itself (not a resolved symlink
// target), so we don't need a `!isSymbolicLink()` guard — the check is
// already correct.
function* walk(rootDir, rootDirForRelative = rootDir) {
  let entries;
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const abs = path.join(rootDir, entry.name);
    const rel = path.relative(rootDirForRelative, abs);
    if (shouldExclude(rel)) continue;
    if (entry.isDirectory()) {
      yield { rel, abs, kind: 'dir' };
      yield* walk(abs, rootDirForRelative);
    } else if (entry.isSymbolicLink()) {
      yield { rel, abs, kind: 'symlink' };
    } else if (entry.isFile()) {
      yield { rel, abs, kind: 'file' };
    }
  }
}

// Bounded-memory byte comparison for large files. Reads both files in
// parallel 64 KB chunks and returns false as soon as any chunk differs.
// Memory usage is bounded to ~128 KB regardless of file size, so a repo
// with a multi-GB checked-in binary cannot OOM `undo --diff`.
function streamCompare(aPath, bPath) {
  let aFd = null;
  let bFd = null;
  try {
    aFd = fs.openSync(aPath, 'r');
    bFd = fs.openSync(bPath, 'r');
    const aBuf = Buffer.alloc(STREAM_CHUNK);
    const bBuf = Buffer.alloc(STREAM_CHUNK);
    while (true) {
      const aRead = fs.readSync(aFd, aBuf, 0, STREAM_CHUNK, null);
      const bRead = fs.readSync(bFd, bBuf, 0, STREAM_CHUNK, null);
      if (aRead !== bRead) return false;
      if (aRead === 0) return true;
      if (!aBuf.subarray(0, aRead).equals(bBuf.subarray(0, bRead))) {
        return false;
      }
    }
  } catch {
    return false;
  } finally {
    if (aFd != null) {
      try { fs.closeSync(aFd); } catch {}
    }
    if (bFd != null) {
      try { fs.closeSync(bFd); } catch {}
    }
  }
}

function filesEqual(aPath, bPath) {
  let aStat;
  let bStat;
  try {
    aStat = fs.statSync(aPath);
    bStat = fs.statSync(bPath);
  } catch {
    return false;
  }
  if (aStat.size !== bStat.size) return false;

  // Small files: read both into memory and compare directly.
  if (aStat.size <= INLINE_COMPARE_THRESHOLD) {
    try {
      const a = fs.readFileSync(aPath);
      const b = fs.readFileSync(bPath);
      return a.equals(b);
    } catch {
      return false;
    }
  }

  // Large files: bounded-memory streaming compare.
  return streamCompare(aPath, bPath);
}

function getGitVisibleFiles(cwd) {
  const result = runGit(cwd, ['ls-files', '-co', '--exclude-standard', '-z']);
  if (result.status !== 0) return null;
  return new Set(
    (result.stdout || '').split('\0').filter(Boolean).map(f => path.normalize(f))
  );
}

/**
 * Computes the diff between the snapshot at `cwd` and the current working
 * tree. Returns { modified, added, removed, headDrift, metadata } where:
 *
 *   - modified: files present in both but with different contents; /undo
 *     will overwrite the working tree version with the snapshot version.
 *   - added: files in the working tree but NOT in the snapshot; /undo
 *     will DELETE these from the working tree. (This is the dangerous set.)
 *   - removed: files in the snapshot but NOT in the working tree; /undo
 *     will restore these.
 *   - headDrift: { snapshot, current } if the real repo HEAD has moved since
 *     the snapshot was taken (user ran git reset/checkout/rebase externally).
 *     Caller should warn.
 */
function computeDiff(cwd) {
  const snapshotDir = getSnapshotDir(cwd);
  if (!fs.existsSync(snapshotDir)) {
    throw new Error('No snapshot to undo to. Nothing to rewind.');
  }

  const snapshotFiles = new Map(); // rel -> abs
  for (const entry of walk(snapshotDir)) {
    if (entry.kind === 'file' || entry.kind === 'symlink') {
      snapshotFiles.set(entry.rel, entry.abs);
    }
  }

  const gitVisible = getGitVisibleFiles(cwd);

  const workingFiles = new Map();
  for (const entry of walk(cwd)) {
    if (entry.kind === 'file' || entry.kind === 'symlink') {
      if (gitVisible && !gitVisible.has(entry.rel)) continue;
      workingFiles.set(entry.rel, entry.abs);
    }
  }

  const modified = [];
  const added = [];
  const removed = [];

  for (const [rel, snapAbs] of snapshotFiles) {
    if (workingFiles.has(rel)) {
      const workAbs = workingFiles.get(rel);
      if (!filesEqual(snapAbs, workAbs)) {
        modified.push(rel);
      }
    } else {
      removed.push(rel);
    }
  }
  for (const rel of workingFiles.keys()) {
    if (!snapshotFiles.has(rel)) {
      added.push(rel);
    }
  }

  modified.sort();
  added.sort();
  removed.sort();

  const metadata = readMetadata(cwd);
  const currentHead = getRealRepoHead(cwd);
  let headDrift = null;
  if (metadata && metadata.realRepoHead && currentHead
    && metadata.realRepoHead !== currentHead) {
    headDrift = {
      snapshot: metadata.realRepoHead,
      current: currentHead
    };
  }

  return { modified, added, removed, headDrift, metadata };
}

// Copies a file or symlink entry from `srcAbs` to `destAbs`, creating any
// parent directories as needed. fs.rmSync with { force: true } is
// idempotent (no throw on missing path), so we don't need an existence
// check before removing the destination.
function copyFileOrSymlink(srcAbs, destAbs) {
  fs.mkdirSync(path.dirname(destAbs), { recursive: true });
  const stat = fs.lstatSync(srcAbs);
  if (stat.isSymbolicLink()) {
    const target = fs.readlinkSync(srcAbs);
    try { fs.rmSync(destAbs, { force: true }); } catch {}
    fs.symlinkSync(target, destAbs);
    return;
  }
  fs.copyFileSync(srcAbs, destAbs);
}

/**
 * Applies the snapshot to the working tree. Every file in the snapshot is
 * copied over its working-tree counterpart. Every file in the working tree
 * that is NOT in the snapshot (and not excluded) is deleted. Empty
 * directories left behind by deletions are pruned.
 *
 * Returns { errors } where errors is an array of { file, op, message }
 * for any file that failed to restore or delete. A non-empty errors array
 * means the restore was PARTIAL — the caller should report the failures
 * to the user (commonly caused by Windows symlink privilege issues, files
 * held open by another process, or filesystem permissions).
 *
 * Clears the stale flag on success (disk now matches snapshot).
 */
function restoreSnapshot(cwd) {
  const snapshotDir = getSnapshotDir(cwd);
  if (!fs.existsSync(snapshotDir)) {
    throw new Error('No snapshot to undo to. Nothing to rewind.');
  }

  const errors = [];
  const snapshotFiles = new Set();

  // Pass 1: copy every snapshot file into the working tree.
  for (const entry of walk(snapshotDir)) {
    if (entry.kind === 'file' || entry.kind === 'symlink') {
      snapshotFiles.add(entry.rel);
      const destAbs = path.join(cwd, entry.rel);
      try {
        copyFileOrSymlink(entry.abs, destAbs);
      } catch (err) {
        errors.push({
          file: entry.rel,
          op: 'restore',
          message: err.message
        });
        process.stderr.write(
          `timewright: failed to restore ${entry.rel}: ${err.message}\n`
        );
      }
    }
  }

  // Pass 2: delete working-tree files not present in the snapshot.
  const gitVisible = getGitVisibleFiles(cwd);
  const toDelete = [];
  const dirsSeen = [];
  for (const entry of walk(cwd)) {
    if (entry.kind === 'file' || entry.kind === 'symlink') {
      if (gitVisible && !gitVisible.has(entry.rel)) continue;
      if (!snapshotFiles.has(entry.rel)) {
        toDelete.push({ abs: entry.abs, rel: entry.rel });
      }
    } else if (entry.kind === 'dir') {
      dirsSeen.push(entry.abs);
    }
  }
  for (const { abs, rel } of toDelete) {
    try {
      fs.rmSync(abs, { force: true });
    } catch (err) {
      errors.push({
        file: rel,
        op: 'delete',
        message: err.message
      });
      process.stderr.write(
        `timewright: failed to delete ${rel}: ${err.message}\n`
      );
    }
  }

  // Pass 3: prune empty directories (deepest first). rmdirSync only removes
  // a directory if it is empty, so this is safe.
  dirsSeen.sort((a, b) => b.length - a.length);
  for (const dir of dirsSeen) {
    try {
      fs.rmdirSync(dir);
    } catch {
      // Not empty, or already gone — leave it.
    }
  }

  markFresh(cwd);
  return { errors };
}

module.exports = {
  computeDiff,
  restoreSnapshot
};
