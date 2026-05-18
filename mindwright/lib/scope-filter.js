// Shared SQL fragment scoping role-tagged rows (`scope LIKE 'role:%'`) to a
// session's assigned roles — the mechanism behind the assign-role promise
// that role assignment governs which heuristics get injected at retrieval.
//
// Semantics:
//   - roles null/undefined → no filter (legacy callers without a session
//     context — consolidator supersede-check, tests).
//   - roles []             → exclude every role-tagged row; user-/project-
//     scoped rows pass.
//   - roles [a, b, ...]    → role-tagged rows must match one via
//     `scope IN (...)`; null-scope (short-term) / non-role-tagged rows pass.
//
// Returns `{ clause, params }`; empty string + zero params when no filter
// applies so callers concatenate without conditionals.

export function scopeFilterClause(roles, alias = 'e') {
  // Single check covers null/undefined and any non-array fallback.
  if (!Array.isArray(roles)) {
    return { clause: '', params: [] };
  }
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

// Tier predicate + role-scope filter as one `{ clause, params }`. Tier is
// emitted FIRST, then scope; params are tier-then-scope. The `e.` alias
// matches the join name the retriever queries use.
export function tierScopeClause(tier, roles) {
  const scope = scopeFilterClause(roles);
  const tierClause = tier ? ' AND e.tier = ?' : '';
  const tierParams = tier ? [tier] : [];
  return {
    clause: tierClause + scope.clause,
    params: [...tierParams, ...scope.params],
  };
}
