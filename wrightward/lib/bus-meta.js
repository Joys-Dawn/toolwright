'use strict';

const fs = require('fs');
const path = require('path');
const { atomicWriteJson } = require('./atomic-write');

const META_FILE = 'bus-meta.json';

function metaPath(collabDir) {
  return path.join(collabDir, META_FILE);
}

const EMPTY_META = { generation: 0, eventCount: 0, lastTs: 0 };

// Sentinel returned on parse failure. A distinct value from fresh-file 0 so
// that bookmark staleness detection always fires on a corrupt meta file —
// forcing a safe full rescan with ts/id dedup instead of silently treating
// the corruption as a fresh state (which would match pre-corruption bookmarks
// and re-deliver or skip events).
const CORRUPT_GENERATION = -1;

/**
 * Reads bus metadata. Returns zero-shape on missing file (ENOENT).
 * On parse error (corrupted file) logs loudly and returns generation: -1 so
 * every bookmark compares as stale.
 */
function readMeta(collabDir) {
  let raw;
  try {
    raw = fs.readFileSync(metaPath(collabDir), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { ...EMPTY_META };
    process.stderr.write('[bus-meta] read failed: ' + (err.message || err) + '\n');
    return { ...EMPTY_META };
  }
  try {
    const data = JSON.parse(raw);
    return {
      generation: typeof data.generation === 'number' ? data.generation : 0,
      eventCount: typeof data.eventCount === 'number' ? data.eventCount : 0,
      lastTs: typeof data.lastTs === 'number' ? data.lastTs : 0
    };
  } catch (err) {
    process.stderr.write('[bus-meta] CORRUPT bus-meta.json — flagging stale generation so bookmarks force a safe rescan; will recover on next compaction: ' + (err.message || err) + '\n');
    return { generation: CORRUPT_GENERATION, eventCount: 0, lastTs: 0 };
  }
}

function writeMeta(collabDir, meta) {
  atomicWriteJson(metaPath(collabDir), meta);
}

/**
 * Increments the event count and (optionally) updates lastTs.
 * Called by append/appendBatch. Caller must hold withAgentsLock.
 */
function incrementEventCount(collabDir, n, lastTs) {
  const meta = readMeta(collabDir);
  meta.eventCount = (meta.eventCount || 0) + (n || 1);
  if (typeof lastTs === 'number' && lastTs > (meta.lastTs || 0)) {
    meta.lastTs = lastTs;
  }
  writeMeta(collabDir, meta);
  return meta.eventCount;
}

/**
 * Bumps the generation number and resets the event count to the post-compaction total.
 * Called by compact() after a successful rewrite. Caller must hold withAgentsLock.
 */
function onCompact(collabDir, newEventCount, newLastTs) {
  const meta = readMeta(collabDir);
  // Clamp the sentinel CORRUPT_GENERATION (-1) up to 0 before incrementing so
  // post-compact generation is always >= 1. Without this, -1 || 0 === -1 and
  // compact would produce generation 0 — indistinguishable from a fresh bus
  // where every bookmark matches — re-enabling the corruption-masking path.
  meta.generation = Math.max(0, meta.generation || 0) + 1;
  meta.eventCount = newEventCount;
  if (typeof newLastTs === 'number') {
    meta.lastTs = newLastTs;
  }
  writeMeta(collabDir, meta);
  return meta.generation;
}

module.exports = { readMeta, writeMeta, incrementEventCount, onCompact, metaPath };
