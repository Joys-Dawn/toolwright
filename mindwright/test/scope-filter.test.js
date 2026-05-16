// Focused unit tests for lib/scope-filter.js. The function is the single
// source of truth for the role-scoping retrieval invariant promised in
// DESIGN.md (role assignment governs which procedural heuristics get
// injected) and is exercised indirectly by retriever.test.js, but pinning
// the exact returned clause string and params makes refactors safer — a
// future change that subtly alters the SQL shape (e.g. swaps the alias,
// drops the NULL branch, or reorders the OR clauses) could pass the
// behavioral tests on the current fixture data while breaking edge cases.
//
// Taxonomy reminder: long-term rows carry `category` (procedural | episodic
// | fact) and `scope` (user | project | role:<role>). Role assignment
// filters on `scope LIKE 'role:%'` because that — not category — is the
// audience axis.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scopeFilterClause, tierScopeClause } from '../lib/scope-filter.js';

test('scopeFilterClause(undefined) → empty clause, empty params (legacy caller path)', () => {
  const out = scopeFilterClause(undefined);
  assert.deepEqual(out, { clause: '', params: [] });
});

test('scopeFilterClause(null) → empty clause, empty params', () => {
  const out = scopeFilterClause(null);
  assert.deepEqual(out, { clause: '', params: [] });
});

test('scopeFilterClause(non-array) → empty clause (Array.isArray gate)', () => {
  // Defensive shape: a misuse like scopeFilterClause('planner') (forgot the
  // brackets) must NOT produce a malformed SQL fragment with embedded
  // characters. The function's contract is "array or nothing" — anything
  // else degrades to legacy/no-filter.
  assert.deepEqual(scopeFilterClause('planner'), { clause: '', params: [] });
  assert.deepEqual(scopeFilterClause(42), { clause: '', params: [] });
  assert.deepEqual(scopeFilterClause({ planner: true }), { clause: '', params: [] });
});

test('scopeFilterClause([]) → excludes every role-scoped row, no params', () => {
  // The empty-roles branch is the strict one: a session with no role
  // assigned must see no role-tagged rows. Asserting the exact clause
  // structure pins behavior against an accidental rewrite that flips an
  // operator or drops the NULL branch (short-term rows would silently
  // disappear).
  const out = scopeFilterClause([]);
  assert.equal(out.params.length, 0);
  assert.ok(out.clause.startsWith(' AND ('),
    `clause must be concat-safe (begin with ' AND ('), got: ${out.clause}`);
  assert.match(out.clause, /e\.scope IS NULL/);
  assert.match(out.clause, /e\.scope NOT LIKE 'role:%'/);
});

test('scopeFilterClause([role]) → single placeholder, role:<role> echoed', () => {
  const out = scopeFilterClause(['planner']);
  assert.deepEqual(out.params, ['role:planner']);
  // The clause keeps the NULL + non-role passes (so fact/user and
  // fact/project rows still match) and adds the role allowlist as the
  // third disjunct.
  assert.match(out.clause, /e\.scope IS NULL/);
  assert.match(out.clause, /e\.scope NOT LIKE 'role:%'/);
  assert.match(out.clause, /e\.scope IN \(\?\)/);
});

test('scopeFilterClause([a, b, c]) → three comma-separated placeholders, role:<r> for each', () => {
  const out = scopeFilterClause(['planner', 'reviewer', 'tester']);
  assert.deepEqual(out.params, ['role:planner', 'role:reviewer', 'role:tester']);
  assert.match(out.clause, /e\.scope IN \(\?,\?,\?\)/,
    `expected exactly 3 placeholders in IN (...), got: ${out.clause}`);
});

test('scopeFilterClause respects custom alias (defaults to "e")', () => {
  // Retrieval code paths that join entries under a non-default alias would
  // produce broken SQL if the function hardcoded 'e.'. Pinning this contract
  // prevents a quiet regression where the alias parameter gets dropped.
  const out = scopeFilterClause(['planner'], 'x');
  // The alias 'x.' must appear, the default 'e.' must NOT.
  assert.match(out.clause, /x\.scope/);
  assert.equal(out.clause.includes('e.scope'), false,
    `default alias must not leak when a custom one is passed, got: ${out.clause}`);
});

test('scopeFilterClause empty-roles + custom alias combine correctly', () => {
  const out = scopeFilterClause([], 'm');
  assert.equal(out.params.length, 0);
  assert.match(out.clause, /m\.scope IS NULL/);
  assert.match(out.clause, /m\.scope NOT LIKE 'role:%'/);
  assert.equal(out.clause.includes('e.scope'), false);
});

// tierScopeClause (best-practices-3): the DRY extraction of the
// `tierClause + tierParams + scopeFilterClause` triplet that was copy-pasted
// across store.semanticSearch/bm25Search/temporalSearch and hand-rolled in
// retrievers.graphSearch. The refactor is only safe if the helper is
// BYTE-IDENTICAL to that inline triplet — same clause concatenation, same
// tier-FIRST-then-scope param order. These pin exactly that.

test('tierScopeClause(null, null) → no tier + no roles → empty clause/params', () => {
  assert.deepEqual(tierScopeClause(null, null), { clause: '', params: [] });
});

test('tierScopeClause(tier, null) → tier predicate first, [tier] param, no scope filter', () => {
  const out = tierScopeClause('short', null);
  assert.equal(out.clause, ' AND e.tier = ?');
  assert.deepEqual(out.params, ['short']);
});

test('tierScopeClause(null, []) → no tier predicate, scope filter only', () => {
  const out = tierScopeClause(null, []);
  // Identical to the bare scopeFilterClause([]) (no tier prefix prepended).
  assert.deepEqual(out, scopeFilterClause([]));
});

test('tierScopeClause(tier, [role]) binds tier param BEFORE scope params', () => {
  const out = tierScopeClause('long', ['planner']);
  // The clause is the tier predicate concatenated in front of the scope
  // filter — exactly `${tierClause}${scope.clause}` from the old call sites.
  assert.ok(out.clause.startsWith(' AND e.tier = ?'),
    `tier predicate must lead the clause, got: ${out.clause}`);
  assert.match(out.clause, /e\.scope IN \(\?\)/);
  // Bind order is the load-bearing invariant: every rewired call site binds
  // tierParams THEN scope.params. 'long' must precede 'role:planner'.
  assert.deepEqual(out.params, ['long', 'role:planner']);
});

test('tierScopeClause is byte-identical to the inline triplet it replaced (regression guard)', () => {
  // Reconstruct the exact pre-refactor triplet and assert equivalence across
  // every (tier × roles) shape the four call sites can pass. If a future edit
  // alters the concatenation or the param order this fails loudly, instead of
  // silently mis-binding a tier-filtered, role-scoped retrieval.
  const inline = (tier, roles) => {
    const scope = scopeFilterClause(roles);
    const tierClause = tier ? ' AND e.tier = ?' : '';
    const tierParams = tier ? [tier] : [];
    return { clause: tierClause + scope.clause, params: [...tierParams, ...scope.params] };
  };
  for (const tier of [null, 'short', 'long']) {
    for (const roles of [null, undefined, [], ['planner'], ['planner', 'reviewer']]) {
      assert.deepEqual(
        tierScopeClause(tier, roles),
        inline(tier, roles),
        `mismatch for tier=${tier} roles=${JSON.stringify(roles)}`,
      );
    }
  }
});
