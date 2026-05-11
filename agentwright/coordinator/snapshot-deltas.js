'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { readJson } = require('./io');
const { groupSnapshotFile } = require('./paths');
const { shouldExclude } = require('./exclude-rules');

/**
 * Computes the diff between an existing group-0 snapshot and the current
 * working tree using the SAME file-set definition that snapshot-manager.js
 * uses to create the snapshot. Pipeline-as-atomic callers (notably forgewright's
 * end-of-workflow re-audit) consume this to decide whether to re-run a pipeline.
 *
 * The snapshot is "HEAD-tracked + dirty overlay - EXCLUDED_ROOTS - SECRET_ENV_NAMES".
 * To get an apples-to-apples comparison the cwd side applies the same filter set:
 *
 *   1. shouldExclude(rel) — drops .claude/, node_modules/, build outputs, real
 *      .env files. Mirrors snapshot-manager.js by importing the same module.
 *   2. Intersect with `git ls-files -co --exclude-standard` — drops anything
 *      .gitignore'd (project-local rules, global excludes, .git/info/exclude),
 *      so the user's own ignored files (logs, scratch dirs, temp output) don't
 *      silently push the diff above the replay threshold.
 *
 * Without (2), `git diff --no-index` against the cwd would fold gitignored
 * files into the threshold — silently triggering or suppressing replay based
 * on bookkeeping churn. Same pattern timewright uses to decide what `/undo`
 * will touch.
 */

// Single git invocation that emits numstat for every changed file across both
// trees. With --no-index between two unrelated trees, git always uses the
// rename-arrow form: `<adds>\t<dels>\t\0<oldpath>\0<newpath>\0` per record.
// /dev/null appears literally on the absent side for adds / deletes. Records
// for byte-identical files are not emitted — so this never iterates the whole
// repo, only what actually changed.
function spawnDirectoryNumstatZ(snapshotPath, cwdPath) {
  const result = spawnSync('git', [
    'diff', '--no-index', '--numstat', '-z', '--', snapshotPath, cwdPath,
  ], {
    cwd: cwdPath,
    encoding: 'utf8',
    maxBuffer: 200 * 1024 * 1024,
  });
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(
      `git diff --no-index failed (status=${result.status}): ${result.stderr.trim() || 'no stderr'}`
    );
  }
  return result.stdout || '';
}

// Counts lines the way `wc -l` with the standard tail-fix does: number of
// `\n`s, plus 1 if the file doesn't end in `\n`. `a\nb\nc\n` → 3, `a\nb\nc`
// → 3, empty file → 0. Only used for the LOC denominator in the change-
// density ratio (a coarse threshold value); the +/- per file in the diff
// itself comes from git's numstat. Spawning git per file just to recount
// lines we already have on disk would be O(N) processes for a metric that
// doesn't need git-grade accuracy.
function countNewlines(filePath) {
  let data;
  try {
    data = fs.readFileSync(filePath);
  } catch (_) {
    return 0;
  }
  if (data.length === 0) return 0;
  let count = 0;
  for (let i = 0; i < data.length; i++) {
    if (data[i] === 10) count++;
  }
  if (data[data.length - 1] !== 10) count++;
  return count;
}

// Parses the -z output of `git diff --no-index --numstat`. Each record is
// three NUL-separated tokens: `<adds>\t<dels>\t`, oldpath, newpath. Returns
// { added, deleted, oldRaw, newRaw } per record. Skips malformed records
// rather than throwing — the caller will simply ignore them.
function parseDirectoryNumstatZ(stdout) {
  const tokens = stdout.split('\0');
  const records = [];
  for (let i = 0; i + 2 < tokens.length; i += 3) {
    const header = tokens[i];
    if (!header) continue;
    const m = header.match(/^(\d+|-)\t(\d+|-)\t$/);
    if (!m) continue;
    records.push({
      added: m[1] === '-' ? 0 : Number(m[1]),
      deleted: m[2] === '-' ? 0 : Number(m[2]),
      binary: m[1] === '-' || m[2] === '-',
      oldRaw: tokens[i + 1],
      newRaw: tokens[i + 2],
    });
  }
  return records;
}

