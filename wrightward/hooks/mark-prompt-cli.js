#!/usr/bin/env node
'use strict';

// UserPromptSubmit hook. Records that the user just typed in the local CLI.
// Pairs with broker/inbound-poll.mjs which records channel='discord' on each
// Discord-targeted user_message ingest. Whichever writes most recently wins —
// the consumer (ask-user.js / plan-approve.js) reads the marker as the
// authoritative "where is the user right now" answer.

const { resolveCollabDir } = require('../lib/collab-dir');
const { loadConfig } = require('../lib/config');
const { writeMarker } = require('../lib/last-prompt');
const { validateSessionId } = require('../lib/constants');

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;

  let input;
  try { input = JSON.parse(raw); } catch (_) { process.exit(0); }

  const { session_id, cwd } = input;
  if (!session_id || !cwd) process.exit(0);
  validateSessionId(session_id);

  const resolved = resolveCollabDir(cwd);
  if (!resolved) process.exit(0);
  if (!loadConfig(resolved.root).ENABLED) process.exit(0);

  try {
    writeMarker(resolved.collabDir, session_id, 'cli');
  } catch (_) {
    // best-effort; do not block prompt submission on marker write failure
  }
}

main().catch(() => process.exit(0));
