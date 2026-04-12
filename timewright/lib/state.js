'use strict';

const fs = require('fs');
const path = require('path');

// All timewright state lives under <cwd>/.claude/timewright/.
// That entire directory is excluded from snapshotting (see lib/excludes.js),
// so the snapshot never recurses into itself.
//
// The "stale" flag is represented as a directory containing one file per
// PostToolUse hook invocation. Using a directory of uniquely-named files
// (rather than a single shared flag file) makes the hook safe against the
// EBUSY / EACCES races that can happen on Windows when multiple parallel
// PostToolUse hooks write to the same path concurrently.

function getTimewrightRoot(cwd) {
  return path.join(cwd, '.claude', 'timewright');
}

function getSnapshotDir(cwd) {
  return path.join(getTimewrightRoot(cwd), 'snapshot');
}

function getMetadataPath(cwd) {
  return path.join(getTimewrightRoot(cwd), 'snapshot.json');
}

function getStaleDir(cwd) {
  return path.join(getTimewrightRoot(cwd), 'stale.d');
}

function ensureRoot(cwd) {
  fs.mkdirSync(getTimewrightRoot(cwd), { recursive: true });
}

// A snapshot is "stale" (needs to be recreated at next UserPromptSubmit) if:
//   - any entry exists inside stale.d/ (a mutating tool ran since last snapshot), OR
//   - no snapshot exists yet (fresh install, first run in this project)
function isStale(cwd) {
  ensureRoot(cwd);
  if (!fs.existsSync(getSnapshotDir(cwd))) return true;
  const dir = getStaleDir(cwd);
  if (!fs.existsSync(dir)) return false;
  try {
    const entries = fs.readdirSync(dir);
    return entries.length > 0;
  } catch {
    return false;
  }
}

// Append a unique marker file to stale.d/. Safe under concurrent writers
// because each marker has a unique path — no two writes hit the same file.
function markStale(cwd) {
  ensureRoot(cwd);
  const dir = getStaleDir(cwd);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const id = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    fs.writeFileSync(path.join(dir, id), '');
  } catch (err) {
    process.stderr.write(`timewright: failed to mark stale: ${err.message}\n`);
  }
}

// Clear every marker in stale.d/. After this, isStale() returns false (until
// the next PostToolUse fires). Called from the UserPromptSubmit hook after
// a successful snapshot, or from the restore routine after /undo applies.
function markFresh(cwd) {
  const dir = getStaleDir(cwd);
  if (!fs.existsSync(dir)) return;
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    try {
      fs.rmSync(path.join(dir, entry), { force: true });
    } catch {
      // Ignore: another writer may be racing with us. Leftover markers
      // are harmless — they just cause one extra snapshot next turn.
    }
  }
}

function readMetadata(cwd) {
  const metaPath = getMetadataPath(cwd);
  if (!fs.existsSync(metaPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  } catch {
    return null;
  }
}

function writeMetadata(cwd, metadata) {
  ensureRoot(cwd);
  fs.writeFileSync(getMetadataPath(cwd), JSON.stringify(metadata, null, 2));
}

module.exports = {
  getTimewrightRoot,
  getSnapshotDir,
  getMetadataPath,
  getStaleDir,
  ensureRoot,
  isStale,
  markStale,
  markFresh,
  readMetadata,
  writeMetadata
};
