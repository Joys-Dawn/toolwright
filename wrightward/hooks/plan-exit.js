#!/usr/bin/env node
'use strict';

// PostToolUse hook for ExitPlanMode.
// If other agents are active, inject a reminder to declare file claims.

const fs = require('fs');
const path = require('path');

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) {
    raw += chunk;
  }

  let input;
  try {
    input = JSON.parse(raw);
  } catch (_) {
    process.exit(0);
  }

  const { session_id, cwd } = input;
  if (!cwd) process.exit(0);

  const agentsFile = path.join(cwd, '.claude', 'collab', 'agents.json');
  if (!fs.existsSync(agentsFile)) process.exit(0);

  let agents;
  try {
    agents = JSON.parse(fs.readFileSync(agentsFile, 'utf8'));
  } catch (_) {
    process.exit(0);
  }

  const otherAgents = Object.keys(agents).filter(id => id !== session_id);
  if (otherAgents.length === 0) process.exit(0);

  process.stdout.write(JSON.stringify({
    systemMessage: 'You just exited plan mode and now have a clear picture of which files you will touch. Other agents are active in this repo — run /wrightward:collab-context to declare your file claims before writing any code.'
  }));
}

main().catch(() => process.exit(0));
