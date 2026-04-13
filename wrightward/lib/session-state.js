'use strict';

const fs = require('fs');
const path = require('path');
const { readAgents, withAgentsLock, writeAgents } = require('./agents');
const { readContext, writeContext, removeContext } = require('./context');
const { removeContextHash } = require('./context-hash');
const { appendBatch } = require('./bus-log');
const { buildFileFreedEvents } = require('./bus-query');
const interestIndex = require('./interest-index');

/**
 * Collects file_freed events for all files a session holds, targeted at
 * currently interested agents. `token` required (buildFileFreedEvents needs it).
 *
 * Excludes sessions in `excludeForClaimCheck` from the still-claimed snapshot
 * so a file being released by A (but also claimed by B) still correctly
 * suppresses the event — while a file only claimed by A itself (the session
 * being cleaned up) does not spuriously suppress it.
 *
 * @param {Set<string>|string[]} [excludeForClaimCheck] - sessions to exclude from
 *   the stillClaimed snapshot (typically all sessions about to be removed).
 */
function collectFileFreedEvents(token, collabDir, sessionId, ctx, excludeForClaimCheck) {
  if (!ctx || !Array.isArray(ctx.files) || ctx.files.length === 0) return [];
  const files = ctx.files
    .filter(f => f && f.path && f.prefix !== '-')
    .map(f => f.path);
  const excludeSet = excludeForClaimCheck instanceof Set
    ? new Set(excludeForClaimCheck)
    : new Set(excludeForClaimCheck || []);
  excludeSet.add(sessionId);
  const stillClaimed = getAllClaimedFiles(collabDir, excludeSet);
  return buildFileFreedEvents(token, collabDir, {
    releasedBy: sessionId,
    files,
    reason: 'session_cleanup',
    stillClaimed
  });
}

/**
 * Removes all state for a session: context, context-hash, agent entry.
 * Emits file_freed events for interested agents and cleans up interest index.
 * `token` required (buildFileFreedEvents and appendBatch need it).
 */
function removeSessionStateInLock(token, collabDir, sessionId) {
  const ctx = readContext(collabDir, sessionId);
  const fileFreedEvents = collectFileFreedEvents(token, collabDir, sessionId, ctx);

  removeContext(collabDir, sessionId);
  removeContextHash(collabDir, sessionId);

  const agents = readAgents(collabDir);
  delete agents[sessionId];
  writeAgents(collabDir, agents);

  if (fileFreedEvents.length > 0) {
    try {
      appendBatch(token, collabDir, fileFreedEvents);
    } catch (err) {
      process.stderr.write('[session-state] file_freed append failed: ' + (err.message || err) + '\n');
    }
  }

  try {
    interestIndex.removeBySession(token, collabDir, sessionId);
  } catch (err) {
    process.stderr.write('[session-state] interest cleanup failed: ' + (err.message || err) + '\n');
  }
}

function removeSessionState(collabDir, sessionId) {
  withAgentsLock(collabDir, (token) => removeSessionStateInLock(token, collabDir, sessionId));
}

/**
 * Removes expired session rows (and their context/interest state), returns the
 * session IDs that were removed. Caller must hold withAgentsLock.
 */
function scavengeExpiredSessionsInLock(token, collabDir, maxAgeMs, excludeSessionId) {
  const agents = readAgents(collabDir);
  const cutoff = Date.now() - maxAgeMs;
  const expiredIds = [];

  for (const [sessionId, data] of Object.entries(agents)) {
    if (sessionId === excludeSessionId) continue;
    if (data.last_active < cutoff) expiredIds.push(sessionId);
  }

  const allFileFreedEvents = [];
  // All sessions being scavenged must be excluded from the claim check —
  // otherwise session X's file_freed would be suppressed by session Y's
  // soon-stale claim (Y is also about to be removed in this loop).
  const expiredSet = new Set(expiredIds);
  for (const sessionId of expiredIds) {
    const ctx = readContext(collabDir, sessionId);
    allFileFreedEvents.push(...collectFileFreedEvents(token, collabDir, sessionId, ctx, expiredSet));

    removeContext(collabDir, sessionId);
    removeContextHash(collabDir, sessionId);
    delete agents[sessionId];
  }

  if (expiredIds.length > 0) {
    writeAgents(collabDir, agents);
  }

  if (allFileFreedEvents.length > 0) {
    try {
      appendBatch(token, collabDir, allFileFreedEvents);
    } catch (err) {
      process.stderr.write('[session-state] scavenge file_freed append failed: ' + (err.message || err) + '\n');
    }
  }

  for (const sessionId of expiredIds) {
    try {
      interestIndex.removeBySession(token, collabDir, sessionId);
    } catch (err) {
      process.stderr.write('[session-state] scavenge interest cleanup for ' + sessionId + ' failed: ' + (err.message || err) + '\n');
    }
  }

  return expiredIds;
}

