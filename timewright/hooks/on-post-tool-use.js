#!/usr/bin/env node
'use strict';

// PostToolUse hook. Fires after every Bash / Write / Edit / MultiEdit /
// NotebookEdit tool call (the mutating tools). Sole job: flip the stale
// flag so the next UserPromptSubmit takes a fresh snapshot.
//
// Must be fast and must never block the tool call. We do no git operations
// beyond resolving the repo root. If the caller is not inside a git repo,
// we silently no-op — timewright doesn't support non-git projects, and
// creating .claude/timewright/ in non-git dirs would just litter state
// that no snapshot/undo path will ever consume.

const fs = require('fs');

const { markStale } = require('../lib/state');
const { resolveRepoRoot } = require('../lib/root');

function readHookInput() {
  try {
    return JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch {
    return {};
  }
}

function main() {
  const input = readHookInput();
  const cwd = input.cwd || process.cwd();

  // Defense in depth: only act on mutating tools. The matcher in hooks.json
  // should already restrict this, but a plugin user could re-register.
  const toolName = input.tool_name || '';
  const mutatingTools = new Set([
    'Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit'
  ]);
  if (toolName && !mutatingTools.has(toolName)) {
    return;
  }

  // Resolve the project root via walk-up + git-toplevel fallback. `establish`
  // writes the anchor if one doesn't exist yet — covers the case where
  // SessionStart didn't run (e.g. plugin just installed) or the root file
  // was deleted. Non-git projects return null and opt out.
  const repoRoot = resolveRepoRoot(cwd, { establish: true });
  if (!repoRoot) {
    return;
  }

  try {
    markStale(repoRoot);
  } catch (err) {
    process.stderr.write(`timewright: ${err.message}\n`);
  }
}

main();