// Maps a raw path emitted by `git diff --no-index` (absolute, native
// separators on Windows but forward slashes in git's output) back to a
// repo-relative path normalized to native separators. Returns null when
// the path is /dev/null OR when the path doesn't fall under either root
// (which would mean git resolved a symlink out of the tree — ignore it).
function classifyDiffPath(rawPath, snapshotResolved, cwdResolved) {
  if (!rawPath || rawPath === '/dev/null' || rawPath === 'nul') return null;
  // Git emits forward slashes even on Windows; resolve to native separators.
  const abs = path.resolve(rawPath.replace(/\//g, path.sep));
  if (abs === cwdResolved || abs.startsWith(cwdResolved + path.sep)) {
    return { side: 'cwd', rel: path.normalize(path.relative(cwdResolved, abs)) };
  }
  if (abs === snapshotResolved || abs.startsWith(snapshotResolved + path.sep)) {
    return { side: 'snap', rel: path.normalize(path.relative(snapshotResolved, abs)) };
  }
  return null;
}

// `git ls-files -co --exclude-standard -z` is git's canonical view of
// "what's visible in this repo" — tracked + untracked-not-ignored, with
// .gitignore (project + global + .git/info/exclude) applied. Returns null
// when the dir isn't a git repo so the caller can fall back to walk-only.
function getGitVisibleFiles(cwd) {
  const result = spawnSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
  });
  if (result.status !== 0) return null;
  return new Set(
    (result.stdout || '')
      .split('\0')
      .filter(Boolean)
      .map(f => path.normalize(f))
  );
}

/**
 * Computes the diff stats between a snapshot and the current tree.
 * Cost is bounded by the number of files that actually changed, not by
 * the size of the repo (numstat-z runs once, exclusion is a Set lookup).
 *
 * @param {string} cwd - Project working directory (live tree).
 * @param {string} snapshotPath - Absolute path to the captured snapshot directory.
 * @returns {{
 *   totalAdded: number,
 *   totalDeleted: number,
 *   totalDiffLines: number,
 *   totalLoc: number,
 *   ratio: number,
 *   changedFiles: string[]
 * }}
 */
function computeDeltas(cwd, snapshotPath) {
  if (!snapshotPath || !fs.existsSync(snapshotPath)) {
    throw new Error(`Snapshot path missing or unreadable: ${snapshotPath}`);
  }

  const snapshotResolved = path.resolve(snapshotPath);
  const cwdResolved = path.resolve(cwd);
  const gitVisible = getGitVisibleFiles(cwd);

  const stdout = spawnDirectoryNumstatZ(snapshotPath, cwd);
  const records = parseDirectoryNumstatZ(stdout);

  let totalAdded = 0;
  let totalDeleted = 0;
  let totalLoc = 0;
  const changedFiles = [];

  for (const rec of records) {
    // Determine the canonical relative path. The new-side is the cwd-side
    // (or /dev/null for pure deletions); when present, prefer it. Otherwise
    // the old-side gives us the snapshot-relative path of a deletion.
    const newClassified = classifyDiffPath(rec.newRaw, snapshotResolved, cwdResolved);
    const oldClassified = classifyDiffPath(rec.oldRaw, snapshotResolved, cwdResolved);

    let rel;
    let cwdAbs = null;
    if (newClassified && newClassified.side === 'cwd') {
      rel = newClassified.rel;
      cwdAbs = path.join(cwdResolved, rel);
    } else if (oldClassified && oldClassified.side === 'snap') {
      rel = oldClassified.rel;
      // pure deletion — file no longer in cwd
    } else {
      continue;
    }

    if (shouldExclude(rel)) continue;
    // For cwd-side files, intersect with git's view (.gitignore filter).
    // Pure deletions skip this check because the file isn't in cwd anymore.
    if (cwdAbs && gitVisible && !gitVisible.has(rel)) continue;

    totalAdded += rec.added;
    totalDeleted += rec.deleted;
    changedFiles.push(rel);
    // Binary files have rec.binary === true and rec.added/deleted === 0, so
    // they contribute nothing to the numerator. Counting 0x0A bytes in their
    // bytestream toward totalLoc would inflate the denominator and bias
    // forgewright's re-audit ratio against replay. Skip them here; keep them
    // in changedFiles so callers still see what touched.
    if (cwdAbs && !rec.binary) {
      totalLoc += countNewlines(cwdAbs);
    }
  }

  const totalDiffLines = totalAdded + totalDeleted;
  const ratio = totalLoc > 0 ? totalDiffLines / totalLoc : (totalDiffLines > 0 ? 1 : 0);

  return {
    totalAdded,
    totalDeleted,
    totalDiffLines,
    totalLoc,
    ratio,
    changedFiles,
  };
}

/**
 * Reads the persisted snapshot metadata for group-0 of a run. The snapshot
 * file at `<cwd>/.claude/audit-runs/<runId>/group-0-snapshot.json` is created
 * by snapshot-manager.createGroupSnapshot and contains `{ type, path, ... }`.
 * Returns null when the file does not exist (e.g. snapshot already cleaned).
 */
function loadSnapshotMeta(cwd, runId, groupIndex = 0) {
  const file = groupSnapshotFile(cwd, runId, groupIndex);
  if (!fs.existsSync(file)) return null;
  return readJson(file);
}

module.exports = {
  computeDeltas,
  loadSnapshotMeta,
  // Exposed for unit tests.
  spawnDirectoryNumstatZ,
  parseDirectoryNumstatZ,
  classifyDiffPath,
  countNewlines,
  getGitVisibleFiles,
};
