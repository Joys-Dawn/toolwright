#!/usr/bin/env node
// SessionEnd hook. One job: final transcript flush so the session tail
// isn't dropped. No retrieval, no cap-check (no next turn to read it). On
// any error: silent exit.

import { readFileSync } from 'node:fs';
import { openStore } from '../lib/store.js';
import { flushTranscript } from '../lib/transcript-flush.js';
import { logHookError } from '../lib/hook-log.js';

export async function main() {
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
