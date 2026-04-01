#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { removeSessionState } = require('../lib/session-state');
const { validateSessionId } = require('../lib/constants');

async function main() {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  const { session_id, cwd } = JSON.parse(input);
  if (!session_id || !cwd) {
    process.exit(0);
  }
  validateSessionId(session_id);

  const collabDir = path.join(cwd, '.claude', 'collab');

  // If .claude/collab doesn't exist, nothing to clean up
  if (!fs.existsSync(collabDir)) {
    process.exit(0);
  }

  removeSessionState(collabDir, session_id);

  process.exit(0);
}

main().catch(err => {
  process.stderr.write('[collab/cleanup] ' + (err.stack || err.message || err) + '\n');
  process.exit(0);
});
