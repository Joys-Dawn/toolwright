'use strict';

const fs = require('fs');
const transcript = require('./transcript');
const store = require('./log-store');

function findWtfEventIndices(events) {
  const indices = [];
  for (let i = 0; i < events.length; i++) {
    if (transcript.isGripewrightWtfInvocation(events[i])) indices.push(i);
  }
  return indices;
}

function findNextRealUserIdxAfter(events, fromIdx) {
  for (let j = fromIdx + 1; j < events.length; j++) {
    if (transcript.isRealUserMessage(events[j])) return j;
  }
  return events.length;
}

function collectBlocks(events, fromIdx, toIdx) {
  const blocks = [];
  for (let j = fromIdx + 1; j < toIdx; j++) {
    const e = events[j];
    const ts = e.timestamp || '';
    if (e.type === 'assistant') {
      for (const blk of transcript.extractAssistantBlocks(e)) {
        blk.timestamp = ts;
        blocks.push(blk);
      }
    } else if (e.type === 'user') {
      const tr = transcript.extractToolResult(e);
      if (tr) {
        tr.timestamp = ts;
        blocks.push(tr);
      }
    }
  }
  return blocks;
}

// Returns { recordIdx, sessionPosition } for the LAST pending record
// belonging to sessionId, where sessionPosition is the 0-indexed position
// among records for this session. The K-th log record for a session
// corresponds to the K-th /gripewright:wtf event in the transcript —
// finding the right /wtf by session position (not "most recent /wtf
// overall") is what makes chained interrupts safe.
function findLastPendingSessionRecord(records, sessionId) {
  let sessionCount = 0;
  let lastPending = null;
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    if (!r || r.session_id !== sessionId) continue;
    if (!('wtf_response' in r)) {
      lastPending = { recordIdx: i, sessionPosition: sessionCount };
    }
    sessionCount++;
  }
  return lastPending;
}

function runBackfill({ sessionId, transcriptPath, logFile, requireWtfIsLastUser, onError }) {
  if (!sessionId || !transcriptPath || !logFile) return;
  if (!fs.existsSync(logFile)) return;
  if (!fs.existsSync(transcriptPath)) return;

  let events;
  try {
    events = transcript.readTranscript(transcriptPath);
  } catch (err) {
    onError?.('read transcript failed', err);
    return;
  }

  // Lock spans the read-modify-write so a concurrent appendRecord (a
  // /wtf in another session) can't slip in between our read and rewrite
  // and have its tail clobbered.
  try {
    store.withLogLock(logFile, () => {
      let records;
      try {
        records = store.readAllRecords({ logFile });
      } catch (err) {
        onError?.('read log failed', err);
        return;
      }

      const pending = findLastPendingSessionRecord(records, sessionId);
      if (!pending) return;

      const wtfIndices = findWtfEventIndices(events);
      const wtfIdx = wtfIndices[pending.sessionPosition];
      if (wtfIdx === undefined) return;

      const nextUserIdx = findNextRealUserIdxAfter(events, wtfIdx);
      if (requireWtfIsLastUser && nextUserIdx !== events.length) return;

      records[pending.recordIdx].wtf_response = collectBlocks(events, wtfIdx, nextUserIdx);

      try {
        store.rewriteAllRecords(records, { logFile });
      } catch (err) {
        onError?.('rewrite log failed', err);
      }
    });
  } catch (err) {
    onError?.('lock acquisition failed', err);
  }
}

module.exports = {
  findWtfEventIndices,
  findNextRealUserIdxAfter,
  collectBlocks,
  findLastPendingSessionRecord,
  runBackfill,
};