function scavengeExpiredSessions(collabDir, maxAgeMs, excludeSessionId) {
  return withAgentsLock(collabDir, (token) =>
    scavengeExpiredSessionsInLock(token, collabDir, maxAgeMs, excludeSessionId)
  );
}

/**
 * Removes expired file entries from all contexts, returns an array of
 * { sessionId, file } objects for files that were removed. Caller must
 * hold withAgentsLock.
 */
function scavengeExpiredFilesInLock(collabDir, config) {
  const contextDir = path.join(collabDir, 'context');
  let entries;
  try {
    entries = fs.readdirSync(contextDir);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      process.stderr.write('[session-state] scavengeExpiredFiles readdir failed: ' + (err.message || err) + '\n');
    }
    return [];
  }

  const removedFiles = [];

  for (const filename of entries) {
    if (!filename.endsWith('.json')) continue;
    const sessionId = filename.slice(0, -5);

    const ctx = readContext(collabDir, sessionId);
    if (!ctx || !Array.isArray(ctx.files) || ctx.files.length === 0) continue;

    const now = Date.now();
    const surviving = [];
    let removedAny = false;
    for (const f of ctx.files) {
      let keep;
      if (f.source === 'auto') {
        keep = (now - f.lastTouched) <= config.AUTO_TRACKED_FILE_TIMEOUT_MS;
      } else {
        const overallExpired = (now - f.declaredAt) > config.PLANNED_FILE_TIMEOUT_MS;
        keep = !overallExpired || (now - f.lastTouched) <= config.PLANNED_FILE_GRACE_MS;
      }
      if (keep) {
        surviving.push(f);
      } else {
        removedAny = true;
        if (f && f.path) {
          removedFiles.push({ sessionId, file: f.path });
        }
      }
    }

    if (!removedAny) continue;

    ctx.files = surviving;
    writeContext(collabDir, sessionId, ctx);
  }

  return removedFiles;
}

function scavengeExpiredFiles(collabDir, config) {
  return withAgentsLock(collabDir, () => scavengeExpiredFilesInLock(collabDir, config));
}

/**
 * Checks whether any active session currently claims the given file.
 * Caller must hold withAgentsLock.
 *
 * For batch checks (e.g., heartbeat scavenge emitting file_freed for N files),
 * prefer getAllClaimedFiles to build a Set once — this function is O(sessions)
 * per call and repeats the full readdir+parse for every file.
 * @returns {boolean}
 */
function isFileClaimedByAnySession(collabDir, filePath) {
  const contextDir = path.join(collabDir, 'context');
  let entries;
  try {
    entries = fs.readdirSync(contextDir);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      process.stderr.write('[session-state] isFileClaimedByAnySession readdir failed: ' + (err.message || err) + '\n');
    }
    return false;
  }
  for (const filename of entries) {
    if (!filename.endsWith('.json')) continue;
    const sessionId = filename.slice(0, -5);
    const ctx = readContext(collabDir, sessionId);
    if (!ctx || !Array.isArray(ctx.files)) continue;
    if (ctx.files.some(f => f && f.path === filePath && f.prefix !== '-')) {
      return true;
    }
  }
  return false;
}

/**
 * Returns the set of file paths currently claimed by any active session
 * (prefix !== '-'). Single readdir + parse; O(sessions × filesPerSession) once.
 * Caller must hold withAgentsLock.
 *
 * @param {string} collabDir
 * @param {Set<string>|string[]} [excludeSessionIds] - Session IDs whose claims should not count.
 *   Callers emitting file_freed use this to exclude sessions that are about to be
 *   removed (handoff releaser, scavenged sessions) so their soon-stale claims don't
 *   suppress otherwise-valid file_freed events.
 * @returns {Set<string>}
 */
function getAllClaimedFiles(collabDir, excludeSessionIds) {
  const excludeSet = excludeSessionIds instanceof Set
    ? excludeSessionIds
    : new Set(excludeSessionIds || []);
  const claimed = new Set();
  const contextDir = path.join(collabDir, 'context');
  let entries;
  try {
    entries = fs.readdirSync(contextDir);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      process.stderr.write('[session-state] getAllClaimedFiles readdir failed: ' + (err.message || err) + '\n');
    }
    return claimed;
  }
  for (const filename of entries) {
    if (!filename.endsWith('.json')) continue;
    const sessionId = filename.slice(0, -5);
    if (excludeSet.has(sessionId)) continue;
    const ctx = readContext(collabDir, sessionId);
    if (!ctx || !Array.isArray(ctx.files)) continue;
    for (const f of ctx.files) {
      if (f && f.path && f.prefix !== '-') claimed.add(f.path);
    }
  }
  return claimed;
}

module.exports = {
  removeSessionState,
  removeSessionStateInLock,
  scavengeExpiredSessions,
  scavengeExpiredSessionsInLock,
  scavengeExpiredFiles,
  scavengeExpiredFilesInLock,
  isFileClaimedByAnySession,
  getAllClaimedFiles
};
