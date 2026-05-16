import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CANONICAL_ROLES,
  ROLE_PROMPTS,
  getRolePromptsFor,
  getRoleUnassignNotices,
} from '../lib/role-prompts.js';

test('CANONICAL_ROLES and ROLE_PROMPTS keys stay in sync', () => {
  // Sync invariant: adding a role to one without the other silently injects
  // nothing (or rejects retrieval) at runtime. categorize.js builds its
  // regexes from CANONICAL_ROLES; if a role lacks a ROLE_PROMPTS entry, the
  // categorize regex would match it but the prompt-fragment fan-out is empty.
  const promptKeys = new Set(Object.keys(ROLE_PROMPTS));
  for (const role of CANONICAL_ROLES) {
    assert.ok(promptKeys.has(role),
      `CANONICAL_ROLES contains '${role}' but ROLE_PROMPTS has no fragment`);
  }
  for (const key of promptKeys) {
    assert.ok(CANONICAL_ROLES.includes(key),
      `ROLE_PROMPTS has fragment for '${key}' but CANONICAL_ROLES omits it`);
  }
});

test('CANONICAL_ROLES is frozen so a stray push() can not violate the invariant', () => {
  assert.equal(Object.isFrozen(CANONICAL_ROLES), true);
});

test('ROLE_PROMPTS is frozen so a typo like ROLE_PROMPTS.PLANNER = ... can not silently misroute', () => {
  assert.equal(Object.isFrozen(ROLE_PROMPTS), true);
});

test('every role prompt fragment is ≤800 chars (the discipline the file claims)', () => {
  for (const [role, fragment] of Object.entries(ROLE_PROMPTS)) {
    assert.ok(fragment.length <= 800,
      `ROLE_PROMPTS.${role} is ${fragment.length} chars — exceeds 800-char discipline`);
  }
});

test('getRolePromptsFor joins multiple roles with double-newline and prefixes each with [role:<name>]', () => {
  const out = getRolePromptsFor(['planner', 'tester']);
  // Two fragments → joined by \n\n
  const parts = out.split('\n\n');
  assert.equal(parts.length, 2, 'expected exactly two paragraphs');
  assert.ok(parts[0].startsWith('[role:planner] '),
    `first paragraph must start with [role:planner], got: ${parts[0].slice(0, 30)}`);
  assert.ok(parts[1].startsWith('[role:tester] '),
    `second paragraph must start with [role:tester], got: ${parts[1].slice(0, 30)}`);
  // The actual fragment content follows the prefix
  assert.ok(parts[0].includes(ROLE_PROMPTS.planner),
    'planner paragraph must contain the planner fragment');
  assert.ok(parts[1].includes(ROLE_PROMPTS.tester),
    'tester paragraph must contain the tester fragment');
});

test('getRolePromptsFor resolves "validator" alias to the reviewer fragment', () => {
  const out = getRolePromptsFor(['validator']);
  assert.ok(out.startsWith('[role:validator] '),
    'prefix preserves original role name, not canonical');
  assert.ok(out.includes(ROLE_PROMPTS.reviewer),
    'fragment body must be the reviewer fragment (alias resolution)');
});

test('getRolePromptsFor returns "" for an unknown role (silent passthrough)', () => {
  // Per the file: "Unknown roles are silently skipped — the role is still in
  // meta:roles: and still scopes procedural retrieval, but injects no extra
  // system text."
  assert.equal(getRolePromptsFor(['frobnicator']), '');
});

test('getRolePromptsFor skips unknown roles in a mixed list but keeps the known ones', () => {
  const out = getRolePromptsFor(['frobnicator', 'planner', 'whatever']);
  assert.ok(out.startsWith('[role:planner] '), 'planner survives');
  assert.equal(out.split('\n\n').length, 1, 'unknown roles drop out — only one paragraph');
});

test('getRolePromptsFor returns "" for empty array, null, and undefined', () => {
  assert.equal(getRolePromptsFor([]), '');
  assert.equal(getRolePromptsFor(null), '');
  assert.equal(getRolePromptsFor(undefined), '');
  // Non-array (string, object, number) also short-circuits — defensive against
  // a caller that forgot to wrap a single role in an array.
  assert.equal(getRolePromptsFor('planner'), '');
  assert.equal(getRolePromptsFor(42), '');
});

test('getRoleUnassignNotices emits one canonical-format line per role', () => {
  const notices = getRoleUnassignNotices(['planner', 'tester']);
  const lines = notices.split('\n');
  assert.equal(lines.length, 2);
  assert.equal(lines[0],
    '[role:planner] role unassigned — its prior prompt fragment no longer applies.');
  assert.equal(lines[1],
    '[role:tester] role unassigned — its prior prompt fragment no longer applies.');
});

test('getRoleUnassignNotices returns "" for empty array, null, and undefined', () => {
  assert.equal(getRoleUnassignNotices([]), '');
  assert.equal(getRoleUnassignNotices(null), '');
  assert.equal(getRoleUnassignNotices(undefined), '');
});

test('getRoleUnassignNotices preserves role names verbatim (no alias rewrite)', () => {
  // Unlike getRolePromptsFor (which still uses the original name for the
  // [role:...] prefix), unassign notices simply echo the role; verify a
  // non-canonical role still produces a notice.
  const notices = getRoleUnassignNotices(['validator', 'custom-role']);
  assert.match(notices, /\[role:validator\] role unassigned/);
  assert.match(notices, /\[role:custom-role\] role unassigned/);
});
