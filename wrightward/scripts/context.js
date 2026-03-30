#!/usr/bin/env node
'use strict';

const path = require('path');
const { ensureCollabDir } = require('../lib/collab-dir');
const { getActiveAgents, registerAgent } = require('../lib/agents');
const { readContext, writeContext } = require('../lib/context');
const { removeSessionState } = require('../lib/session-state');
const { INACTIVE_THRESHOLD_MS } = require('../lib/constants');

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

  return {
    task: payload.task.trim(),
    files: normalizeStringArray(payload.files, 'files'),
    functions: normalizeStringArray(payload.functions, 'functions'),
    status
  };
}

function getSessionContext() {
  const sessionId = process.env.COLLAB_SESSION_ID;
  const cwd = process.env.COLLAB_PROJECT_CWD;

  if (!sessionId || !cwd) {
    throw new Error('Missing COLLAB_SESSION_ID or COLLAB_PROJECT_CWD. Start a Claude session with the plugin enabled before using this command.');
  }

  return { sessionId, cwd };
}

async function main() {
  const { sessionId, cwd } = getSessionContext();
  const collabDir = ensureCollabDir(cwd);
  const markDone = process.argv.includes('--done');

  if (markDone) {
    const existing = readContext(collabDir, sessionId);
    if (!existing) {
      throw new Error('No existing ColLab context found for this session. Run /wrightward:collab-context first.');
    }

    removeSessionState(collabDir, sessionId);
    process.stdout.write('Cleared ColLab state for the current session.\n');
    return;
  }

  const input = await readStdin();
  const payload = normalizePayload(JSON.parse(input));

  // Strip files already claimed by other active agents
  const activeAgents = getActiveAgents(collabDir, INACTIVE_THRESHOLD_MS);
  const claimedFiles = new Set();
  for (const [agentId, _] of Object.entries(activeAgents)) {
    if (agentId === sessionId) continue;
    const ctx = readContext(collabDir, agentId);
    if (!ctx || ctx.status === 'done') continue;
    for (const file of ctx.files || []) {
      claimedFiles.add(file.replace(/^[+~-]/, ''));
    }
  }
  const stripped = [];
  payload.files = payload.files.filter(file => {
    const bare = file.replace(/^[+~-]/, '');
    if (claimedFiles.has(bare)) {
      stripped.push(file);
      return false;
    }
    return true;
  });

  registerAgent(collabDir, sessionId);
  writeContext(collabDir, sessionId, payload);
  if (stripped.length > 0) {
    process.stderr.write(`Removed files already claimed by other agents: ${stripped.join(', ')}\n`);
  }
  process.stdout.write('Updated ColLab context for the current session.\n');
}

main().catch(error => {
  process.stderr.write(error.message + '\n');
  process.exit(1);
});
