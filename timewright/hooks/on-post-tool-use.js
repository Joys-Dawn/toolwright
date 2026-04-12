#!/usr/bin/env node
'use strict';

// PostToolUse hook. Fires after every Bash / Write / Edit / MultiEdit /
// NotebookEdit tool call (the mutating tools). Sole job: flip the stale
// flag so the next UserPromptSubmit takes a fresh snapshot.
//
// Must be fast and must never block the tool call. We do no git operations
// here — just touch a flag file under .claude/timewright/stale.

const fs = require('fs');

const { markStale } = require('../lib/state');

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

  try {
    markStale(cwd);
  } catch (err) {
    process.stderr.write(`timewright: ${err.message}\n`);
  }
}

main();
