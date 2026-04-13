'use strict';

const { readBookmark, writeBookmark } = require('./bus-log');
const { assertLockHeld } = require('./agents');
const { listInbox } = require('./bus-query');
const busMeta = require('./bus-meta');

/**
 * Low-level primitive shared by every inbox reader: under lock, reads
 * meta + bookmark, detects whether the bookmark's byte offsets are stale
 * (bus has been compacted since), and returns the fresh urgent events for
 * this session along with everything callers need to advance the bookmark.
 *
 * On stale bookmarks, scans from offset 0 and filters out anything at or
 * before the last-delivered event (ts match + id match dedups the exact
 * event; same-ms siblings are kept).
 *
 * `token` must be the lock-acquisition token from withAgentsLock.
 *
 * @returns {{
 *   events: object[],          // urgent events targeted at this session
 *   endOffset: number,         // byte offset after the last scanned line
 *   bookmark: object,          // the bookmark as read (pre-advance)
 *   meta: object,              // bus-meta at read time
 *   isStale: boolean           // true when generation mismatch forced a full rescan
 * }}
 */
function readInboxFresh(token, collabDir, sessionId) {
  assertLockHeld(token, collabDir);

  const meta = busMeta.readMeta(collabDir);
  const bookmark = readBookmark(collabDir, sessionId);

  const bookmarkGen = typeof bookmark.generation === 'number' ? bookmark.generation : 0;
  const isStale = bookmarkGen !== meta.generation;
  const fromOffset = isStale ? 0 : (bookmark.lastScannedOffset || 0);
  // Apply ts+id dedup whenever the scan window could re-surface already-delivered
  // events — either because a compaction (isStale) reset offsets, or because a
  // caller deliberately held lastScannedOffset behind lastDeliveredOffset to
  // re-read filtered-out events (types-filter case in handleListInbox).
  const lastDeliveredOffset = bookmark.lastDeliveredOffset || 0;
  const needsDedup = isStale || fromOffset <= lastDeliveredOffset;
  const tsFilter = needsDedup ? (bookmark.lastDeliveredTs || 0) : 0;
  const lastDeliveredId = needsDedup ? (bookmark.lastDeliveredId || '') : '';

  const { events: raw, endOffset } = listInbox(token, collabDir, sessionId, fromOffset);
  const events = tsFilter > 0
    ? raw.filter(e => e.ts > tsFilter || (e.ts === tsFilter && e.id !== lastDeliveredId))
    : raw;

  return { events, endOffset, bookmark, meta, isStale };
}

/**
 * Single bookmark writer used after both delivery and scan-only ticks.
 *
 *  - `delivered`: the last delivered event, or null for scan-only ticks.
 *  - `truncated`: true when the delivered slice is smaller than the scan slice
 *    (cap, limit, or types filter shrank it). Leaves the scan cursor at the
 *    last delivered event so the tail re-surfaces next call.
 *  - No-op when neither generation nor offset moved (avoids rewriting the
 *    same bookmark on every tick).
 */
function advanceBookmark(token, collabDir, sessionId, { delivered, endOffset, bookmark, meta, isStale, truncated }) {
  assertLockHeld(token, collabDir);
  if (!delivered && !isStale && endOffset === (bookmark.lastScannedOffset || 0)) return;
  writeBookmark(token, collabDir, sessionId, {
    lastDeliveredOffset: delivered ? delivered._offset : (bookmark.lastDeliveredOffset || 0),
    lastScannedOffset: delivered && truncated ? delivered._offset : endOffset,
    lastDeliveredId: delivered ? delivered.id : (bookmark.lastDeliveredId || ''),
    lastDeliveredTs: delivered ? delivered.ts : (bookmark.lastDeliveredTs || 0),
    generation: meta.generation
  });
}

/**
 * Scans the bus inbox for urgent events, formats them for injection,
 * and advances the bookmark.
 *
 * Overflow-safe: if more urgent events exist than BUS_URGENT_INJECTION_CAP,
 * advances lastScannedOffset only to the last delivered event's offset so
 * the tail is re-surfaced on the next call.
 *
 * @param {symbol} token
 * @param {string} collabDir
 * @param {string} sessionId
 * @param {{ BUS_URGENT_INJECTION_CAP?: number }} config
 * @returns {{ text: string|null, eventCount: number }}
 */
function scanAndFormatInbox(token, collabDir, sessionId, config) {
  const { events: fresh, endOffset, bookmark, meta, isStale } = readInboxFresh(token, collabDir, sessionId);

  // config.js enforces floor 1; guard here for direct callers passing raw config.
  const cap = Math.max(1, config.BUS_URGENT_INJECTION_CAP || 5);
  const capped = fresh.slice(0, cap);

  if (capped.length === 0) {
    advanceBookmark(token, collabDir, sessionId, { delivered: null, endOffset, bookmark, meta, isStale, truncated: false });
    return { text: null, eventCount: 0 };
  }

  const lines = ['Urgent messages from other agents:'];
  for (const e of capped) {
    const shortFrom = (e.from || '').substring(0, 8);
    lines.push(`- [${e.type}] from ${shortFrom}: ${e.body}`);
  }
  if (fresh.length > cap) {
    lines.push(`(${fresh.length - cap} more — use /wrightward:inbox to see all)`);
  }

  const truncated = fresh.length > cap;
  advanceBookmark(token, collabDir, sessionId, {
    delivered: capped[capped.length - 1],
    endOffset, bookmark, meta, isStale, truncated
  });

  return { text: lines.join('\n'), eventCount: fresh.length };
}

module.exports = {
  readInboxFresh,
  advanceBookmark,
  scanAndFormatInbox
};
