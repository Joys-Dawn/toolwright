#!/usr/bin/env node
'use strict';

// PermissionRequest hook for ExitPlanMode. When the user is on Discord, posts
// the plan to Discord (via the bus → bridge), waits up to 5 minutes for a reply
// targeted at this session, and emits an approve/deny decision back to Claude
// Code. On no reply within the window, emits a deny that tells the model to
// stop and wait for the user — no automatic re-presentation.
//
// When the user is on CLI (or there is no marker yet), exits silently so the
// local approval dialog renders normally.
//
// Reply parsing: the entire (trimmed) message must match an approval keyword
// followed by optional trailing punctuation. See APPROVE_PATTERN below for the
// full set. 👍 alone is also treated as approval. Anything else (including
// commentary like "approve, also ship tomorrow") is denied with the user's
// body as the reason.

const { resolveCollabDir } = require('../lib/collab-dir');
const { loadConfig } = require('../lib/config');
const { readMarker } = require('../lib/last-prompt');
const { validateSessionId } = require('../lib/constants');
const { withAgentsLock } = require('../lib/agents');
const { createEvent } = require('../lib/bus-schema');
const { append, tailReader } = require('../lib/bus-log');

// Timeout and poll interval can be overridden via env vars for tests; in
// production they default to 5 minutes / 2 seconds. Polling is intentional —
// fs.watch is unreliable on Windows (missed events, EPERM on rename) and the
// agents-lock acquisition is cheap enough that 150 ticks over 5 minutes is fine.
const TIMEOUT_MS = parseInt(process.env.WRIGHTWARD_PLAN_APPROVE_TIMEOUT_MS, 10) || 5 * 60 * 1000;
const POLL_INTERVAL_MS = parseInt(process.env.WRIGHTWARD_PLAN_APPROVE_POLL_MS, 10) || 2000;

const TIMEOUT_DENY_MESSAGE =
  "User did not respond on Discord within 5 minutes. Stop and wait for the user — " +
  "do NOT re-present the plan automatically. The user will say 'ask me again' " +
  "(or similar) when ready, at which point you can re-call ExitPlanMode.";

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function emit(decision) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision
    }
  }));
}

const APPROVE_PATTERN = /^(approve|approved|yes|y|ok|okay|lgtm|ship\s*it|go|proceed)\s*[!.]*\s*$/i;

function parseReply(body) {
  const trimmed = (body || '').trim();
  if (trimmed === '👍') return { behavior: 'allow' };
  if (APPROVE_PATTERN.test(trimmed)) return { behavior: 'allow' };
  return { behavior: 'deny', message: trimmed || 'Plan rejected by user.' };
}

function isDiscordReplyForSession(event, sessionId) {
  if (!event || event.type !== 'user_message') return false;
  if (!event.meta || event.meta.source !== 'discord') return false;
  const targets = Array.isArray(event.to) ? event.to : [event.to];
  return targets.includes(sessionId);
}

function postPlanToBus(collabDir, sessionId, body) {
  let endOffset = 0;
  withAgentsLock(collabDir, (token) => {
    const event = createEvent(sessionId, 'user', 'agent_message', body);
    endOffset = append(token, collabDir, event);
  });
  return endOffset;
}

async function waitForReply(collabDir, sessionId, fromOffset) {
  const deadline = Date.now() + TIMEOUT_MS;
  let cursor = fromOffset;
  while (Date.now() < deadline) {
    let reply = null;
    try {
      withAgentsLock(collabDir, (token) => {
        const { events, endOffset } = tailReader(token, collabDir, cursor);
        cursor = endOffset;
        for (const e of events) {
          if (isDiscordReplyForSession(e, sessionId)) {
            reply = e;
            break;
          }
        }
      });
    } catch (_) {
      // Lock contention — try again next tick.
    }
    if (reply) return reply;
    await sleep(POLL_INTERVAL_MS);
  }
  return null;
}

function buildBody(planText) {
  return [
    'Plan ready for review:',
    '',
    planText,
    '',
    '---',
    'Reply `approve` to proceed, or `deny: <reason>` (or just type your feedback) to keep planning.',
    'No reply within 5 minutes → I will stop and wait. Say "ask me again" to re-present.'
  ].join('\n');
}

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;

  let input;
  try { input = JSON.parse(raw); } catch (_) { process.exit(0); }

  const { session_id, cwd, tool_input } = input;
  if (!session_id || !cwd) process.exit(0);
  validateSessionId(session_id);

  const resolved = resolveCollabDir(cwd);
  if (!resolved) process.exit(0);
  if (!loadConfig(resolved.root).ENABLED) process.exit(0);

  const marker = readMarker(resolved.collabDir, session_id);
  if (!marker || marker.channel !== 'discord') {
    // User is on CLI — let the local approval dialog render.
    process.exit(0);
  }

  // ExitPlanMode's tool_input shape is documented as { plan: string }. Fall
  // back to a JSON dump if the field is missing or unexpectedly shaped so we
  // never silently drop the plan content.
  const planText = (tool_input && typeof tool_input.plan === 'string')
    ? tool_input.plan
    : JSON.stringify(tool_input || {}, null, 2);

  const body = buildBody(planText);
  const baselineOffset = postPlanToBus(resolved.collabDir, session_id, body);

  const reply = await waitForReply(resolved.collabDir, session_id, baselineOffset);

  if (!reply) {
    emit({ behavior: 'deny', message: TIMEOUT_DENY_MESSAGE });
    return;
  }

  emit(parseReply(reply.body));
}

if (require.main === module) {
  main().catch(err => {
    process.stderr.write('[wrightward/plan-approve] ' + (err.stack || err.message || err) + '\n');
    // Fall through to the local approval dialog rather than blocking the user.
    process.exit(0);
  });
}

module.exports = { parseReply };
