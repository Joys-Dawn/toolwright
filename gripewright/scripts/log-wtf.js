#!/usr/bin/env node
'use strict';

const fs = require('fs');
const transcript = require('../lib/transcript');
const store = require('../lib/log-store');

function parseArgs(args) {
  if (args.length < 1 || !args[0].trim()) {
    return { sessionId: null, lookback: 1, reason: null };
  }
  const sessionId = args[0].trim();
  let rest = args.slice(1);
  let lookback = 1;
  if (rest.length > 0 && /^\d+$/.test(rest[0])) {
    const n = parseInt(rest[0], 10);
    if (n < 1) {
      return { sessionId, lookback: null, reason: null };
    }
    lookback = n;
    rest = rest.slice(1);
  }
  const reason = rest.join(' ').trim() || null;
  return { sessionId, lookback, reason };
}

function readStdinSync() {
  if (process.stdin.isTTY) return '';
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

// Parse stdin into { lookback, reason } without tokenizing the reason.
// Strip an optional leading positive integer (followed by whitespace) as the
// lookback; everything after that whitespace is the reason verbatim — internal
// newlines, tabs, and repeated spaces are preserved as the user typed them.
function parseStdinInput(stdin) {
  if (!stdin) return { lookback: 1, reason: null };
  const text = stdin.trim();
  if (!text) return { lookback: 1, reason: null };

  const withReason = text.match(/^(\d+)\s+([\s\S]+)$/);
  if (withReason) {
    const n = parseInt(withReason[1], 10);
    if (n < 1) return { lookback: null, reason: null };
    return { lookback: n, reason: withReason[2] || null };
  }
  const onlyNumber = text.match(/^(\d+)$/);
  if (onlyNumber) {
    const n = parseInt(onlyNumber[1], 10);
    if (n < 1) return { lookback: null, reason: null };
    return { lookback: n, reason: null };
  }
  return { lookback: 1, reason: text };
}

function main(args, opts = {}) {
  let sessionId, lookback, reason;
  if (opts.stdin !== undefined) {
    sessionId = (args[0] || '').trim();
    ({ lookback, reason } = parseStdinInput(opts.stdin));
  } else {
    ({ sessionId, lookback, reason } = parseArgs(args));
  }
  if (!sessionId) {
    process.stderr.write('ERROR: session id required as first argument\n');
    return 1;
  }
  if (lookback === null) {
    process.stderr.write('ERROR: lookback must be a positive integer (>= 1)\n');
    return 1;
  }

  const jsonlPath = transcript.findSessionJsonl(sessionId, opts);
  if (!jsonlPath) {
    process.stderr.write(`ERROR: no transcript found for session ${sessionId}\n`);
    return 1;
  }

  const events = transcript.readTranscript(jsonlPath);

  // The /wtf invocation has not yet been written to the JSONL when this script
  // runs as `!`-preprocessing. Every entry in `realUserIndices` is therefore a
  // valid prior prompt — never slice off the tail.
  const realUserIndices = [];
  for (let i = 0; i < events.length; i++) {
    if (transcript.isRealUserMessage(events[i])) realUserIndices.push(i);
  }
  if (realUserIndices.length === 0) {
    process.stderr.write('ERROR: no real user message found before the wtf invocation\n');
    return 1;
  }

  const effectiveLookback = Math.min(lookback, realUserIndices.length);
  const priorIdx = realUserIndices[realUserIndices.length - effectiveLookback];
  const priorEvent = events[priorIdx];
  const priorText = transcript.extractUserText(priorEvent);
  const priorTs = priorEvent.timestamp || '';

  const recordSessionId = priorEvent.sessionId || (events[0]?.sessionId ?? sessionId);
  const cwd = priorEvent.cwd || '';
  const gitBranch = priorEvent.gitBranch || '';

  const turnEvents = [];
  for (let j = priorIdx + 1; j < events.length; j++) {
    const e = events[j];
    const ts = e.timestamp || '';
    if (e.type === 'assistant') {
      for (const blk of transcript.extractAssistantBlocks(e)) {
        blk.timestamp = ts;
        turnEvents.push(blk);
      }
    } else if (e.type === 'user') {
      if (transcript.isGripewrightWtfInvocation(e)) continue;
      const tr = transcript.extractToolResult(e);
      if (tr) {
        tr.timestamp = ts;
        turnEvents.push(tr);
        continue;
      }
      const userText = transcript.extractUserText(e);
      if (!userText.trim()) continue;
      if (transcript.isSyntheticUserMarker(userText)) continue;
      turnEvents.push({ type: 'user_followup', text: userText, timestamp: ts });
    }
  }

  const record = {
    logged_at: new Date().toISOString(),
    session_id: recordSessionId,
    transcript_path: jsonlPath,
    cwd,
    git_branch: gitBranch,
    reason,
    lookback_requested: lookback,
    lookback_effective: effectiveLookback,
    prior_user_prompt: { text: priorText, timestamp: priorTs },
    turn_events: turnEvents,
  };

  store.appendRecord(record, opts);

  const nEvents = turnEvents.length;
  const nThinking = turnEvents.filter(e => e.type === 'thinking').length;
  const nTool = turnEvents.filter(e => e.type === 'tool_use').length;
  const turnWord = effectiveLookback === 1 ? 'turn' : 'turns';
  const logFile = opts.logFile ?? store.defaultLogFile();
  process.stdout.write(
    `Logged wtf to ${logFile}: ${nEvents} events (${nThinking} thinking, ${nTool} tool calls, ${effectiveLookback} ${turnWord} back)\n`
  );
  return 0;
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2), { stdin: readStdinSync() }));
}

module.exports = { parseArgs, main, parseStdinInput };
