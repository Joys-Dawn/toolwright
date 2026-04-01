#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { ensureCollabDir } = require('../lib/collab-dir');
const { registerAgent } = require('../lib/agents');
const { validateSessionId } = require('../lib/constants');

function shellQuote(value) {
  return '\'' + String(value).replace(/'/g, '\'\\\'\'') + '\'';
}

function persistSessionEnv(sessionId, cwd) {
  const envFile = process.env.CLAUDE_ENV_FILE;
  if (!envFile) {
    return;
  }

  const lines = [
    `export COLLAB_SESSION_ID=${shellQuote(sessionId)}`,
    `export COLLAB_PROJECT_CWD=${shellQuote(cwd)}`,
    ''
  ];
  fs.appendFileSync(envFile, lines.join('\n'), 'utf8');
}

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

  // Don't register agents inside agentwright snapshot directories — they are
  // ephemeral, read-only workspaces that should not grow .claude/collab/ state.
  const snapshotRoot = path.join(os.tmpdir(), 'agentwright-snapshots');
  if (path.resolve(cwd).toLowerCase().startsWith(snapshotRoot.toLowerCase())) {
    process.exit(0);
  }

  const collabDir = ensureCollabDir(cwd);
  registerAgent(collabDir, session_id);
  persistSessionEnv(session_id, cwd);

  process.exit(0);
}

main().catch(err => {
  process.stderr.write('[collab/register] ' + (err.stack || err.message || err) + '\n');
  process.exit(0);
});
