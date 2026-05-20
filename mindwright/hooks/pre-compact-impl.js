#!/usr/bin/env node
// PreCompact hook. Fires on manual /compact (matcher: "manual") and on
// auto-compact near the context limit (matcher: "auto"). NOT on /clear —
// that path goes through SessionEnd with exit_reason="clear".
//
// Two jobs in sequence:
//   1. Final transcript flush so any content emitted after the most recent
//      Stop firing lands in the pending bucket.
//   2. Promote this session's pending rows to real short-term (same shared
//      handler SessionEnd and SessionStart's orphan sweep use). The promote
//      handler runs the cap+age check on the now-real short-term count and
//      either spawns the background consolidator or stages a manual nudge.
//
// On any error: emit `{}` and exit non-blocking. The hook CAN block
// compaction (exit code 2 / decision:"block") but a memory failure must
// never prevent the user-initiated compact from running.

import { readFileSync } from 'node:fs';
import { openStore } from '../lib/store.js';
import { flushTranscript } from '../lib/transcript-flush.js';
import { promoteAndMaybeSpawn } from '../lib/promote-pending.js';
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
  if (!sessionId) {
    process.stdout.write('{}\n');
    return;
  }

  let store;
  try {
    store = openStore();
  } catch (e) {
    logHookError('pre-compact', 'store open failed', e);
    process.stdout.write('{}\n');
    return;
  }

  try {
    // 1) Tail flush — same code path as the other hooks. New chunks land in
    //    short_term_pending under this session.
    if (transcriptPath) {
      const flushed = flushTranscript({ store, sessionId, transcriptPath });
      if (flushed.error) {
        logHookError('pre-compact', 'flush failed', flushed.error);
      }
    }

    // 2) Promote this session's pending rows to real short-term and let the
    //    shared handler run the cap/age check + maybe spawn the consolidator.
    promoteAndMaybeSpawn({
      store,
      ownerSessionId: sessionId,
      callerSessionId: sessionId,
      tag: 'pre-compact',
    });
  } finally {
    store.close();
  }

  process.stdout.write('{}\n');
}
