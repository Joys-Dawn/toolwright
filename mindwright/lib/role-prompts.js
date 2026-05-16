// Canonical role registry — the five built-in roles a mindwright-using
// agent can be assigned. Each role carries a short prompt fragment that
// SessionStart appends to the agent's context and that the PostToolUse-on-
// `wrightward_list_inbox` hook re-injects on diff.
//
// Keep each fragment small. The role-prompt is identity-shaping, not a
// procedure manual — the procedural detail comes from the agent's actual
// task body (the handoff) and from retrieved memories. A bloated fragment
// burns context every turn for marginal gain. ≤800 chars is the discipline
// (asserted in test/role-prompts.test.js).
//
// Roles are also the scoping key for procedural memory: a fact retained
// under `scope='role:planner'` is only surfaced when a session has the
// 'planner' role assigned. The role names here are the source of truth for
// what shapes get accepted by retrieval.

// The canonical role identifiers — mindwright's built-in scoping roles.
// Single source of truth: categorize.js's procedural-cue regexes are built
// dynamically from this list, ROLE_PROMPTS below carries one prompt fragment
// per entry, and the test suite asserts the keys stay in sync. Adding a new
// role means: append to this list, add its prompt fragment to ROLE_PROMPTS,
// and the categorize-cue regex picks it up automatically.
export const CANONICAL_ROLES = Object.freeze([
  'planner',
  'implementer',
  'reviewer',
  'consolidator',
  'tester',
]);

// Mapping each role identity to a short prompt fragment. Frozen so a
// downstream typo (`'PLANNER'`, `'planner '`) becomes a TypeError at
// read-time rather than silently injecting nothing.
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

// Stable alias map. `validator` is the plan-vocabulary synonym for `reviewer`.
// Any role name not in ROLE_PROMPTS that's resolved through this alias map
// gets the canonical name's fragment. Unknown roles still pass through with
// no fragment (silent passthrough — they still affect retrieval scope).
const ROLE_ALIASES = Object.freeze({
  validator: 'reviewer',
});

// Resolve a role name to its canonical fragment, applying the alias map.
// Returns null for unknown roles.
function fragmentFor(role) {
  if (typeof role !== 'string') return null;
  const canonical = ROLE_ALIASES[role] || role;
  return ROLE_PROMPTS[canonical] || null;
}

// Render fragments for a list of assigned roles. Joins with two newlines so
// the agent sees one role per "paragraph" rather than a wall of text.
// Unknown roles are silently skipped — the role is still in `meta:roles:`
// and still scopes procedural retrieval, but injects no extra system text.
export function getRolePromptsFor(roles) {
  if (!Array.isArray(roles) || roles.length === 0) return '';
  const parts = [];
  for (const role of roles) {
    const frag = fragmentFor(role);
    if (frag) parts.push(`[role:${role}] ${frag}`);
  }
  return parts.join('\n\n');
}

// Render one-line "role X has been unassigned" notes for the PostToolUse
// diff hook. We can't retract already-injected context, but we CAN tell the
// agent the role no longer applies so future decisions weight it differently.
export function getRoleUnassignNotices(roles) {
  if (!Array.isArray(roles) || roles.length === 0) return '';
  return roles
    .map((r) => `[role:${r}] role unassigned — its prior prompt fragment no longer applies.`)
    .join('\n');
}
