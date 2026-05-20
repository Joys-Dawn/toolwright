// Shared spawn/nudge fallback semantics for both trigger paths.
//
// stop-impl.js owns the age trigger and promote-pending.js owns the cap
// trigger, but both need exactly the same downstream policy when a trigger
// crosses with state==ARMED:
//   1. If MINDWRIGHT_SEED_TRANSCRIPT=1 — suspend auto-spawn (seed re-ingest
//      doubles row counts; auto-consolidating would burn tokens on content
//      the user hasn't reviewed). Fall through to the manual nudge.
//   2. Otherwise call spawnConsolidator. On success the user sees nothing
//      (the bg session does the work).
//   3. On spawn refusal / failure stage the manual "time to dream" nudge,
//      keyed to the firing session so its next UserPromptSubmit surfaces it.
//
// Without a shared module these two callers had drifted on the reason-tag
// string, the error logger tag, and the try/catch granularity. Extracting
// them ensures the seed-mode guard, the `cap_crossed | age_crossed` mapping,
// and the nudge body format live in exactly one place — the goal the
// "shared handler" comment in promote-pending.js spelled out but couldn't
// achieve while age and cap still lived in different hooks.

import { spawnConsolidator } from './consolidator-spawn.js';
import { deriveHandle } from './handles.js';
import { nudgeReason, suggestScopeAll } from './nudge.js';
import { logHookError } from './hook-log.js';

// Best-effort spawn. Returns true iff spawnConsolidator confirmed the OS
// accepted the detached child. Returns false on:
//   - seed-mode suspend (env var set)
//   - spawn refusal (no `claude` on PATH, MINDWRIGHT_SPAWN_DISABLE=1, …)
//   - any thrown error (logged, swallowed — never lets the hook crash)
// `triggers` here is the evaluateNudgeTriggers() output; the cap flag
// chooses the spawn reason tag so the consolidator's logs identify what
// kicked it off.
export function trySpawnConsolidator(store, sessionId, triggers, { logTag = 'spawn-or-nudge' } = {}) {
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
    logHookError(logTag, 'spawnConsolidator failed', e);
    return false;
  }
}

// Stage the fallback "time to dream" nudge for the firing session. The
// scope-hint (when included) tells the user that the firing session owns
// only a fraction of project-wide short-term rows — without it they'd run
// a session-scoped dream that strands every peer's rows. Throws are
// logged + swallowed so a setPendingNudge failure never crashes the hook.
export function stagePendingNudge(store, sessionId, triggers, { logTag = 'spawn-or-nudge' } = {}) {
  try {
    const reason = nudgeReason(triggers);
    const ownN = store.countShortTermFor(sessionId);
    const scopeHint = suggestScopeAll(ownN, triggers.n);
    const tail = scopeHint
      ? ` ${scopeHint}`
      : ' Run /mindwright:dream when convenient to consolidate.';
    store.setPendingNudge(sessionId, `mindwright: ${reason}.${tail}`);
    return true;
  } catch (e) {
    logHookError(logTag, 'stagePendingNudge failed', e);
    return false;
  }
}
