'use strict';

const { tailReader, append } = require('./bus-log');
const { assertLockHeld, readAgents } = require('./agents');
const { createEvent, SYNTHETIC_SENDER, isUrgent, matchesSession } = require('./bus-schema');
const { normalizeFilePath } = require('./path-normalize');
const interestIndex = require('./interest-index');

// Two file_freed events for the same (file, to) emitted within this window
// collapse to the first. Anchored to the first occurrence (see deduplicateFileFreed).
const FILE_FREED_DEDUP_WINDOW_MS = 5000;

/**
 * Returns urgent events targeted at this session from the bus log.
 * `token` must be the lock-acquisition token from withAgentsLock.
 *
 * Deduplicates file_freed events: within FILE_FREED_DEDUP_WINDOW_MS on (meta.file, to), keeps only the first.
 *
 * @returns {{ events: object[], endOffset: number }}
 */
function listInbox(token, collabDir, sessionId, fromOffset) {
  assertLockHeld(token, collabDir);
  const { events, endOffset } = tailReader(token, collabDir, fromOffset);
  const now = Date.now();

  const urgent = events.filter(e =>
    isUrgent(e) &&
    matchesSession(e, sessionId) &&
    !isExpired(e, now)
  );

  // Deduplicate file_freed: within 5s on (meta.file, to)
  const deduped = deduplicateFileFreed(urgent);

  return { events: deduped, endOffset };
}

function isExpired(event, now) {
  return event.expires_at && event.expires_at < (now || Date.now());
}

/**
 * Collapses duplicate file_freed events within FILE_FREED_DEDUP_WINDOW_MS on (meta.file, to).
 *
 * Window is ANCHORED to the first kept occurrence: if we keep at t=0 and see
 * another at t=3 (drop) and t=6 (keep — 6 > 0+5), the next kept anchor becomes
 * t=6 and the next window runs until t=11. This is NOT a rolling "since last
 * seen" window; intentionally so, to bound worst-case delivery latency.
 */
function deduplicateFileFreed(events) {
  const seen = new Map();
  return events.filter(e => {
    if (e.type !== 'file_freed' || !e.meta || !e.meta.file) return true;
    const toStr = Array.isArray(e.to) ? e.to.join(',') : e.to;
    const key = e.meta.file + '|' + toStr;
    const prev = seen.get(key);
    if (prev !== undefined && (e.ts - prev) < FILE_FREED_DEDUP_WINDOW_MS) {
      return false;
    }
    seen.set(key, e.ts);
    return true;
  });
}

/**
 * Finds sessions interested in a file, filtered by liveness and TTL.
 * `token` required because the self-heal rebuild path calls tailReader.
 *
 * @returns {Array<{ sessionId: string, busEventId: string, declaredAt: number, expiresAt: number|null }>}
 */
function findInterested(token, collabDir, filePath) {
  assertLockHeld(token, collabDir);
  filePath = normalizeFilePath(filePath);
  let index;
  try {
    // Delegates the read→rebuild-on-corrupt fallback to interest-index so
    // both mutating callers (upsert/removeBySession) and read-only callers
    // (this one) share one code path. The outer try returns [] if even the
    // rebuild fails — callers treat empty-interest as safe default rather
    // than propagating a corrupt-bus failure up the stack.
    index = interestIndex.readOrRebuild(token, collabDir);
  } catch (_) {
    return [];
  }

  const entries = index[filePath];
  if (!entries || entries.length === 0) return [];

  const agents = readAgents(collabDir);
  const now = Date.now();

  return entries.filter(e => {
    // Session must be alive
    if (!agents[e.sessionId]) return false;
    // TTL must not be expired
    if (e.expiresAt && e.expiresAt < now) return false;
    return true;
  });
}

/**
 * Registers interest in a file. Appends bus event AND updates index.
 * `token` must be the lock-acquisition token from withAgentsLock.
 *
 * TOCTOU handling: scans the full context dir inside the lock to determine
 * whether ANY session currently claims the file. If not, immediately appends
 * a file_freed event targeted at this session — catches the case where the
 * caller decided to register interest based on a pre-lock snapshot that has
 * since gone stale (including newly-registered sessions the snapshot missed).
 *
 * @returns {string} Event ID of the interest event.
 */
