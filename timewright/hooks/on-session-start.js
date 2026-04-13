#!/usr/bin/env node
'use strict';

// SessionStart hook. Fires when Claude Code begins a session. Resolves the
// git repo root from the launch cwd and records it at
// <repoRoot>/.claude/timewright/root so later PostToolUse / UserPromptSubmit
// hooks can locate the project root via walk-up — even if Claude `cd`s
// into a subdirectory (or into an unrelated directory) mid-session.
//
// Non-git projects silently opt out — timewright requires git because its
// snapshot mechanism uses `git worktree add HEAD`.
//
// Must never block the session start. All failures log to stderr and return.

const fs = require('fs');
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

  try {
    resolveRepoRoot(cwd, { establish: true });
  } catch (err) {
    process.stderr.write(`timewright: session-start failed: ${err.message}\n`);
  }
}

main();
