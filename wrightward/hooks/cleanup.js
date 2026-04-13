#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { resolveCollabDir } = require('../lib/collab-dir');
const { removeSessionStateInLock } = require('../lib/session-state');
const { validateSessionId } = require('../lib/constants');
const { withAgentsLock } = require('../lib/agents');
const { append } = require('../lib/bus-log');
const { createEvent } = require('../lib/bus-schema');
const { loadConfig } = require('../lib/config');
const { bindingsDir: mcpBindingsDir } = require('../lib/mcp-ticket');

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

  const resolved = resolveCollabDir(cwd);
  if (!resolved) {
    process.exit(0);
  }
  const { root, collabDir } = resolved;
  const config = loadConfig(root);

  // Single lock for the entire teardown so a concurrent SessionStart can't
  // observe half-cleaned state.
  try {
    withAgentsLock(collabDir, (token) => {
      removeSessionStateInLock(token, collabDir, session_id);

      if (config.BUS_ENABLED) {
        try {
          append(token, collabDir, createEvent(session_id, 'all', 'session_ended',
            'Session ended', {}));
        } catch (err) {
          process.stderr.write('[collab/cleanup] session_ended append failed: ' + (err.message || err) + '\n');
        }
      }
    });
  } catch (err) {
    process.stderr.write('[collab/cleanup] teardown failed: ' + (err.message || err) + '\n');
  }

  // MCP binding ticket cleanup: scan all tickets and delete the one whose
  // session_id matches ours. N is the number of active MCP bindings —
  // single-digit in practice — so the scan is cheaper than persisting
  // ticket pids on the agent row just to save a readdir + JSON.parse.
  // Unconditional: a prior session may have registered a ticket while
  // BUS_ENABLED was true, so we must clean up even if it's currently false.
  const bindingsDir = mcpBindingsDir(collabDir);
  let files;
  try {
    files = fs.readdirSync(bindingsDir);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      process.stderr.write('[collab/cleanup] bindings scan failed: ' + (err.message || err) + '\n');
    }
    files = [];
  }
  for (const file of files) {
    const ticketPath = path.join(bindingsDir, file);
    try {
      const ticket = JSON.parse(fs.readFileSync(ticketPath, 'utf8'));
      if (ticket.session_id === session_id) {
        fs.unlinkSync(ticketPath);
      }
    } catch (err) {
      if (err.code !== 'ENOENT') {
        process.stderr.write('[collab/cleanup] ticket scan/delete ' + file + ': ' + (err.message || err) + '\n');
      }
    }
  }

  process.exit(0);
}

main().catch(err => {
  process.stderr.write('[collab/cleanup] ' + (err.stack || err.message || err) + '\n');
  process.exit(0);
});
