#!/usr/bin/env node
// PostToolUse hook, narrow-matched to wrightward_list_inbox.
//
// Two jobs:
//   1) Diff the active role-set against the sidecar. When the set changes,
//      inject the newly-added role prompts (or "no-longer-applies" notes
//      for removed roles) via hookSpecificOutput.additionalContext.
//   2) Re-ground the self-recall rule. Long conversations drop earlier
//      additionalContext blocks out of context naturally; bus-reads are
//      a frequent + predictable surface (they happen on every channel
//      doorbell), so re-injecting the rule here keeps it sticky.
//
// PostToolUse honors hookSpecificOutput.additionalContext per
// https://code.claude.com/docs/en/hooks (verified 2026-05-13).
//
// On any error this hook exits with {} — failing to inject context here
// must not block the agent's turn.

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
      // Even when nothing changed, refresh the sidecar (no-op write if equal)
      // and re-emit the self-recall rule (when relevant — see gate below) so
      // it stays in the agent's recent context window. This is the only
      // between-turn surface we have for re-grounding voluntary-compliance
      // instructions.
      try { writeSidecar(sessionId, curr); } catch (e) {
        logHookError('post-tool-use-inbox', 'sidecar write failed', e);
      }
    } catch (e) {
      logHookError('post-tool-use-inbox', 'role read failed', e);
      // Continue with empty diff — the self-recall rule still emits below
      // (when its gate is satisfied) so the inbox-read surface stays
      // re-grounded even when role state is unreadable. Closing the store
      // happens in the outer finally.
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
  // Re-emit the self-recall rule, gated on (embedderCached && longCount > 0)
  // for the same reason as session-start: if there's nothing to recall, the
  // rule teaches the agent to call a tool that returns [] or errors with
  // SETUP_HINT. Sticky re-emission still works for sessions where recall is
  // actually live.
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
