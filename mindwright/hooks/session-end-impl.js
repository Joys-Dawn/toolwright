#!/usr/bin/env node
// SessionEnd hook. Last-chance flush + promotion, mirroring PreCompact.
// Sessions that /exit, /clear, logout, or terminate any other way without
// ever compacting still need their pending bucket promoted — otherwise the
// session's content would sit in pending forever, visible only to the
// orphan sweep at next SessionStart in some other session.
//
// Three jobs:
//   1. Final transcript flush so the tail lands in pending.
//   2. Promote this session's pending → real short-term.
//   3. Same shared cap+age handler PreCompact uses; may spawn the
//      consolidator.
//
// SessionEnd cannot block (the docs are explicit), so there's nothing the
// hook could do beyond logging if any step fails. On any error: silent
// exit.

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
    logHookError('session-end', 'store open failed', e);
    process.stdout.write('{}\n');
    return;
  }

  try {
    // 1) Tail flush — only when transcript_path is supplied. /clear and
    //    /exit both pass it; logout/bypass_permissions paths sometimes
    //    don't. If absent we still promote whatever pending rows are
    //    already there from the session's PreToolUse / UserPromptSubmit
    //    passes.
    if (transcriptPath) {
      const flushed = flushTranscript({ store, sessionId, transcriptPath });
      if (flushed.error) {
        logHookError('session-end', 'flush failed', flushed.error);
      }
    }
    // 2 + 3) Promote + cap check. Idempotent w.r.t. an earlier PreCompact:
    // if PreCompact already drained this session's pending bucket, the
    // promote here is a 0-row no-op and the cap check is skipped.
    promoteAndMaybeSpawn({
      store,
      ownerSessionId: sessionId,
      callerSessionId: sessionId,
      tag: 'session-end',
    });
    // 4) Clear the persisted tool_map. Any in-flight tool_uses that never
    //    got their tool_result paired (user-interrupted, killed mid-tool)
    //    are abandoned by definition once the session ends; leaving their
    //    blob in meta would leak unboundedly across many sessions.
    try {
      store.clearToolMap(sessionId);
    } catch (e) {
      logHookError('session-end', 'clearToolMap failed', e);
    }
  } finally {
    store.close();
  }

  process.stdout.write('{}\n');
}
