// Shared SQL fragment that scopes role-tagged rows (procedural rows whose
// `scope LIKE 'role:%'`) to a session's assigned roles. DESIGN.md and the
// /mindwright:assign-role skill body promise that role assignment governs
// which heuristics get injected at retrieval — that promise lives here.
//
// Semantics (orthogonal-axes taxonomy):
//   - `roles === undefined`/`null` → produce no filter (legacy callers
//     without a session context — consolidator supersede-check, tests).
//   - `roles === []`               → exclude every row whose scope is
//     role-tagged (`scope LIKE 'role:%'`); user-/project-scoped rows pass.
//   - `roles === [a, b, ...]`      → role-tagged rows must match one of the
//     listed roles via `scope IN ('role:a', 'role:b', ...)`; rows whose
//     scope is null (short-term) or not role-tagged pass unconditionally.
//
// Returns `{ clause, params }`. The clause begins with " AND (...)" — when
// no filter applies, returns an empty string and zero params so callers can
// concatenate without conditionals. The alias `e.` matches the join name
// used by the retrievers in lib/store.js and lib/retrievers.js.

export function scopeFilterClause(roles, alias = 'e') {
  // Catches the legacy null/undefined path and any non-array fallback —
  // Array.isArray(null) and Array.isArray(undefined) are both false, so a
  // single check suffices.
  if (!Array.isArray(roles)) {
    return { clause: '', params: [] };
  }
  // The "row passes" predicate. The first branch keeps short-term rows
  // (scope IS NULL) and non-role-tagged long-tier rows unaffected by role
  // scoping. The second branch is the only one that touches role-scoped
  // rows: they must carry one of the active roles.
  if (roles.length === 0) {
    return {
      clause: ` AND (${alias}.scope IS NULL OR ${alias}.scope NOT LIKE 'role:%')`,
      params: [],
    };
  }
  const placeholders = roles.map(() => '?').join(',');
  const scoped = roles.map((r) => `role:${r}`);
  return {
    clause:
      ` AND (${alias}.scope IS NULL` +
      ` OR ${alias}.scope NOT LIKE 'role:%'` +
      ` OR ${alias}.scope IN (${placeholders}))`,
    params: scoped,
  };
}

// Tier predicate + role-scope filter as one `{ clause, params }`. This exact
// triplet —
//   const scope = scopeFilterClause(roles);
//   const tierClause = tier ? ' AND e.tier = ?' : '';
//   const tierParams = tier ? [tier] : [];
// — was copy-pasted verbatim across store.semanticSearch / bm25Search /
// temporalSearch and reimplemented by hand in retrievers.graphSearch
// (best-practices-3). The tier predicate is emitted FIRST, then the scope
// filter, and the params are tier-then-scope: byte-identical to what all four
// call sites concatenated and bound, so this is a pure DRY extraction with no
// behavior change. The `e.` alias matches the join name those queries use.
export function tierScopeClause(tier, roles) {
  const scope = scopeFilterClause(roles);
  const tierClause = tier ? ' AND e.tier = ?' : '';
  const tierParams = tier ? [tier] : [];
  return {
    clause: tierClause + scope.clause,
    params: [...tierParams, ...scope.params],
  };
}
