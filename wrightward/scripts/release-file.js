#!/usr/bin/env node
'use strict';

const path = require('path');
const { resolveCollabDir } = require('../lib/collab-dir');
const { readContext, writeContext } = require('../lib/context');
const { validateSessionId } = require('../lib/constants');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--session-id' && i + 1 < argv.length) {
      args.sessionId = argv[i + 1];
      i++;
    } else if (argv[i] === '--cwd' && i + 1 < argv.length) {
      args.cwd = argv[i + 1];
      i++;
    }
  }
  return args;
}

function getSessionContext(cliArgs) {
  const sessionId = cliArgs.sessionId || process.env.COLLAB_SESSION_ID;
  if (!sessionId) {
    throw new Error('Missing session_id. Invoke via /wrightward:collab-release or pass --session-id <uuid>.');
  }

  let cwd = cliArgs.cwd || process.env.COLLAB_PROJECT_CWD;
  if (!cwd) {
    const resolved = resolveCollabDir(process.cwd());
    cwd = resolved ? resolved.root : process.cwd();
  }

  return { sessionId, cwd };
}

async function main() {
  const cliArgs = parseArgs(process.argv.slice(2));
  const { sessionId, cwd } = getSessionContext(cliArgs);
  validateSessionId(sessionId);

  const collabDir = path.join(cwd, '.claude', 'collab');
  const ctx = readContext(collabDir, sessionId);
  if (!ctx) {
    throw new Error('No collab context found for this session. Nothing to release.');
  }

  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  const payload = JSON.parse(input);
  if (!payload || !Array.isArray(payload.files) || payload.files.length === 0) {
    throw new Error('"files" must be a non-empty array of file paths to release.');
  }

  const toRelease = new Set(payload.files.map(f => f.replace(/\\/g, '/')));
  const released = [];
  const notFound = [];

  const surviving = (ctx.files || []).filter(entry => {
    if (toRelease.has(entry.path)) {
      released.push(entry.path);
      return false;
    }
    return true;
  });

  for (const f of toRelease) {
    if (!released.includes(f)) {
      notFound.push(f);
    }
  }

  ctx.files = surviving;
  writeContext(collabDir, sessionId, ctx);
  process.stdout.write(`Released: ${released.join(', ') || '(none)'}.\n`);

  if (notFound.length > 0) {
    process.stderr.write(`Not found in context: ${notFound.join(', ')}\n`);
  }
}

main().catch(error => {
  process.stderr.write(error.message + '\n');
  process.exit(1);
});
