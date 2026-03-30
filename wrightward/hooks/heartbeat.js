#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { updateHeartbeat, withAgentsLock } = require('../lib/agents');
const { readContext, writeContext } = require('../lib/context');
const { scavengeExpiredSessions } = require('../lib/session-state');
const { validateSessionId } = require('../lib/constants');

const HARD_SCAVENGE_MS = 60 * 60 * 1000;

async function main() {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  const { session_id, cwd, tool_name, tool_input } = JSON.parse(input);
  if (!session_id || !cwd) {
    process.exit(0);
  }
  validateSessionId(session_id);

  const collabDir = path.join(cwd, '.collab');

  // If .collab doesn't exist, nothing to do
  if (!fs.existsSync(collabDir)) {
    process.exit(0);
  }

  scavengeExpiredSessions(collabDir, HARD_SCAVENGE_MS, session_id);
  updateHeartbeat(collabDir, session_id);

  // Auto-track files this agent successfully wrote.
  // This lives in the heartbeat hook rather than a separate PostToolUse hook
  // to avoid doubling the per-tool-call overhead (two hooks vs one).
  // Wrapped in withAgentsLock to prevent TOCTOU when parallel tool calls
  // fire concurrent PostToolUse hooks for the same session.
  if ((tool_name === 'Edit' || tool_name === 'Write') && tool_input && tool_input.file_path) {
    withAgentsLock(collabDir, () => {
      const ctx = readContext(collabDir, session_id);
      if (ctx) {
        const relative = path.relative(cwd, tool_input.file_path);
        if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
          const prefix = tool_name === 'Write' ? '+' : '~';
          const prefixed = prefix + relative.split(path.sep).join('/');
          const existingFiles = ctx.files || [];
          // Check for either prefix variant to avoid duplicates
          const bare = relative.split(path.sep).join('/');
          if (!existingFiles.some(f => f.replace(/^[+~-]/, '') === bare)) {
            ctx.files = [...existingFiles, prefixed];
            writeContext(collabDir, session_id, ctx);
          }
        }
      }
    });
  }

  process.exit(0);
}

main().catch(err => {
  process.stderr.write('[collab/heartbeat] ' + (err.stack || err.message || err) + '\n');
  process.exit(0);
});
