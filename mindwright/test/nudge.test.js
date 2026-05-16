// Direct unit tests for lib/nudge.js. The Stop hook + UserPromptSubmit hook
// pair only exercise the common case via hooks.test.js; the null-guard
// branches (unparseable timestamp, zero-trigger, non-number arg sums) need
// isolation so a regression in evaluateNudgeTriggers/nudgeReason/
// suggestScopeAll doesn't leak undefined into the nudge body.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateNudgeTriggers,
  nudgeReason,
  suggestScopeAll,
} from '../lib/nudge.js';
import { CAP_EXCHANGES, SAFETY_NET_DAYS, SAFETY_NET_MIN_ROWS } from '../lib/constants.js';

const SAFETY_NET_MS = SAFETY_NET_DAYS * 24 * 60 * 60 * 1000;

// Minimal fake store covering only the two methods evaluateNudgeTriggers
// reads — keeps test surface narrow.
function fakeStore({ n, iso }) {
  return {
    countShortTermAllSessions: () => n,
    oldestShortTermAcrossAllSessions: () => iso,
  };
}

test('evaluateNudgeTriggers — iso=null leaves ageMs=null and ageCrossed=false', () => {
  const t = evaluateNudgeTriggers(fakeStore({ n: 0, iso: null }), Date.now());
  assert.equal(t.n, 0);
  assert.equal(t.ageMs, null);
  assert.equal(t.ageCrossed, false);
  assert.equal(t.capCrossed, false);
});

test('evaluateNudgeTriggers — iso="garbage" produces NaN Date.parse and keeps ageMs=null', () => {
  // Date.parse('garbage') returns NaN; Number.isFinite(NaN)===false so the
  // guard preserves ageMs=null instead of leaking NaN through ageCrossed.
  const t = evaluateNudgeTriggers(
    fakeStore({ n: 3, iso: 'this is not an iso date' }),
    Date.now(),
  );
  assert.equal(t.ageMs, null);
  assert.equal(t.ageCrossed, false);
  assert.equal(t.n, 3);
});

test('evaluateNudgeTriggers — iso valid + older than safety net → ageCrossed=true', () => {
  const now = Date.now();
  const oldIso = new Date(now - SAFETY_NET_MS - 1000).toISOString();
  const t = evaluateNudgeTriggers(fakeStore({ n: 5, iso: oldIso }), now);
  assert.ok(t.ageMs !== null && t.ageMs > SAFETY_NET_MS);
  assert.equal(t.ageCrossed, true);
});

test('evaluateNudgeTriggers — iso valid + within safety net → ageCrossed=false', () => {
  const now = Date.now();
  // 1 minute ago, well inside the 3-day window.
  const recentIso = new Date(now - 60 * 1000).toISOString();
  const t = evaluateNudgeTriggers(fakeStore({ n: 5, iso: recentIso }), now);
  assert.ok(t.ageMs !== null && t.ageMs < SAFETY_NET_MS);
  assert.equal(t.ageCrossed, false);
});

test('evaluateNudgeTriggers — stale row but n < SAFETY_NET_MIN_ROWS keeps ageCrossed=false (quiet-project nudge suppression)', () => {
  // Behavior regression: a quiet project (1-2 rows over weeks) would get
  // re-nudged every ~3 days even when there's nothing worth consolidating.
  // The min-rows floor suppresses the age trigger below the threshold so
  // safety-net only fires when there's actually a meaningful pile to drain.
  const now = Date.now();
  const oldIso = new Date(now - SAFETY_NET_MS - 1000).toISOString();
  const t = evaluateNudgeTriggers(
    fakeStore({ n: SAFETY_NET_MIN_ROWS - 1, iso: oldIso }),
    now,
  );
  assert.ok(t.ageMs !== null && t.ageMs > SAFETY_NET_MS,
    'precondition: row IS past the age window');
  assert.equal(t.ageCrossed, false,
    `quiet project (n=${SAFETY_NET_MIN_ROWS - 1}) must not trip ageCrossed`);
});

test('evaluateNudgeTriggers — stale row at exactly SAFETY_NET_MIN_ROWS rows fires ageCrossed (boundary)', () => {
  const now = Date.now();
  const oldIso = new Date(now - SAFETY_NET_MS - 1000).toISOString();
  const t = evaluateNudgeTriggers(
    fakeStore({ n: SAFETY_NET_MIN_ROWS, iso: oldIso }),
    now,
  );
  assert.equal(t.ageCrossed, true,
    'at-threshold row count must still fire when content is past the safety-net age');
});

test('evaluateNudgeTriggers — n at cap exactly → capCrossed=true', () => {
  const t = evaluateNudgeTriggers(fakeStore({ n: CAP_EXCHANGES, iso: null }));
  assert.equal(t.capCrossed, true);
});

test('evaluateNudgeTriggers — n one below cap → capCrossed=false', () => {
  const t = evaluateNudgeTriggers(fakeStore({ n: CAP_EXCHANGES - 1, iso: null }));
  assert.equal(t.capCrossed, false);
});

test('nudgeReason — cap wins when both fire', () => {
  const reason = nudgeReason({
    n: CAP_EXCHANGES + 10,
    ageMs: SAFETY_NET_MS + 1000,
    capCrossed: true,
    ageCrossed: true,
  });
  assert.match(reason, /short-term cap reached/);
  assert.ok(reason.includes(String(CAP_EXCHANGES)));
});

test('nudgeReason — age-only path emits the days hint', () => {
  const ageMs = (SAFETY_NET_DAYS + 2) * 24 * 60 * 60 * 1000;
  const reason = nudgeReason({
    n: 5,
    ageMs,
    capCrossed: false,
    ageCrossed: true,
  });
  assert.match(reason, /day\(s\) old/);
  assert.match(reason, new RegExp(`${SAFETY_NET_DAYS}-day safety net`));
});

test('nudgeReason — neither trigger fired returns null', () => {
  // Important null-guard: callers use the return to decide whether to stage
  // a nudge. A regression that returns "" or undefined would silently push
  // an empty-body nudge into the user's next-turn additionalContext.
  const reason = nudgeReason({
    n: 1, ageMs: 0, capCrossed: false, ageCrossed: false,
  });
  assert.equal(reason, null);
});

test('suggestScopeAll — non-number args return null', () => {
  assert.equal(suggestScopeAll(undefined, 10), null);
  assert.equal(suggestScopeAll(5, undefined), null);
  assert.equal(suggestScopeAll(null, 10), null);
  assert.equal(suggestScopeAll('5', 10), null);
  assert.equal(suggestScopeAll(5, '10'), null);
});

test('suggestScopeAll — projectCount=0 returns null', () => {
  assert.equal(suggestScopeAll(0, 0), null);
  assert.equal(suggestScopeAll(5, 0), null); // weird, but no panic
});

test('suggestScopeAll — ownCount >= projectCount returns null (caller already owns the pile)', () => {
  assert.equal(suggestScopeAll(10, 10), null);
  assert.equal(suggestScopeAll(15, 10), null);
});

test('suggestScopeAll — mixed-session emits scope=all hint citing own/project counts', () => {
  const hint = suggestScopeAll(3, 50);
  assert.ok(hint !== null, 'mixed session must surface a hint');
  assert.match(hint, /Your session owns 3 of 50/);
  assert.match(hint, /scope='all'/);
  assert.match(hint, /confirm_all_sessions=true/);
});
