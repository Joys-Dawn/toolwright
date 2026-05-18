// Shared "is consolidation due?" evaluator. Stop stages a nudge when EITHER
// trigger crosses; UserPromptSubmit drops it when BOTH clear. One helper so
// the two call sites can't disagree on cap vs age.
//
// Triggers are PROJECT-WIDE, not per-session: a per-session cap would let
// rows pile up across many short sessions without ever crossing in one. The
// per-session edge state still scopes anti-spam re-fire.

import {
  CAP_EXCHANGES,
  SAFETY_NET_DAYS,
  SAFETY_NET_MIN_ROWS,
  MS_PER_DAY,
} from './constants.js';

const SAFETY_NET_MS = SAFETY_NET_DAYS * MS_PER_DAY;

// Returns { n, ageMs, capCrossed, ageCrossed }. `n` is the project-wide
// short-term row count; `ageMs` is how long ago the project-wide oldest
// short-term row was inserted (null when the project has none or the
// timestamp is unparseable). The two booleans are the cap and safety-net
// triggers.
//
// ageCrossed also gates on a minimum row count (SAFETY_NET_MIN_ROWS) so a
// quiet project with 1-2 stale rows doesn't get nudged every 3 days for
// content that's not worth consolidating. The cap trigger has no floor: a
// busy project that hits CAP_EXCHANGES always fires regardless.
export function evaluateNudgeTriggers(store, now = Date.now()) {
  const n = store.countShortTermAllSessions();
  const iso = store.oldestShortTermAcrossAllSessions();
  let ageMs = null;
  if (iso) {
    const t = Date.parse(iso);
    if (Number.isFinite(t)) ageMs = Math.max(0, now - t);
  }
  return {
    n,
    ageMs,
    capCrossed: n >= CAP_EXCHANGES,
    ageCrossed:
      typeof ageMs === 'number'
      && ageMs >= SAFETY_NET_MS
      && n >= SAFETY_NET_MIN_ROWS,
  };
}

// Human-readable reason for the staged nudge. The cap path wins when both
// fire so the user sees the most actionable trigger ("you have N rows" >
// "you have stale content").
export function nudgeReason({ n, ageMs, capCrossed, ageCrossed }) {
  if (capCrossed) {
    return `short-term cap reached (${n} ≥ ${CAP_EXCHANGES} rows project-wide)`;
  }
  if (ageCrossed) {
    const days = Math.floor(ageMs / MS_PER_DAY);
    return `oldest short-term content is ${days} day(s) old (≥ ${SAFETY_NET_DAYS}-day safety net)`;
  }
  return null;
}

// Hint appended to the nudge body when the calling session's own short-term
// is a small fraction of the project-wide count. Default `/mindwright:dream`
// is scope='session', which would only drain the caller's rows and leave
// every other session's pile stranded. Suggesting scope='all' here makes
// the dream cycle actually clear what the nudge is about.
export function suggestScopeAll(ownCount, projectCount) {
  if (typeof ownCount !== 'number' || typeof projectCount !== 'number') return null;
  if (projectCount === 0) return null;
  // If the caller owns ALL the project-wide rows, scope='session' is fine.
  if (ownCount >= projectCount) return null;
  // Mixed-session case: a fraction of the project's rows live elsewhere.
  // The user almost certainly wants scope='all' (with confirm_all_sessions=
  // true on finalize_drain) to drain the whole pile.
  return (
    `Your session owns ${ownCount} of ${projectCount} short-term row(s) — ` +
    `pass scope='all' to /mindwright:dream (and confirm_all_sessions=true on ` +
    `finalize_drain) to clear the rest.`
  );
}
