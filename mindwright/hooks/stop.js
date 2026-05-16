#!/usr/bin/env node
// Stop hook. Two jobs (DESIGN.md "Trigger sources"):
//   1) Flush any final transcript content from offset → EOF — picks up the
//      final assistant text + tail thinking that landed after the last
//      tool call. Same chunker/write code path as PreToolUse, just no
//      retrieval gate.
//   2) Check the consolidation trigger: if short-term row count for this
//      session has crossed `CAP_EXCHANGES`, stage a nudge message in the
//      `meta` table for the next UserPromptSubmit hook to surface.
//      Claude Code only honors `hookSpecificOutput.additionalContext` from
//      UserPromptSubmit / SessionStart / PreToolUse (DESIGN.md:379) — Stop
//      doesn't have a user-visible context surface, so we hand the nudge
//      off to a hook that does.
//
// On any error, exit with `{}` so the session isn't disrupted.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { openStore } from '../lib/store.js';
import { flushTranscript } from '../lib/transcript-flush.js';
import { evaluateNudgeTriggers, nudgeReason, suggestScopeAll } from '../lib/nudge.js';
import { logHookError } from '../lib/hook-log.js';
import { NUDGE_STATES, CONSOLIDATOR_COMPLETION_GRACE_MS } from '../lib/constants.js';
import { spawnConsolidator } from '../lib/consolidator-spawn.js';
import { deriveHandle } from '../lib/handles.js';
// isConsolidatorSession lives in lib/seed-trigger.js — the same self-spawn
// guard the SessionStart-hosted auto-seed gate uses. handleCapCheck below
// consumes it here so the guard has a single definition (behavior-1 moved the
// auto-seed trigger out of this hook; see lib/seed-trigger.js header).
import { isConsolidatorSession } from '../lib/seed-trigger.js';

// Auto-spawn the background consolidator. Returns true on successful spawn.
// MINDWRIGHT_SEED_TRANSCRIPT=1 is the user's explicit opt-in to backfill
// transcript content into short-term. On already-tracked sessions this
// re-ingests from byte 0, which doubles row counts and is the most reliable
// way to trip capCrossed. Auto-spawning at that moment would burn subscription
// tokens deduplicating something the user already knows is duplicated (and
// hadn't yet inspected). While the env is set, suspend auto-spawn and fall
// back to the manual nudge so the user controls when /mindwright:dream runs.
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

// Reconciliation read for the auto-spawned consolidator. trySpawnConsolidator
// only confirms the OS accepted the detached `claude --bg` spawn — NOT that
// `/mindwright:dream` actually ran to completion. A completed dream's mandatory
// close is mindwright_finalize_drain, which writes a timestamped
// `consolidations` row (store.recordConsolidation). That row is the durable
// "done" acknowledgment a later Stop can reconcile against.
//
// Returns true when ALL hold: we DID auto-spawn a consolidator on a prior trip
// (meta:consolidator_for.last_spawn is set), the completion lease has elapsed
// since that spawn, and NO consolidations row landed with fired_at >=
// last_spawn. That combination means the background consolidator died silently
// (auth failure, rate limit, dream-skill regression, crashed `claude --bg`
// supervisor) and the sticky FIRED state is now hiding an unconsolidated
// overflow from the user. The caller re-surfaces the manual nudge and re-arms.
//
// Returns false (stay quiet) when: we never auto-spawned (spawn skipped/refused
// — the fallback nudge already ran, so the user has a visible path); still
// within the lease (the dream may legitimately still be running — nagging now
// would be the hostile re-nudge the edge-trigger was built to prevent); or a
// consolidation completed at/after our spawn (the dream stuck — not the
// silent-death case behavior-5 targets; any remaining overflow is a fresh
// accumulation the normal re-arm→re-spawn path handles). Any error is logged
// and swallowed — reconciliation must never break the Stop hook.
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
// CAP_EXCHANGES, then stay quiet until the count drops below cap (because
// /mindwright:dream ran) and a later cap crossing re-arms it. Without this
// gate the same nudge gets re-staged every turn forever, spamming
// `additionalContext` until the user capitulates and runs dream.
//
// Stop can't surface additionalContext itself — Claude Code only honors it on
// UserPromptSubmit / SessionStart / PreToolUse — so we stage a pending message
// that the next UserPromptSubmit drains.
//
// When the session IS a consolidator we skip BOTH the spawn and the staged
// nudge. Staging a nudge for ourselves is pointless — the consolidator's main
// loop IS running /mindwright:dream; there's no user-facing UserPromptSubmit
// to surface the nudge. The nudge_state transitions still run so the gate
// re-arms correctly if this session ever exits its consolidator role.
function handleCapCheck(store, sessionId) {
  try {
    // Triggers AND nudge_state are both project-wide. Quiet users with many
    // short sessions still get a nudge when total rows pile up; once that
    // nudge has fired the FIRED state suppresses further re-fires across the
    // whole project (including new sessions opening on the same un-drained
    // state) until /mindwright:dream clears both triggers and re-arms it.
    // The sessionId arg to get/setNudgeState is retained as a signature stub
    // — see lib/store.js#getNudgeState for the rationale.
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
        // Always mark FIRED — anti-spam holds whether we spawned, fell back to
        // a nudge, or skipped both because we ARE the consolidator. The next
        // cap-clear → cap-cross cycle re-arms below.
        store.setNudgeState(NUDGE_STATES.FIRED);
      } else if (
        !isConsolidatorSession(store, sessionId)
        && spawnedConsolidatorNeverCompleted(store, sessionId)
      ) {
        // We auto-spawned a background consolidator on a prior trip and went
        // quiet (FIRED), but the completion lease elapsed with no
        // consolidations row and short-term is STILL over the trigger — the
        // detached `claude --bg` consolidator died silently. Re-surface the
        // manual nudge and re-arm so the next crossing retries the spawn
        // instead of leaving the user blind behind a sticky FIRED forever.
        // (Bounded: ~one retry per lease window, each failure now visible via
        // the staged nudge — not per-turn spam.)
        stagePendingNudge(store, sessionId, triggers);
        store.setNudgeState(NUDGE_STATES.ARMED);
      }
    } else if (state === NUDGE_STATES.FIRED) {
      // Both conditions cleared (dream drained rows AND the rows that tripped
      // the safety-net got distilled away) — re-arm for the next trip.
      store.setNudgeState(NUDGE_STATES.ARMED);
    }
  } catch (e) {
    logHookError('stop', 'cap check failed', e);
  }
}

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

    // 2) Cap check. Users who never want to see the nudge can set
    //    MINDWRIGHT_NUDGE=off in their environment — Stop skips the whole
    //    staging path then (no spawn, no nudge, no state-machine update).
    if (process.env.MINDWRIGHT_NUDGE !== 'off') {
      handleCapCheck(store, sessionId);
    }

    // 3) Auto-seed bootstrap is NOT here. It is hosted by SessionStart
    //    (lib/seed-trigger.js#maybeAutoSeed, called from
    //    hooks/session-start.js#main). Its empty-memory precondition is only
    //    observable before the turn's first flush; by the first Stop,
    //    flushTranscript (step 1) plus the earlier UserPromptSubmit/PreToolUse
    //    flushes have already written short rows, so a Stop-hosted gate could
    //    never fire on the documented fresh-install flow (behavior-1).
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
    logHookError('stop', 'crashed', err);
    process.stdout.write('{}\n');
  });
}
