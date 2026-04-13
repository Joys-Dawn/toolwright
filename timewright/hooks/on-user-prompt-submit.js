#!/usr/bin/env node
'use strict';

// UserPromptSubmit hook. Fires when the user submits a prompt. If the
// current snapshot is stale (some mutating tool ran since we last
// snapshotted), take a fresh snapshot of the working tree before Claude
// starts its turn.
//
// Critical special case: if the user is invoking /undo (or any timewright
// rewind command), we must NOT take a new snapshot — the /undo command
// needs to CONSUME the existing snapshot, not have it overwritten with the
// current (post-mutation) state. See audit finding "UserPromptSubmit hook
// overwrites the snapshot when the user types /undo" for the bug this fixes.
//
// If the snapshot is still fresh (no mutations since last snapshot), this
// hook is a no-op, so pure Read/Grep/Glob turns are free.
//
// Failures here must NEVER block the user's prompt. We catch everything
// and log to stderr.

const fs = require('fs');

const { isStale, markFresh, markStale } = require('../lib/state');
const { createSnapshot } = require('../lib/snapshot');
const { resolveRepoRoot } = require('../lib/root');

function readHookInput() {
  try {
    return JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch {
    return {};
  }
}

// Returns true if the user's prompt is an invocation of the timewright undo
// command in any of its forms (bare, namespaced, with trailing args).
function isUndoCommand(prompt) {
  if (typeof prompt !== 'string') return false;
  const trimmed = prompt.trim();
  // Match:
  //   /undo
  //   /undo <args>
  //   /timewright:undo
  //   /timewright:undo <args>
  // The trailing-space check prevents false matches like /undoable.
  const candidates = ['/undo', '/timewright:undo'];
  for (const name of candidates) {
    if (trimmed === name) return true;
    if (trimmed.startsWith(name + ' ')) return true;
    if (trimmed.startsWith(name + '\t')) return true;
  }
  return false;
}

function main() {
  const input = readHookInput();
  const cwd = input.cwd || process.cwd();
  const prompt = input.prompt || '';

  // The snapshot is what /undo restores from — never overwrite it when the
  // user is invoking the undo command itself.
  if (isUndoCommand(prompt)) {
    return;
  }

  // Resolve the project root via walk-up + git-toplevel fallback. Non-git
  // projects return null and opt out silently.
  const repoRoot = resolveRepoRoot(cwd, { establish: true });
  if (!repoRoot) {
    return;
  }

  if (!isStale(repoRoot)) {
    return;
  }

  // Race-safe ordering: clear the stale markers BEFORE taking the snapshot.
  // If a concurrent PostToolUse hook sets stale during createSnapshot, the
  // next turn will correctly re-snapshot. If instead we cleared AFTER the
  // snapshot, we could clobber a legitimate stale marker from a racing
  // PostToolUse and silently lose an entire turn's worth of protection.
  //
  // On failure, re-assert stale so the next turn tries again.
  markFresh(repoRoot);
  try {
    createSnapshot(repoRoot);
  } catch (err) {
    process.stderr.write(`timewright: snapshot failed: ${err.message}\n`);
    try {
      markStale(repoRoot);
    } catch {
      // best-effort; log already happened above
    }
    // Do not rethrow — never block the user's prompt.
  }
}

main();
