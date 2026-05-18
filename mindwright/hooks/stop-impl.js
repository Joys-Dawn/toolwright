#!/usr/bin/env node
// Stop hook. Two jobs: (1) flush final transcript content from offset → EOF
// (same chunker path as PreToolUse, no retrieval gate); (2) check the
// consolidation trigger and, since Stop has no user-visible context surface,
// stage a nudge for the next UserPromptSubmit to surface. On any error, exit
// with `{}` so the session isn't disrupted.

import { readFileSync } from 'node:fs';
import { openStore } from '../lib/store.js';
import { flushTranscript } from '../lib/transcript-flush.js';
import { evaluateNudgeTriggers, nudgeReason, suggestScopeAll } from '../lib/nudge.js';
import { logHookError } from '../lib/hook-log.js';
import { NUDGE_STATES, CONSOLIDATOR_COMPLETION_GRACE_MS } from '../lib/constants.js';
// isConsolidatorSession is the self-spawn guard: never spawn a consolidator
// from inside a consolidator session (co-located with the sentinel it reads).
import { spawnConsolidator, isConsolidatorSession } from '../lib/consolidator-spawn.js';
import { deriveHandle } from '../lib/handles.js';

// Auto-spawn the background consolidator. Returns true on successful spawn.
// While MINDWRIGHT_SEED_TRANSCRIPT=1, suspend auto-spawn and fall back to the
// manual nudge: seed re-ingest from byte 0 doubles row counts and trips
// capCrossed, so auto-spawning then would burn tokens deduplicating something
// the user already knows is duplicated. Let the user control when dream runs.
function trySpawnConsolidator(store, sessionId, triggers) {
  if (process.env.MINDWRIGHT_SEED_TRANSCRIPT === '1') return false;
  try {
    const requesterHandle = deriveHandle(sessionId);
    const r = spawnConsolidator({
      requesterHandle,
      reason: triggers.capCrossed ? 'cap_crossed' : 'age_crossed',
      store,
    });
    return !!(r && r.ok === true);
  } catch (e) {
    logHookError('stop', 'spawnConsolidator failed', e);
    return false;
  }
}

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

function stagePendingNudge(store, sessionId, triggers) {
  const reason = nudgeReason(triggers);
  const ownN = store.countShortTermFor(sessionId);
  const scopeHint = suggestScopeAll(ownN, triggers.n);
  const tail = scopeHint
    ? ` ${scopeHint}`
    : ' Run /mindwright:dream when convenient to consolidate.';
  store.setPendingNudge(sessionId, `mindwright: ${reason}.${tail}`);
}

// Cap check. Edge-trigger: fire the nudge the FIRST time short-term crosses
// CAP_EXCHANGES, then stay quiet until the count drops below cap and a later
// crossing re-arms it — without this gate the same nudge re-stages every turn.
// When the session IS a consolidator, skip BOTH the spawn and the staged nudge
// (the consolidator loop already runs dream; no user-facing surface) but still
// run the nudge_state transitions so the gate re-arms if it leaves that role.
function handleCapCheck(store, sessionId) {
  try {
    // Triggers AND nudge_state are both project-wide so quiet users with many
    // short sessions still get a nudge when total rows pile up, and a fired
    // nudge stays suppressed across the project until dream clears it.
    const triggers = evaluateNudgeTriggers(store);
    const state = store.getNudgeState();

    if (triggers.capCrossed || triggers.ageCrossed) {
      if (state !== NUDGE_STATES.FIRED) {
        if (!isConsolidatorSession(store, sessionId)) {
          // Auto-spawn first; fall back to the manual nudge if spawn refuses
          // (seed mode) or fails.
          if (!trySpawnConsolidator(store, sessionId, triggers)) {
            stagePendingNudge(store, sessionId, triggers);
          }
        }
        // Always mark FIRED — anti-spam holds whether we spawned, nudged, or
        // skipped both as the consolidator. The next cap-clear→cross re-arms.
        store.setNudgeState(NUDGE_STATES.FIRED);
      } else if (
        !isConsolidatorSession(store, sessionId)
        && spawnedConsolidatorNeverCompleted(store, sessionId)
      ) {
        // Auto-spawned consolidator died silently (lease elapsed, no
        // consolidations row, still over trigger). Re-surface the manual
        // nudge and re-arm so the next crossing retries instead of leaving
        // the user blind behind a sticky FIRED. Bounded to ~one retry per
        // lease window.
        stagePendingNudge(store, sessionId, triggers);
        store.setNudgeState(NUDGE_STATES.ARMED);
      }
    } else if (state === NUDGE_STATES.FIRED) {
      // Both conditions cleared — re-arm for the next trip.
      store.setNudgeState(NUDGE_STATES.ARMED);
    }
  } catch (e) {
    logHookError('stop', 'cap check failed', e);
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

    // 2) Cap check. MINDWRIGHT_NUDGE=off skips the whole staging path
    //    (no spawn, no nudge, no state-machine update).
    if (process.env.MINDWRIGHT_NUDGE !== 'off') {
      handleCapCheck(store, sessionId);
    }
  } finally {
    store.close();
  }

  process.stdout.write('{}\n');
}
