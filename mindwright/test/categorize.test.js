// Tests for the deterministic (category, scope) prediction heuristic.
// `categorize()` is the fallback that retainHandler in mcp/tools.mjs invokes
// when an explicit retain to long-term omits category/scope — the dream cycle
// itself never relies on it (the calling session must tag each fact).
//
// Each cue input is its own test so a single regex regression localizes to
// the exact phrase that broke rather than hiding behind a bundled assertion.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { categorize } from '../lib/categorize.js';

test('returns null on empty string', () => {
  assert.equal(categorize(''), null);
});
test('returns null on whitespace-only input', () => {
  assert.equal(categorize('   '), null);
});
test('returns null on null', () => {
  assert.equal(categorize(null), null);
});
test('returns null on undefined', () => {
  assert.equal(categorize(undefined), null);
});
test('returns null on non-string (number)', () => {
  assert.equal(categorize(123), null);
});

// First-person preference cues fire → fact / user.
const USER_PREF_CASES = [
  ['The user prefers tabs over spaces.', 'cue: "user prefers"'],
  ['I want all diffs reviewed before merge.', 'cue: "I want"'],
  ['Never commit on Fridays.', 'cue: imperative "Never"'],
  ['do not run tests against the prod DB.', 'cue: "do not"'],
];
for (const [text, why] of USER_PREF_CASES) {
  test(`fact/user (${why})`, () => {
    assert.deepEqual(categorize(text), { category: 'fact', scope: 'user' });
  });
}

// Procedural cues with a role-extractable verb / noun → procedural / role:<role>.
test('procedural / role:planner (cue: "When planning")', () => {
  assert.deepEqual(
    categorize('When planning a refactor, list affected modules first.'),
    { category: 'procedural', scope: 'role:planner' }
  );
});
test('procedural / role:consolidator (cue: "consolidator should")', () => {
  assert.deepEqual(
    categorize('The consolidator should drop transient state.'),
    { category: 'procedural', scope: 'role:consolidator' }
  );
});

test('explicit role tag without a procedural cue → procedural / role:<role>', () => {
  assert.deepEqual(
    categorize('Some neutral-looking text about a topic.', { role: 'consolidator' }),
    { category: 'procedural', scope: 'role:consolidator' }
  );
});

// Project-fact cues fire → fact / project.
const PROJECT_FACT_CASES = [
  ['The repository uses better-sqlite3 with sqlite-vec for retrieval.', 'cue: library name'],
  ['AuthService implements bcrypt with cost factor 12.', 'cue: class + algorithm'],
];
for (const [text, why] of PROJECT_FACT_CASES) {
  test(`fact/project (${why})`, () => {
    assert.deepEqual(categorize(text), { category: 'fact', scope: 'project' });
  });
}

// Episodic cues fire → episodic / project.
const EPISODIC_CASES = [
  ['I claimed the migration was idempotent without checking and was wrong.', 'cue: "claimed … without checking"'],
  ['Post-mortem: the 2026-04-12 outage was caused by a stale cache.', 'cue: post-mortem + ISO date'],
  ['Lessons learned: never trust the cached value blind.', 'cue: "Lessons learned"'],
];
for (const [text, why] of EPISODIC_CASES) {
  test(`episodic/project (${why})`, () => {
    assert.deepEqual(categorize(text), { category: 'episodic', scope: 'project' });
  });
}

test('no cues at all → null (caller picks a default)', () => {
  assert.equal(categorize('hello world'), null);
});

test('preference cues outrank procedural / fact-project when both fire', () => {
  assert.deepEqual(
    categorize('The user prefers when the consolidator drops transient state.'),
    { category: 'fact', scope: 'user' }
  );
});