function writeInterest(token, collabDir, sessionId, filePath, ttlMs) {
  assertLockHeld(token, collabDir);

  // Normalize defensively so MCP callers that pass raw agent input produce
  // the same index keys as guard.js and auto-track.js.
  filePath = normalizeFilePath(filePath);

  const expiresAt = ttlMs ? Date.now() + ttlMs : null;
  const event = createEvent(sessionId, 'all', 'interest', 'Watching ' + filePath, {
    file: filePath,
    blocked_at: Date.now(),
    ttl_ms: ttlMs || null
  }, 'info', expiresAt);

  append(token, collabDir, event);
  interestIndex.upsert(token, collabDir, filePath, {
    sessionId,
    busEventId: event.id,
    declaredAt: event.ts,
    expiresAt
  });

  // Lazy-require to avoid circular dep (session-state imports bus-query).
  const { isFileClaimedByAnySession } = require('./session-state');
  if (!isFileClaimedByAnySession(collabDir, filePath)) {
    const freed = createEvent(SYNTHETIC_SENDER, sessionId, 'file_freed',
      filePath + ' is now available',
      { file: filePath, released_by: 'race-recovery', reason: 'toctou' }
    );
    append(token, collabDir, freed);
  }

  return event.id;
}

/**
 * Appends a semantic ack event. `token` must match withAgentsLock.
 * @returns {string} Event ID.
 */
function writeAck(token, collabDir, sessionId, ackOf, decision) {
  assertLockHeld(token, collabDir);
  const event = createEvent(sessionId, 'all', 'ack', 'Ack: ' + decision, {
    ack_of: ackOf,
    decision: decision || 'accepted'
  });
  append(token, collabDir, event);
  return event.id;
}

/**
 * Builds file_freed events for every agent interested in any of the given files,
 * minus the releaser and any explicitly excluded recipients. `token` required
 * (findInterested needs it).
 *
 * If `stillClaimed` is provided, files in that set are skipped — emitting
 * file_freed when another session still claims the file would mislead watchers:
 * they'd attempt a Write and then hit the guard's overlap block with no
 * follow-up notification.
 *
 * @param {symbol} token
 * @param {string} collabDir
 * @param {object} opts
 * @param {string} opts.releasedBy - Session ID credited as the releaser (event.from + meta.released_by).
 * @param {string[]} opts.files - File paths being released.
 * @param {string} opts.reason - Short tag written to meta.reason ('scavenge' | 'session_cleanup' | 'handoff').
 * @param {Set<string>|string[]} [opts.excludeRecipients] - Session IDs to skip (e.g., handoff recipient).
 * @param {Set<string>} [opts.stillClaimed] - Files currently claimed by other sessions;
 *   these are skipped so watchers aren't notified of availability that doesn't actually exist.
 * @returns {object[]} Array of file_freed events.
 */
function buildFileFreedEvents(token, collabDir, { releasedBy, files, reason, excludeRecipients, stillClaimed }) {
  assertLockHeld(token, collabDir);
  if (!files || files.length === 0) return [];
  const exclude = excludeRecipients instanceof Set
    ? excludeRecipients
    : new Set(excludeRecipients || []);
  const events = [];
  for (const file of files) {
    if (!file) continue;
    if (stillClaimed && stillClaimed.has(file)) continue;
    const interested = findInterested(token, collabDir, file);
    for (const entry of interested) {
      if (entry.sessionId === releasedBy) continue;
      if (exclude.has(entry.sessionId)) continue;
      events.push(createEvent(releasedBy, entry.sessionId, 'file_freed',
        file + ' is now available',
        { file, released_by: releasedBy, reason }
      ));
    }
  }
  return events;
}

module.exports = { listInbox, findInterested, writeInterest, writeAck, buildFileFreedEvents, matchesSession, isUrgent };
