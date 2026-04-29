#!/usr/bin/env node
'use strict';

// PreToolUse hook for AskUserQuestion. When the user is on Discord, the local
// CLI dialog is the wrong place to ask — we deny the tool and tell the agent to
// use wrightward_send_message(audience='user') instead, then wait for an inbox
// reply. When the user is on CLI, we exit silently and let the local UI render.

const { resolveCollabDir } = require('../lib/collab-dir');
const { loadConfig } = require('../lib/config');
const { readMarker } = require('../lib/last-prompt');
const { validateSessionId } = require('../lib/constants');

const REDIRECT_MESSAGE =
  "AskUserQuestion is disabled while the user is on Discord. Send your question " +
  "via wrightward_send_message(audience='user', body='<question with options inline>'). " +
  "Then wait for the user's reply: the wrightward channel push wakes you on the next " +
  "incoming user_message, or you can call wrightward_list_inbox once on your next turn " +
  "to drain it. Embed the options directly in the body so the user can reply with one " +
  "of them in plain Discord text.";

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

  const marker = readMarker(resolved.collabDir, session_id);
  if (!marker || marker.channel !== 'discord') {
    // User is on CLI (or no marker yet) — let the local AskUserQuestion UI render.
    process.exit(0);
  }

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: REDIRECT_MESSAGE
    }
  }));
}

main().catch(() => process.exit(0));
