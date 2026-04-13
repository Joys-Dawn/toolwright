'use strict';

const fs = require('fs');
const path = require('path');
const { atomicWriteJson, atomicWriteText } = require('./atomic-write');
const { assertLockHeld } = require('./agents');
const busMeta = require('./bus-meta');
const { busPath } = require('./bus-log');

const DELIVERED_DIR = 'bus-delivered';

/**
 * Compacts bus.jsonl by retaining only events within the retention window.
 * Caller must hold withAgentsLock; pass its token.
 *
 * @param {symbol} token
 * @param {string} collabDir
 * @param {{ BUS_RETENTION_DAYS_MS: number, BUS_RETENTION_MAX_EVENTS: number }} config
 * @param {function} [rebuildInterestIndex] - (token, collabDir) => void. Called after rewrite
 *   so the interest index reflects only surviving events.
 * @returns {{ before: number, after: number }}
 */
function compact(token, collabDir, config, rebuildInterestIndex) {
  assertLockHeld(token, collabDir);
  const p = busPath(collabDir);

  let content;
  try {
    content = fs.readFileSync(p, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') {
      // No bus yet; still reset meta so a corrupt/stale meta record is
      // recovered in place (heartbeat may call compact specifically to
      // recover from generation: -1).
      busMeta.onCompact(collabDir, 0, 0);
      return { before: 0, after: 0 };
    }
    throw e;
  }

  const lines = content.split('\n').filter(l => l.trim().length > 0);
  const events = [];
  for (const line of lines) {
    try {
      events.push(JSON.parse(line));
    } catch (_) {
      // skip malformed
    }
  }

  const before = events.length;
  const now = Date.now();
  const ageCutoff = config.BUS_RETENTION_DAYS_MS ? now - config.BUS_RETENTION_DAYS_MS : 0;

  let surviving = ageCutoff > 0
    ? events.filter(e => e.ts >= ageCutoff)
    : events;

  // config.js guarantees BUS_RETENTION_MAX_EVENTS is set — keep the most recent.
  if (typeof config.BUS_RETENTION_MAX_EVENTS === 'number' && surviving.length > config.BUS_RETENTION_MAX_EVENTS) {
    surviving = surviving.slice(surviving.length - config.BUS_RETENTION_MAX_EVENTS);
  }

  const after = surviving.length;

  // Rewrite atomically. atomicWriteText retries Windows EPERM internally
  // and cleans up the tmp file on any failure (write or rename).
  const newContent = surviving.map(e => JSON.stringify(e)).join('\n') + (surviving.length > 0 ? '\n' : '');
  atomicWriteText(p, newContent);

  // Reset bookmarks — byte offsets are now invalid. Preserve lastDeliveredTs/Id
  // so readers can still dedup the last-seen event by ts+id.
  resetAllBookmarks(collabDir);

  // Bump generation + sync event count so future scans detect stale bookmarks.
  const survivingLastTs = surviving.length > 0 ? surviving[surviving.length - 1].ts : 0;
  busMeta.onCompact(collabDir, after, survivingLastTs);

  if (rebuildInterestIndex) {
    rebuildInterestIndex(token, collabDir);
  }

  process.stderr.write('[bus-retention] compacted ' + before + '→' + after + ' events\n');
  return { before, after };
}

/**
 * Resets all per-session bookmark offsets after compaction. Writes an explicit
 * generation: -1 sentinel so bus-delivery.readInboxFresh treats these bookmarks
 * as stale against any post-compact meta.generation (always >= 1).
 */
function resetAllBookmarks(collabDir) {
  const deliveredDir = path.join(collabDir, DELIVERED_DIR);
  let files;
  try {
    files = fs.readdirSync(deliveredDir);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      process.stderr.write('[bus-retention] resetAllBookmarks readdir failed: ' + (err.message || err) + '\n');
    }
    return;
  }
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const bp = path.join(deliveredDir, file);
    try {
      const bm = JSON.parse(fs.readFileSync(bp, 'utf8'));
      atomicWriteJson(bp, {
        lastDeliveredOffset: 0,
        lastScannedOffset: 0,
        lastDeliveredId: bm.lastDeliveredId || '',
        lastDeliveredTs: bm.lastDeliveredTs || 0,
        generation: -1
      });
    } catch (err) {
      process.stderr.write('[bus-retention] resetAllBookmarks ' + file + ' failed: ' + (err.message || err) + '\n');
    }
  }
}

module.exports = { compact, resetAllBookmarks };
