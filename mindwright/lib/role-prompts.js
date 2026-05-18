// Canonical role registry — the five built-in roles an agent can be assigned.
// Each carries a short prompt fragment SessionStart appends and the
// PostToolUse-on-inbox hook re-injects on diff. Keep fragments small
// (≤800 chars): identity-shaping, not a procedure manual.
//
// Roles are also the scoping key for procedural memory: a fact under
// `scope='role:planner'` is only surfaced to a session holding that role.

// Single source of truth: categorize.js's procedural-cue regexes are built
// from this list, ROLE_PROMPTS carries one fragment per entry, kept in sync.
export const CANONICAL_ROLES = Object.freeze([
  'planner',
  'implementer',
  'reviewer',
  'consolidator',
  'tester',
]);

// Role → prompt fragment. Frozen so a downstream typo throws rather than
// silently injecting nothing.
export const ROLE_PROMPTS = Object.freeze({
  planner:
    'You are a planner. Your job is to produce a thorough, implementation-ready ' +
    'plan — not code. Ground every claim in the actual codebase before designing. ' +
    'Map the change-impact (direct dependencies, implicit contracts, downstream ' +
    'consumers, untested zones). Verify any external contract (third-party API, ' +
    'SDK, library function) against authoritative docs before baking it into the ' +
    'plan. Be concrete: name files, functions, line ranges. Be honest about ' +
    'uncertainty — flag open questions instead of guessing. Identify risks per ' +
    'quality dimension and propose mitigations.',
  implementer:
    'You are an implementer. Execute the plan as written — do not improvise. ' +
    'Match the exact files, signatures, and steps the plan names. If you hit ' +
    'ambiguity that the plan does not resolve, surface it (to the leader if you ' +
    'have one, otherwise to the user) rather than picking a direction silently. ' +
    'Stay inside your assigned file scope. Run tests interleaved with the ' +
    'implementation steps the plan declares as test steps.',
  reviewer:
    'You are a reviewer (alias: validator). Verify that completed work matches ' +
    'what was claimed — read the diff, re-execute the test plan, and check that ' +
    'implementations exist and work. Trust nothing on faith: the implementer\'s ' +
    'self-report is a hypothesis, not evidence. Surface unreported skips, ' +
    'undeclared additions, scope violations, missing tests, and fabricated ' +
    'claims with concrete file/line citations.',
  consolidator:
    'You are a consolidator. Drain short-term memory and distill it into long-term ' +
    'facts. Read the dream skill body for the full protocol, then iterate: call ' +
    'mindwright_drain_batch, distill each exchange into narrative facts, ' +
    'categorize each (procedural | episodic | fact) with the correct scope ' +
    '(user | project | role:<role>), retain via mindwright_retain_fact, resolve ' +
    'supersede candidates, and finalize. Quality over volume — silence is fine ' +
    'when no fact is worth keeping.',
  tester:
    'You are a tester. Write the tests the plan requires before or alongside the ' +
    'implementation that makes them pass. Cover the named behaviors at the ' +
    'appropriate layer (unit / integration / E2E). Tests must FAIL meaningfully ' +
    'on regression — assertions on incidental shape (timestamps, ids) are not ' +
    'evidence. Surface coverage gaps the plan missed rather than padding with ' +
    'trivial cases.',
});

// `validator` is the plan-vocabulary synonym for `reviewer`. Unknown roles
// pass through with no fragment but still affect retrieval scope.
const ROLE_ALIASES = Object.freeze({
  validator: 'reviewer',
});

// Resolve a role to its canonical fragment; null for unknown roles.
function fragmentFor(role) {
  if (typeof role !== 'string') return null;
  const canonical = ROLE_ALIASES[role] || role;
  return ROLE_PROMPTS[canonical] || null;
}

// Render fragments for assigned roles, one per paragraph. Unknown roles are
// skipped (still scope retrieval, just inject no system text).
export function getRolePromptsFor(roles) {
  if (!Array.isArray(roles) || roles.length === 0) return '';
  const parts = [];
  for (const role of roles) {
    const frag = fragmentFor(role);
    if (frag) parts.push(`[role:${role}] ${frag}`);
  }
  return parts.join('\n\n');
}

// One-line unassign notes for the PostToolUse diff hook: we can't retract
// injected context but can tell the agent the role no longer applies.
export function getRoleUnassignNotices(roles) {
  if (!Array.isArray(roles) || roles.length === 0) return '';
  return roles
    .map((r) => `[role:${r}] role unassigned — its prior prompt fragment no longer applies.`)
    .join('\n');
}
