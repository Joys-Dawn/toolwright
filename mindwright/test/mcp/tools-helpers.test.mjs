// Direct unit tests for the helpers in mcp/tools.mjs that don't need an MCP
// roundtrip — stripScopeQualifier specifically. resolve-contradiction.test
// .mjs covers ONE happy path (scope with `(CI)` inside); this file walks the
// paren-depth + prefix branches in isolation.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { __internal } from '../../mcp/tools.mjs';
const { stripScopeQualifier } = __internal;

test('stripScopeQualifier — text without trailing `)` is returned unchanged', () => {
  // The function trims trailing whitespace before checking — verify that
  // pass-through happens for plain content.
  assert.equal(stripScopeQualifier('hello world'), 'hello world');
  // Trailing whitespace is trimmed (documented behavior).
  assert.equal(stripScopeQualifier('hello world   '), 'hello world');
});

test('stripScopeQualifier — unbalanced trailing `)` is left untouched', () => {
  // No matching `(` anywhere — the depth walker hits i<0 and returns the
  // string as-is rather than emit a half-stripped result.
  assert.equal(stripScopeQualifier('hello world)'), 'hello world)');
  assert.equal(stripScopeQualifier('a)))'), 'a)))');
});

test('stripScopeQualifier — trailing `)` whose matching `(` is not (applies when: prefix is left alone', () => {
  // Prefix-mismatch path: depth walk finds the open paren but it doesn't
  // open with the marker, so the helper bails out (the trailing paren is
  // legitimate content, not a scope qualifier).
  assert.equal(stripScopeQualifier('fact body (extra info)'), 'fact body (extra info)');
  assert.equal(stripScopeQualifier('thing (note: x)'), 'thing (note: x)');
});

test('stripScopeQualifier — clean trailing (applies when: foo) is stripped', () => {
  assert.equal(
    stripScopeQualifier('user prefers tabs (applies when: editing python)'),
    'user prefers tabs',
  );
  // Trailing whitespace after the strip is also trimmed.
  assert.equal(
    stripScopeQualifier('a\n\n(applies when: foo)'),
    'a',
  );
});

test('stripScopeQualifier — depth walks nested parens 3 levels deep', () => {
  // The auditor names depth=3 as the edge case. The depth counter must
  // open at 1 on the trailing `)`, increment on each inner `)`, decrement
  // on each inner `(`, and land back at 0 on the OUTERMOST `(applies when:`.
  const stripped = stripScopeQualifier(
    'note text (applies when: running tests (CI (linux)))',
  );
  assert.equal(stripped, 'note text');
});

test('stripScopeQualifier — uppercase prefix is matched (case-insensitive)', () => {
  // The implementation lowercases the prefix candidate before comparison
  // (`t.slice(i, i + PREFIX.length).toLowerCase()`), so APPLIES WHEN: and
  // Applies When: both match.
  assert.equal(
    stripScopeQualifier('content (APPLIES WHEN: macOS)'),
    'content',
  );
  assert.equal(
    stripScopeQualifier('content (Applies When: macOS)'),
    'content',
  );
});

test('stripScopeQualifier — non-string input returns empty string', () => {
  // The function guards `typeof text !== 'string'` and emits '' so a
  // caller that hands in null/undefined doesn't crash mid-flow. Pinning
  // this behavior so a future refactor doesn't accidentally start
  // throwing on null and break the scope_both code path.
  assert.equal(stripScopeQualifier(null), '');
  assert.equal(stripScopeQualifier(undefined), '');
  assert.equal(stripScopeQualifier(42), '');
  assert.equal(stripScopeQualifier({}), '');
});
