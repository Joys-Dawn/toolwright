#!/usr/bin/env node
// PostToolUse hook, narrow-matched to wrightward_list_inbox. Two jobs:
// (1) diff the active role-set against the sidecar and inject added role
// prompts / removed-role notices; (2) re-ground the self-recall rule —
// bus-reads are a frequent predictable surface, so re-injecting here keeps
// the rule sticky after long conversations drop it from context. On any
// error exit with {} — failing to inject must not block the agent's turn.

import { readFileSync } from 'node:fs';
import { openStore } from '../lib/store.js';
import { embedderCached } from '../lib/paths.js';
import { readSidecar, writeSidecar, diffRoles } from '../lib/role-sidecar.js';
import { getRolePromptsFor, getRoleUnassignNotices } from '../lib/role-prompts.js';
import { SELF_RECALL_RULE } from '../lib/constants.js';
import { logHookError } from '../lib/hook-log.js';

export async function main() {
  let input;
  try {
    input = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    process.stdout.write('{}\n');
    return;
  }
  const sessionId = input.session_id;
  if (!sessionId) {
    process.stdout.write('{}\n');
    return;
  }

  let store;
  try {
    store = openStore();
  } catch (e) {
    logHookError('post-tool-use-inbox', 'store open failed', e);
    process.stdout.write('{}\n');
    return;
  }

  let prev = [];
  let curr = [];
  let added = [];
  let removed = [];
  let longCount = 0;
  try {
    try {
      prev = readSidecar(sessionId);
      curr = store.getRoles(sessionId);
      ({ added, removed } = diffRoles(prev, curr));
      longCount = store.countByTier().long || 0;
      // Refresh the sidecar even when unchanged (no-op write if equal); the
      // self-recall re-emit below is the only between-turn surface for
      // re-grounding voluntary-compliance instructions.
      try { writeSidecar(sessionId, curr); } catch (e) {
        logHookError('post-tool-use-inbox', 'sidecar write failed', e);
      }
    } catch (e) {
      logHookError('post-tool-use-inbox', 'role read failed', e);
      // Continue with empty diff — the self-recall rule still emits below so
      // the surface stays re-grounded even when role state is unreadable.
    }
  } finally {
    store.close();
  }

  const lines = [];
  if (added.length > 0) {
    const prompts = getRolePromptsFor(added);
    if (prompts) lines.push(prompts);
  }
  if (removed.length > 0) {
    const notices = getRoleUnassignNotices(removed);
    if (notices) lines.push(notices);
  }
  // Gate on (embedderCached && longCount > 0): if there's nothing to recall,
  // the rule just teaches the agent to call a tool that returns [] or errors
  // with SETUP_HINT.
  if (embedderCached() && longCount > 0) {
    lines.push(SELF_RECALL_RULE);
  }

  if (lines.length === 0) {
    process.stdout.write('{}\n');
    return;
  }

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: lines.join('\n\n'),
      },
    }) + '\n'
  );
}
