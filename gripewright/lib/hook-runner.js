'use strict';

const backfill = require('./backfill');
const store = require('./log-store');

function readStdin() {
  return new Promise((resolve) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { buf += chunk; });
    process.stdin.on('end', () => resolve(buf));
    process.stdin.on('error', () => resolve(buf));
  });
}

function parsePayload(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// Shared entry point for the Stop and UserPromptSubmit hooks. They differ
// only in `requireWtfIsLastUser` and the diagnostic label.
async function runHook(hookName, opts = {}) {
  const requireWtfIsLastUser = !!opts.requireWtfIsLastUser;
  const raw = opts.stdin ?? (await readStdin());
  const payload = parsePayload(raw);
  if (!payload || !payload.session_id || !payload.transcript_path) return 0;

  backfill.runBackfill({
    sessionId: payload.session_id,
    transcriptPath: payload.transcript_path,
    logFile: opts.logFile ?? store.defaultLogFile(),
    requireWtfIsLastUser,
    onError: (label, err) => {
      process.stderr.write(`[gripewright/${hookName}] ${label}: ${err.message}\n`);
    },
  });

  return 0;
}

module.exports = { runHook, parsePayload, readStdin };
