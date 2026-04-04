#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { updateHeartbeat } = require('../lib/agents');
const { autoTrackFile } = require('../lib/auto-track');
const { ensureCollabDir, resolveCollabDir } = require('../lib/collab-dir');
const { loadConfig } = require('../lib/config');
const { scavengeExpiredSessions, scavengeExpiredFiles } = require('../lib/session-state');
const { validateSessionId } = require('../lib/constants');

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

  const isFileOp = (tool_name === 'Edit' || tool_name === 'Write') && tool_input && tool_input.file_path;
  let resolved = resolveCollabDir(cwd);

  // If .claude/collab doesn't exist: create it only for Edit/Write when auto-tracking is on.
  // Non-file tools without an existing collab dir have nothing to do.
  if (!resolved) {
    const config = loadConfig(cwd);
    if (!config.ENABLED) process.exit(0);
    if (isFileOp && config.AUTO_TRACK) {
      const collabDir = ensureCollabDir(cwd);
      resolved = { root: path.resolve(cwd), collabDir };
    } else {
      process.exit(0);
    }
  }

  const { root, collabDir } = resolved;
  const config = loadConfig(root);
  if (!config.ENABLED) process.exit(0);

  scavengeExpiredSessions(collabDir, config.SESSION_HARD_SCAVENGE_MS, session_id);
  scavengeExpiredFiles(collabDir, config, session_id);
  updateHeartbeat(collabDir, session_id);

  if (isFileOp) {
    const reminderFiles = autoTrackFile(collabDir, session_id, root, tool_name, tool_input.file_path, config);

    if (reminderFiles && reminderFiles.length > 0) {
      const fileList = reminderFiles.join(', ');
      const idleMinutes = Math.round(config.REMINDER_IDLE_MS / 60000);
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PostToolUse',
          permissionDecision: 'allow',
          additionalContext:
            `You haven't touched these files in over ${idleMinutes} minute${idleMinutes === 1 ? '' : 's'}: ${fileList}. ` +
            'Consider releasing them with /wrightward:collab-release if you no longer need them.'
        }
      }));
    }
  }

  process.exit(0);
}

main().catch(err => {
  process.stderr.write('[collab/heartbeat] ' + (err.stack || err.message || err) + '\n');
  process.exit(0);
});
