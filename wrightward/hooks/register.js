#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { ensureCollabDir } = require('../lib/collab-dir');
const { registerAgent, registerAgentInLock, withAgentsLock } = require('../lib/agents');
const { loadConfig } = require('../lib/config');
const { validateSessionId } = require('../lib/constants');
const { scavengeExpiredFiles } = require('../lib/session-state');
const { append } = require('../lib/bus-log');
const { createEvent } = require('../lib/bus-schema');
const { atomicWriteJson } = require('../lib/atomic-write');
const { ticketPath } = require('../lib/mcp-ticket');

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

  const { session_id, cwd, source } = JSON.parse(input);
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

  const config = loadConfig(cwd);
  if (!config.ENABLED) process.exit(0);

  const collabDir = ensureCollabDir(cwd);
  // Sweep stale file entries on SessionStart. This closes the "reopened session"
  // gap: when a session is reopened after days of idleness, Cursor reuses the same
  // session UUID, so registerAgent refreshes last_active to now — making other
  // sessions treat this one as active again, while its old file claims still
  // enforce. Running scavenge here cleans the session's own (and any other
  // session's) expired entries before registration refreshes the heartbeat.
  scavengeExpiredFiles(collabDir, config);

  if (config.BUS_ENABLED) {
    // process.ppid is the direct parent (Claude CLI on POSIX, often an intermediate
    // shell on Windows). Two sessions sharing one shell would collide on a pid-only
    // ticket key, so we include this hook's own pid — two hooks in the same shell
    // write distinct tickets. session-bind.mjs scans <claudePid>-*.json.
    const claudePid = process.ppid;
    const hookPid = process.pid;
    withAgentsLock(collabDir, (token) => {
      registerAgentInLock(collabDir, session_id);

      atomicWriteJson(ticketPath(collabDir, claudePid, hookPid), {
        session_id,
        created_at: Date.now(),
        hook_pid: hookPid,
        claude_pid: claudePid
      });

      // Claude Code fires SessionStart for source ∈ {startup, resume, clear, compact}.
      // Only startup/resume mean the session is (re)joining the bus — clear and compact
      // continue the same session and must not re-announce. Undefined source (older
      // Claude Code versions that don't send the field) falls through to emit.
      const shouldAnnounce = source === undefined
        || source === 'startup'
        || source === 'resume';
      if (shouldAnnounce) {
        try {
          append(token, collabDir, createEvent(session_id, 'all', 'session_started',
            'Session started', { pid: claudePid, hook_source: source || 'startup' }));
        } catch (err) {
          process.stderr.write('[collab/register] bus append failed: ' + (err.message || err) + '\n');
        }
      }
    });
  } else {
    registerAgent(collabDir, session_id);
  }

  persistSessionEnv(session_id, cwd);

  process.exit(0);
}

main().catch(err => {
  process.stderr.write('[collab/register] ' + (err.stack || err.message || err) + '\n');
  process.exit(0);
});
