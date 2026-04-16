'use strict';

const fs = require('fs');
const path = require('path');
const { validateEvent } = require('./bus-schema');
const { atomicWriteJson } = require('./atomic-write');
const { assertLockHeld } = require('./agents');
const busMeta = require('./bus-meta');

const BUS_FILE = 'bus.jsonl';
const DELIVERED_DIR = 'bus-delivered';

function busPath(collabDir) {
  return path.join(collabDir, BUS_FILE);
}

function bookmarkPath(collabDir, sessionId) {
  return path.join(collabDir, DELIVERED_DIR, sessionId + '.json');
}

/**
 * Appends one event to bus.jsonl. `token` must be the Symbol minted by the
 * enclosing withAgentsLock; assertLockHeld throws otherwise.
 * @returns {number} New file size (byte offset after this append).
 */
function append(token, collabDir, event) {
  assertLockHeld(token, collabDir);
  validateEvent(event);
  const line = JSON.stringify(event) + '\n';
  const p = busPath(collabDir);
  fs.appendFileSync(p, line, 'utf8');
  busMeta.incrementEventCount(collabDir, 1, event.ts);
  return fs.statSync(p).size;
}

/**
 * Appends multiple events in a single write. `token` must match withAgentsLock.
 * @returns {number} New file size.
 */
function appendBatch(token, collabDir, events) {
  assertLockHeld(token, collabDir);
  if (events.length === 0) return getBusSize(collabDir);
  for (const event of events) {
    validateEvent(event);
  }
  const lines = events.map(e => JSON.stringify(e)).join('\n') + '\n';
  const p = busPath(collabDir);
  fs.appendFileSync(p, lines, 'utf8');
  const lastTs = events[events.length - 1].ts;
  busMeta.incrementEventCount(collabDir, events.length, lastTs);
  return fs.statSync(p).size;
}

/**
 * Reads events from bus.jsonl starting at fromOffset.
 * Caller must hold withAgentsLock.
 *
 * Each parsed event gets an _offset property = byte offset of the END of that line.
 *
 * If fromOffset > fileSize (after compaction), returns { events: [], endOffset: fileSize }.
 * If file doesn't exist, returns { events: [], endOffset: 0 }.
 *
 * @returns {{ events: object[], endOffset: number }}
 */
function tailReader(token, collabDir, fromOffset) {
  assertLockHeld(token, collabDir);
  const p = busPath(collabDir);

  let fileSize;
  try {
    fileSize = fs.statSync(p).size;
  } catch (e) {
    if (e.code === 'ENOENT') return { events: [], endOffset: 0 };
    throw e;
  }

  if (fromOffset >= fileSize) {
    return { events: [], endOffset: fileSize };
  }

  const fd = fs.openSync(p, 'r');
  try {
    const bufSize = fileSize - fromOffset;
    const buf = Buffer.alloc(bufSize);
    fs.readSync(fd, buf, 0, bufSize, fromOffset);

    const text = buf.toString('utf8');
    const lines = text.split('\n');
    const events = [];
    let currentOffset = fromOffset;

    for (const line of lines) {
      const lineBytes = Buffer.byteLength(line + '\n', 'utf8');
      if (line.trim().length === 0) {
        currentOffset += lineBytes;
        continue;
      }
      try {
        const event = JSON.parse(line);
        event._offset = currentOffset + lineBytes;
        events.push(event);
      } catch (_) {
        process.stderr.write('[bus-log] skipping malformed line at offset ' + currentOffset + '\n');
      }
      currentOffset += lineBytes;
    }

    // fromOffset + bufSize = end of everything we read. Malformed lines never
    // get an _offset set, so the +lineBytes arithmetic above is benign even
    // when we skip them.
    const endOffset = fromOffset + bufSize;

    return { events, endOffset };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Reads the delivery bookmark for a session.
 * @returns {{ lastDeliveredOffset: number, lastScannedOffset: number, lastDeliveredId: string, lastDeliveredTs: number }}
 */
function readBookmark(collabDir, sessionId) {
  const p = bookmarkPath(collabDir, sessionId);
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) {
    return { lastDeliveredOffset: 0, lastScannedOffset: 0, lastDeliveredId: '', lastDeliveredTs: 0 };
  }
}

/**
 * Writes the delivery bookmark for a session. `token` must match withAgentsLock.
 */
function writeBookmark(token, collabDir, sessionId, bookmark) {
  assertLockHeld(token, collabDir);
  atomicWriteJson(bookmarkPath(collabDir, sessionId), bookmark);
}

/**
 * Deletes the delivery bookmark for a session.
 */
function deleteBookmark(collabDir, sessionId) {
  try {
    fs.unlinkSync(bookmarkPath(collabDir, sessionId));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
}

function getBusSize(collabDir) {
  try {
    return fs.statSync(busPath(collabDir)).size;
  } catch (_) {
    return 0;
  }
}

/**
 * Initializes a session's delivery bookmark to the current tail of the bus log,
 * but only if no bookmark exists yet. Without this, fresh sessions default to
 * offset 0 and replay the entire historical bus on their first inbox scan.
 *
 * No-op when a bookmark already exists — so resumed sessions catch up from
 * where they left off as before.
 *
 * `token` must match the enclosing withAgentsLock.
 * @returns {boolean} true if a bookmark was written, false if one already existed.
 */
function initBookmarkToTail(token, collabDir, sessionId) {
  assertLockHeld(token, collabDir);
  const p = bookmarkPath(collabDir, sessionId);
  if (fs.existsSync(p)) return false;
  const endOffset = getBusSize(collabDir);
  const meta = busMeta.readMeta(collabDir);
  atomicWriteJson(p, {
    lastDeliveredOffset: endOffset,
    lastScannedOffset: endOffset,
    lastDeliveredId: '',
    lastDeliveredTs: 0,
    generation: meta.generation
  });
  return true;
}

module.exports = { append, appendBatch, tailReader, readBookmark, writeBookmark, deleteBookmark, initBookmarkToTail, busPath };
