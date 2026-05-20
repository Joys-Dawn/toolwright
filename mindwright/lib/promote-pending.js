// Shared "promote pending → real short-term + run cap-side spawn" handler.
//
// PreCompact, SessionEnd, and SessionStart-orphan-sweep ALL share this exact
// flow: flip pending_session_id to NULL for some session's rows, then check
// whether the now-real short-term count crossed CAP_EXCHANGES and (if so)
// spawn the consolidator OR stage the manual nudge. Without a shared helper
// the three hook sites would drift on the cap/state-machine semantics.
//
// `sessionId` here is the OWNER of the pending rows being promoted, NOT
// necessarily the calling session. SessionStart's orphan sweep calls this on
// behalf of a DIFFERENT (crashed) session: the rows belonged to session X,
// session X never flushed, session Y starts up and consolidates the orphans.
// In that case `callerSessionId` (the live caller) is what spawnConsolidator
// uses for its requester_handle.
//
// On any failure: log via the provided `tag` and return — never throw, never
// block the calling hook. A flush-handler failure must not crash the session.

import { evaluateNudgeTriggers } from './nudge.js';
import { isConsolidatorSession } from './consolidator-spawn.js';
import { NUDGE_STATES } from './constants.js';
import { logHookError } from './hook-log.js';
// Spawn + nudge fallback semantics shared with hooks/stop-impl.js — both the
// cap trigger (here) and the age trigger (there) use the same seed-mode
// guard, reason mapping, and nudge body format.
import { trySpawnConsolidator, stagePendingNudge } from './spawn-or-nudge.js';

// Returns { promoted, capCrossed, ageCrossed, spawned, nudged }. `promoted`
// is the row count moved from pending → real. Booleans communicate which
// downstream paths fired so tests can pin exact wiring.
//
// `maxCreatedAt` (optional ISO string) bounds the promotion to rows older
// than the cutoff — required for the orphan-sweep caller, where the owner
// session may resurrect between the orphan SELECT and this UPDATE. Omitted
// by PreCompact/SessionEnd because they operate on their own session.
export function promoteAndMaybeSpawn({
  store,
  ownerSessionId,
  callerSessionId,
  tag,
  maxCreatedAt = null,
} = {}) {
  const out = {
    promoted: 0,
    capCrossed: false,
    ageCrossed: false,
    spawned: false,
    nudged: false,
  };
  if (typeof ownerSessionId !== 'string' || !ownerSessionId) return out;
  const caller = (typeof callerSessionId === 'string' && callerSessionId)
    ? callerSessionId
    : ownerSessionId;
  const logTag = typeof tag === 'string' && tag ? tag : 'promote-pending';

  try {
    out.promoted = store.promotePendingForSession(ownerSessionId, { maxCreatedAt });
  } catch (e) {
    logHookError(logTag, 'promotePendingForSession failed', e);
    return out;
  }

  // No rows moved → no count change → no cap re-eval needed. Cheap exit so
  // PreCompact/SessionEnd on a session with nothing pending doesn't pay for
  // an evaluateNudgeTriggers + isConsolidatorSession + spawn pass.
  if (out.promoted === 0) return out;

  // MINDWRIGHT_NUDGE=off mirrors stop-impl.js's escape hatch: the user has
  // opted out of every nudge/spawn surface, so flush still happens but no
  // downstream action follows.
  if (process.env.MINDWRIGHT_NUDGE === 'off') return out;

  let triggers;
  try {
    triggers = evaluateNudgeTriggers(store);
  } catch (e) {
    logHookError(logTag, 'evaluateNudgeTriggers failed', e);
    return out;
  }
  out.capCrossed = !!triggers.capCrossed;
  out.ageCrossed = !!triggers.ageCrossed;

  if (!(triggers.capCrossed || triggers.ageCrossed)) {
    // Promoted some rows, but project-wide we're still under cap and not
    // safety-net-stale. Mirror stop-impl.js's "re-arm when conditions clear"
    // edge: if a prior trip left state in FIRED but we now see it cleared,
    // reset to ARMED so the next crossing can re-trigger.
    try {
      const state = store.getNudgeState();
      if (state === NUDGE_STATES.FIRED) store.setNudgeState(NUDGE_STATES.ARMED);
    } catch (e) {
      logHookError(logTag, 'nudge re-arm failed', e);
    }
    return out;
  }

  // We crossed (cap or age). Mirror stop-impl.js's FIRED-state guard:
  // edge-trigger the spawn/nudge exactly once per crossing.
  let state = NUDGE_STATES.ARMED;
  try { state = store.getNudgeState() || NUDGE_STATES.ARMED; } catch (e) {
    logHookError(logTag, 'getNudgeState failed', e);
  }
  if (state === NUDGE_STATES.FIRED) return out;

  // The caller must own the spawn (its handle, its requester_handle); the
  // owner of the rows may be a crashed session that can't supervise its own
  // consolidator. isConsolidatorSession checks the CALLER, not the owner —
  // we don't want a consolidator session re-spawning itself. The shared
  // spawn-or-nudge helper owns the seed-mode guard, the cap_crossed/age_crossed
  // reason mapping, and the manual-nudge body format — those used to live in
  // both this file and stop-impl.js (and drift was real: see the original
  // "mirrors stop-impl.js" comment that motivated the extraction).
  if (!isConsolidatorSession(store, caller)) {
    out.spawned = trySpawnConsolidator(store, caller, triggers, { logTag });
    if (!out.spawned) {
      out.nudged = stagePendingNudge(store, caller, triggers, { logTag });
    }
  }

  // Always mark FIRED — anti-spam holds whether we spawned, nudged, or
  // skipped both as the consolidator session. The next cap-clear→cross
  // re-arms (in the !triggers branch above).
  try { store.setNudgeState(NUDGE_STATES.FIRED); } catch (e) {
    logHookError(logTag, 'setNudgeState failed', e);
  }

  return out;
}
