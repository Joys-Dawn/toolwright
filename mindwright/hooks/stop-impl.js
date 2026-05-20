#!/usr/bin/env node
// Stop hook. Two jobs: (1) flush final transcript content from offset → EOF
// (same chunker path as PreToolUse — chunks land in the pending bucket);
// (2) run the AGE safety-net trigger (the cap trigger has moved to the
// PreCompact/SessionEnd/orphan-sweep promote handler, since pending rows
// don't count toward cap and the cap can only cross at promotion). Stop has
// no user-visible context surface, so when age fires we stage a nudge for
// the next UserPromptSubmit to surface. On any error, exit with `{}` so the
// session isn't disrupted.

import { readFileSync } from 'node:fs';
import { openStore } from '../lib/store.js';
import { flushTranscript } from '../lib/transcript-flush.js';
import { evaluateNudgeTriggers } from '../lib/nudge.js';
import { logHookError } from '../lib/hook-log.js';
import { NUDGE_STATES, CONSOLIDATOR_COMPLETION_GRACE_MS } from '../lib/constants.js';
// isConsolidatorSession is the self-spawn guard: never spawn a consolidator
// from inside a consolidator session (co-located with the sentinel it reads).
import { isConsolidatorSession } from '../lib/consolidator-spawn.js';
import { deriveHandle } from '../lib/handles.js';
// Spawn + nudge fallback semantics shared with lib/promote-pending.js — both
// the age trigger (here) and the cap trigger (there) use the same seed-mode
// guard, reason mapping, and nudge body format.
import { trySpawnConsolidator, stagePendingNudge } from '../lib/spawn-or-nudge.js';

// Reconciliation read: trySpawnConsolidator only confirms the OS accepted the
// detached spawn, NOT that /mindwright:dream ran to completion. A completed
// dream writes a timestamped `consolidations` row — the durable "done" ack.
//
// Returns true (re-surface nudge + re-arm) when ALL hold: we DID auto-spawn on
// a prior trip, the completion lease has elapsed, and NO consolidations row
// landed with fired_at >= last_spawn — i.e. the background consolidator died
// silently and the sticky FIRED state is hiding an unconsolidated overflow.
// Returns false (stay quiet) when we never auto-spawned, are still within the
// lease (dream may legitimately still be running), or a consolidation
// completed at/after our spawn. Any error is logged and swallowed —
// reconciliation must never break the Stop hook.
function spawnedConsolidatorNeverCompleted(store, sessionId, now = Date.now()) {
  try {
    const record = store.getConsolidatorFor(deriveHandle(sessionId));
    if (!record || !record.last_spawn) return false;
    const spawnedAt = Date.parse(record.last_spawn);
    if (!Number.isFinite(spawnedAt)) return false;
    if (now - spawnedAt < CONSOLIDATOR_COMPLETION_GRACE_MS) return false;
    const last = store.lastConsolidation();
    const completedAt = last && last.fired_at ? Date.parse(last.fired_at) : NaN;
    if (Number.isFinite(completedAt) && completedAt >= spawnedAt) return false;
    return true;
  } catch (e) {
    logHookError('stop', 'consolidator reconcile failed', e);
    return false;
  }
}

// Stop's safety-net checks. Two responsibilities:
//
//   1. Age FIRE — Stop is the sole owner of the age trigger. A project with
//      promoted-but-never-distilled short-term rows still needs the safety
//      net even if no /compact has happened in days; promote-pending.js
//      can't catch that because promote sites are rare. Edge-triggered:
//      fire once per crossing, re-arm only after clear.
//   2. Reconcile (cap OR age) — detect silently-dead background
//      consolidators regardless of WHICH trigger originally spawned them.
//      Stop runs every turn, so users find out within ~one turn after the
//      completion lease elapses. The cap-spawn site (promote-pending.js) is
//      too infrequent to be the reconciler.
//
// Stop does NOT fire on cap — that's promote-pending.js's job at promotion
// boundaries where the real short-term count actually changes. But Stop
// still reads capCrossed to (a) gate the cross-trigger reconcile and (b)
// avoid prematurely re-arming a FIRED state while cap is still tripping.
function handleSafetyChecks(store, sessionId) {
  try {
    // Triggers AND nudge_state are both project-wide so quiet users with many
    // short sessions still get a nudge when total rows pile up, and a fired
    // nudge stays suppressed across the project until dream clears it.
    const triggers = evaluateNudgeTriggers(store);
    const state = store.getNudgeState();

    // Age FIRE — edge-triggered. Only Stop owns the age path.
    if (triggers.ageCrossed && state !== NUDGE_STATES.FIRED) {
      if (!isConsolidatorSession(store, sessionId)) {
        // Auto-spawn first; fall back to the manual nudge if spawn refuses
        // (seed mode) or fails.
        if (!trySpawnConsolidator(store, sessionId, triggers, { logTag: 'stop' })) {
          stagePendingNudge(store, sessionId, triggers, { logTag: 'stop' });
        }
      }
      // Always mark FIRED — anti-spam holds whether we spawned, nudged, or
      // skipped both as the consolidator. The next age-clear→cross re-arms.
      store.setNudgeState(NUDGE_STATES.FIRED);
      return;
    }

    // Reconcile — covers BOTH cap-triggered and age-triggered spawns. A
    // silently-dead consolidator (lease elapsed, no consolidations row, still
    // tripping) gets the manual nudge re-surfaced and the state re-armed so
    // the next crossing retries the spawn instead of leaving the user blind
    // behind a sticky FIRED. Bounded to ~one retry per lease window.
    if (
      state === NUDGE_STATES.FIRED
      && (triggers.capCrossed || triggers.ageCrossed)
      && !isConsolidatorSession(store, sessionId)
      && spawnedConsolidatorNeverCompleted(store, sessionId)
    ) {
      stagePendingNudge(store, sessionId, triggers, { logTag: 'stop' });
      store.setNudgeState(NUDGE_STATES.ARMED);
      return;
    }

    // Re-arm when BOTH conditions clear. Including capCrossed in the
    // condition is necessary even though Stop doesn't own cap-firing: a
    // prior cap-fire in promote-pending.js should stay FIRED until cap
    // clears too, and Stop shouldn't accidentally reset state that the cap
    // path still needs.
    if (state === NUDGE_STATES.FIRED && !triggers.capCrossed && !triggers.ageCrossed) {
      store.setNudgeState(NUDGE_STATES.ARMED);
    }
  } catch (e) {
    logHookError('stop', 'safety check failed', e);
  }
}

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
    logHookError('stop', 'store open failed', e);
    process.stdout.write('{}\n');
    return;
  }

  try {
    // 1) Tail flush.
    if (transcriptPath) {
      const flushed = flushTranscript({ store, sessionId, transcriptPath });
      if (flushed.error) {
        logHookError('stop', 'flush failed', flushed.error);
      }
    }

    // 2) Safety-net checks: age FIRE (Stop owns this) + cross-trigger
    //    reconcile for silently-dead consolidators (cap OR age).
    //    MINDWRIGHT_NUDGE=off skips the whole path. Cap FIRE lives in
    //    lib/promote-pending.js now.
    if (process.env.MINDWRIGHT_NUDGE !== 'off') {
      handleSafetyChecks(store, sessionId);
    }
  } finally {
    store.close();
  }

  process.stdout.write('{}\n');
}
