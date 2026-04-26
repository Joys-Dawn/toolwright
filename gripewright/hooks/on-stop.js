#!/usr/bin/env node
'use strict';

const fs = require('fs');
const transcript = require('../lib/transcript');
const store = require('../lib/log-store');

function readStdin() {
  return new Promise((resolve) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { buf += chunk; });
    process.stdin.on('end', () => resolve(buf));
    process.stdin.on('error', () => resolve(buf));
  });
}

function parsePayload(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function findMostRecentRealUserIndex(events) {
  for (let i = events.length - 1; i >= 0; i--) {
    if (transcript.isRealUserMessage(events[i])) return i;
  }
  return -1;
}

function collectResponseBlocks(events, fromIdx) {
  const blocks = [];
  for (let j = fromIdx + 1; j < events.length; j++) {
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

function backfillRecord(records, sessionId, responseBlocks) {
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i];
    if (r && r.session_id === sessionId && !('wtf_response' in r)) {
      r.wtf_response = responseBlocks;
      return true;
    }
  }
  return false;
}

async function main(opts = {}) {
  const raw = opts.stdin ?? (await readStdin());
  const payload = parsePayload(raw);
  if (!payload || !payload.session_id || !payload.transcript_path) return 0;

  if (!fs.existsSync(payload.transcript_path)) return 0;

  let events;
  try {
    events = transcript.readTranscript(payload.transcript_path);
  } catch (err) {
    process.stderr.write(`[gripewright/on-stop] read transcript failed: ${err.message}\n`);
    return 0;
  }

  const userIdx = findMostRecentRealUserIndex(events);
  if (userIdx === -1) return 0;
  if (!transcript.isGripewrightWtfInvocation(events[userIdx])) return 0;

  const responseBlocks = collectResponseBlocks(events, userIdx);

  const logFile = opts.logFile ?? store.defaultLogFile();
  if (!fs.existsSync(logFile)) return 0;

  let records;
  try {
    records = store.readAllRecords({ logFile });
  } catch (err) {
    process.stderr.write(`[gripewright/on-stop] read log failed: ${err.message}\n`);
    return 0;
  }

  const updated = backfillRecord(records, payload.session_id, responseBlocks);
  if (!updated) return 0;

  try {
    store.rewriteAllRecords(records, { logFile });
  } catch (err) {
    process.stderr.write(`[gripewright/on-stop] rewrite log failed: ${err.message}\n`);
    return 0;
  }

  return 0;
}

if (require.main === module) {
  main().then(code => process.exit(code)).catch(err => {
    process.stderr.write(`[gripewright/on-stop] uncaught: ${err.stack || err.message || err}\n`);
    process.exit(0);
  });
}

module.exports = {
  main,
  parsePayload,
  findMostRecentRealUserIndex,
  collectResponseBlocks,
  backfillRecord,
};
