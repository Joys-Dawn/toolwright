'use strict';

// Per-session "where did the last user-input come from" marker. Two writers:
//   - hooks/mark-prompt-cli.js (UserPromptSubmit) writes channel='cli'
//   - broker/inbound-poll.mjs writes channel='discord' for each Discord-targeted
//     session when an inbound user_message is ingested
// Two readers:
//   - hooks/ask-user.js gates AskUserQuestion deny on channel === 'discord'
//   - hooks/plan-approve.js gates PermissionRequest routing to Discord on the same

const fs = require('fs');
const path = require('path');
const { atomicWriteJson } = require('./atomic-write');
const { validateSessionId } = require('./constants');

const DIR_REL = 'last-prompt';

function markerDir(collabDir) {
  return path.join(collabDir, DIR_REL);
}

function markerPath(collabDir, sessionId) {
  return path.join(markerDir(collabDir), sessionId + '.json');
}

function readMarker(collabDir, sessionId) {
  try {
    const raw = fs.readFileSync(markerPath(collabDir, sessionId), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    if (parsed.channel !== 'cli' && parsed.channel !== 'discord') return null;
    if (typeof parsed.ts !== 'number') return null;
    return parsed;
  } catch (_) {
    return null;
  }
}

function writeMarker(collabDir, sessionId, channel) {
  validateSessionId(sessionId);
  if (channel !== 'cli' && channel !== 'discord') {
    throw new Error('channel must be "cli" or "discord"');
  }
  atomicWriteJson(markerPath(collabDir, sessionId), { channel, ts: Date.now() });
}

module.exports = { readMarker, writeMarker, markerPath, markerDir };
