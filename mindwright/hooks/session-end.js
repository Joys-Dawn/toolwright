#!/usr/bin/env node
// SessionEnd hook. One job: final transcript flush so nothing in the tail
// of the session gets dropped. No retrieval, no cap-check hint (no next
// turn to read it). Mirrors stop.js's first pass without the cap surface.
//
// On any error: silent exit. The session is ending anyway.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { openStore } from '../lib/store.js';
import { flushTranscript } from '../lib/transcript-flush.js';
import { logHookError } from '../lib/hook-log.js';

async function main() {
  let input;
  try {
    input = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    process.stdout.write('{}\n');
    return;
  }

  const sessionId = input.session_id;
  const transcriptPath = input.transcript_path;
  if (!sessionId || !transcriptPath) {
    process.stdout.write('{}\n');
    return;
  }

  let store;
  try {
    store = openStore();
  } catch (e) {
    logHookError('session-end', 'store open failed', e);
    process.stdout.write('{}\n');
    return;
  }

  try {
    const flushed = flushTranscript({ store, sessionId, transcriptPath });
    if (flushed.error) {
      logHookError('session-end', 'flush failed', flushed.error);
    }
  } finally {
    store.close();
  }

  process.stdout.write('{}\n');
}

// Only run main() when this file is invoked directly by Claude Code (as a
// hook script), not when imported for unit testing — the import path
// would otherwise trigger a stdin read that blocks the test runner.
const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((err) => {
    logHookError('session-end', 'crashed', err);
    process.stdout.write('{}\n');
  });
}
