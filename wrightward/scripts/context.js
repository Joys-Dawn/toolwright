#!/usr/bin/env node
'use strict';

const path = require('path');
const { ensureCollabDir, resolveCollabDir } = require('../lib/collab-dir');
const { getActiveAgents, registerAgent, withAgentsLock } = require('../lib/agents');
const { readContext, writeContext, fileEntryForPath } = require('../lib/context');
const { removeSessionState } = require('../lib/session-state');
const { loadConfig } = require('../lib/config');
const { writeInterest } = require('../lib/bus-query');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--session-id' && i + 1 < argv.length) {
      args.sessionId = argv[i + 1];
      i++;
    } else if (argv[i] === '--cwd' && i + 1 < argv.length) {
      args.cwd = argv[i + 1];
      i++;
    } else if (argv[i] === '--done') {
      args.done = true;
    }
  }
  return args;
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => {
      input += chunk;
    });
    process.stdin.on('end', () => resolve(input));
    process.stdin.on('error', reject);
  });
}

function normalizeStringArray(value, fieldName) {
  if (value == null) {
    return [];
  }
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new Error(`"${fieldName}" must be an array of strings.`);
  }
  return value;
}

/**
 * Converts a prefixed file string (e.g. "+src/foo.js") into a file entry object.
 */
function toFileEntry(entry) {
  if (typeof entry !== 'string') {
    throw new Error(`Each file entry must be a prefixed string (e.g. "+src/foo.js"), got ${typeof entry}.`);
  }
  const prefixMatch = entry.match(/^([+~-])/);
  const prefix = prefixMatch ? prefixMatch[1] : '~';
  const filePath = prefixMatch ? entry.slice(1) : entry;
  if (!filePath) {
    throw new Error('File path cannot be empty.');
  }
  return fileEntryForPath(filePath, prefix, 'planned');
}

function normalizePayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Context payload must be a JSON object.');
  }

  if (typeof payload.task !== 'string' || payload.task.trim() === '') {
    throw new Error('"task" must be a non-empty string.');
  }

  const status = payload.status == null ? 'in-progress' : payload.status;
  if (status !== 'in-progress' && status !== 'done') {
    throw new Error('"status" must be "in-progress" or "done".');
  }

  const rawFiles = payload.files == null ? [] : payload.files;
  if (!Array.isArray(rawFiles)) {
    throw new Error('"files" must be an array.');
  }

  return {
    task: payload.task.trim(),
    files: rawFiles.map(toFileEntry),
    functions: normalizeStringArray(payload.functions, 'functions'),
    status
  };
}

function getSessionContext(cliArgs) {
  // Priority: CLI args (from skill template substitution) > env vars > walk-up from process.cwd()
  // Env var path is kept as fallback for direct script invocation.
  const sessionId = cliArgs.sessionId || process.env.COLLAB_SESSION_ID;
  if (!sessionId) {
    throw new Error('Missing session_id. Invoke via /wrightward:collab-context or pass --session-id <uuid>.');
  }

  let cwd = cliArgs.cwd || process.env.COLLAB_PROJECT_CWD;
  if (!cwd) {
    // Try to find an existing collab dir by walking up from the current working directory.
    const resolved = resolveCollabDir(process.cwd());
    cwd = resolved ? resolved.root : process.cwd();
  }

  return { sessionId, cwd };
}

async function main() {
  const cliArgs = parseArgs(process.argv.slice(2));
  const { sessionId, cwd } = getSessionContext(cliArgs);
  const collabDir = ensureCollabDir(cwd);
  const markDone = cliArgs.done;

  if (markDone) {
    const existing = readContext(collabDir, sessionId);
    if (!existing) {
      throw new Error('No existing collab context found for this session. Use /wrightward:collab-context first.');
    }

    removeSessionState(collabDir, sessionId);
    process.stdout.write('Cleared collab state for the current session.\n');
    return;
  }

  const input = await readStdin();
  const payload = normalizePayload(JSON.parse(input));

  // Strip files already claimed by other active agents
  const config = loadConfig(cwd);
  const activeAgents = getActiveAgents(collabDir, config.INACTIVE_THRESHOLD_MS);
  const claimedFiles = new Set();
  for (const [agentId, _] of Object.entries(activeAgents)) {
    if (agentId === sessionId) continue;
    const ctx = readContext(collabDir, agentId);
    if (!ctx || ctx.status === 'done') continue;
    for (const file of ctx.files || []) {
      claimedFiles.add(file.path);
    }
  }
  const stripped = [];
  payload.files = payload.files.filter(entry => {
    if (claimedFiles.has(entry.path)) {
      stripped.push(entry);
      return false;
    }
    return true;
  });

  registerAgent(collabDir, sessionId);
  writeContext(collabDir, sessionId, payload);
  if (stripped.length > 0) {
    const formatted = stripped.map(e => e.prefix + e.path).join(', ');
    let message = `Removed files already claimed by other agents: ${formatted}.`;
    // Record interest so the agent gets a bus/channel notification when the
    // file frees up — mirrors the guard hook's behavior on blocked writes,
    // but fires on the declare-upfront path so well-behaved agents aren't
    // forced to attempt a blocked Write just to register interest.
    if (config.BUS_ENABLED) {
      try {
        withAgentsLock(collabDir, (token) => {
          for (const entry of stripped) {
            writeInterest(token, collabDir, sessionId, entry.path, config.BUS_INTEREST_TTL_MS);
          }
        });
        message += ' Interest recorded — you\'ll be notified when they free up.';
      } catch (err) {
        process.stderr.write('[collab/context] interest write failed: ' + (err.message || err) + '\n');
      }
    }
    process.stderr.write(message + '\n');
  }
  process.stdout.write('Updated collab context for the current session.\n');
}

main().catch(error => {
  process.stderr.write(error.message + '\n');
  process.exit(1);
});
