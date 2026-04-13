'use strict';

const fs = require('fs');
const path = require('path');
const { atomicWriteJson } = require('./atomic-write');

const INDEX_DIR = 'bus-index';
const INDEX_FILE = 'interest.json';

function indexPath(collabDir) {
  return path.join(collabDir, INDEX_DIR, INDEX_FILE);
}

/**
 * Reads the interest index. Returns {} for a missing file (ENOENT), but
 * throws on parse errors so callers (findInterested) can trigger rebuild
 * from bus.jsonl instead of silently degrading to "no interest exists".
 *
 * Shape: { "src/auth.ts": [{ sessionId, busEventId, declaredAt, expiresAt }], ... }
 */
function read(collabDir) {
  let raw;
  try {
    raw = fs.readFileSync(indexPath(collabDir), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
  return JSON.parse(raw);
}

/**
 * Writes the interest index atomically.
 */
function write(collabDir, index) {
  atomicWriteJson(indexPath(collabDir), index);
}

/**
 * Reads the index, or rebuilds it from bus.jsonl on parse error. `token`
 * required because rebuild calls tailReader under the lock. Used by mutating
 * helpers so a corrupt index is repaired in place rather than overwritten
 * with {} (which would lose legitimate interest entries for unrelated files).
 */
function readOrRebuild(token, collabDir) {
  try {
    return read(collabDir);
  } catch (_) {
    process.stderr.write('[interest-index] read failed, rebuilding from bus.jsonl\n');
    return rebuild(token, collabDir);
  }
}

/**
 * Adds or updates an interest entry for a file. Creates file key if missing.
 * Deduplicates by (sessionId, file) — updates existing entry in place if found.
 * Fails loudly on non-string `file` or non-object `entry` so a caller bug
 * can't silently corrupt the index (e.g., with an [object Object] key).
 */
function upsert(token, collabDir, file, entry) {
  if (typeof file !== 'string' || file.length === 0) {
    throw new TypeError('interestIndex.upsert: file must be a non-empty string, got ' + typeof file);
  }
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new TypeError('interestIndex.upsert: entry must be a plain object');
  }
  const index = readOrRebuild(token, collabDir);
  if (!index[file]) {
    index[file] = [];
  }
  const existing = index[file].findIndex(e => e.sessionId === entry.sessionId);
  if (existing >= 0) {
    index[file][existing] = entry;
  } else {
    index[file].push(entry);
  }
  write(collabDir, index);
}

/**
 * Removes all interest entries for a session.
 * Cleans up empty file keys.
 */
function removeBySession(token, collabDir, sessionId) {
  const index = readOrRebuild(token, collabDir);
  let changed = false;
  for (const file of Object.keys(index)) {
    const before = index[file].length;
    index[file] = index[file].filter(e => e.sessionId !== sessionId);
    if (index[file].length !== before) changed = true;
    if (index[file].length === 0) {
      delete index[file];
    }
  }
  if (changed) {
    write(collabDir, index);
  }
}

/**
 * Rebuilds the interest index from bus.jsonl. `token` required (tailReader
 * asserts it). Called via the rebuildInterestIndex callback in bus-log.compact.
 * @param {symbol} token
 * @param {string} collabDir
 */
function rebuild(token, collabDir) {
  // Lazy-require to avoid circular dependency at module load time
  const { tailReader } = require('./bus-log');
  const { events } = tailReader(token, collabDir, 0);
  const index = {};
  for (const e of events) {
    if (e.type === 'interest' && e.meta && e.meta.file) {
      const file = e.meta.file;
      if (!index[file]) index[file] = [];
      index[file].push({
        sessionId: e.from,
        busEventId: e.id,
        declaredAt: e.ts,
        expiresAt: e.expires_at || null
      });
    }
  }
  write(collabDir, index);
  return index;
}

module.exports = { read, write, readOrRebuild, upsert, removeBySession, rebuild, indexPath };
