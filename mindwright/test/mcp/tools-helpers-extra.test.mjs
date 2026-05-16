// Direct unit tests for the small validators / serializers / authz checks in
// mcp/tools.mjs. Integration tests at the MCP roundtrip level exercise these
// indirectly, but isolated assertions tighten the regression net (a path-
// traversal in requireValidSessionId or a forgotten BigInt branch in
// bigintReplacer is caught here before the full roundtrip even fires).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { __internal } from '../../mcp/tools.mjs';

const {
  validateScope,
  bigintReplacer,
  requireValidSessionId,
  authzCrossSession,
  okResponse,
  errResponse,
} = __internal;

// ---------- validateScope ----------

test('validateScope accepts the two canonical scope-strings', () => {
  assert.equal(validateScope('user'), true);
  assert.equal(validateScope('project'), true);
});

test('validateScope accepts role:<role> with role-pattern-safe names', () => {
  assert.equal(validateScope('role:planner'), true);
  assert.equal(validateScope('role:tester'), true);
  assert.equal(validateScope('role:reviewer'), true);
});

test('validateScope rejects role:<bad> with unsafe characters in the role suffix', () => {
  // ROLE_PATTERN forbids slashes, dots, spaces, etc.; verify they fail at
  // this boundary rather than slipping through to filesystem code.
  assert.equal(validateScope('role:../etc'), false);
  assert.equal(validateScope('role:foo bar'), false);
  assert.equal(validateScope('role:foo.bar'), false);
  assert.equal(validateScope('role:'), false);
});

test('validateScope rejects non-string and arbitrary string values', () => {
  assert.equal(validateScope(''), false);
  assert.equal(validateScope('admin'), false);
  assert.equal(validateScope('Project'), false);
  assert.equal(validateScope(null), false);
  assert.equal(validateScope(undefined), false);
  assert.equal(validateScope(42), false);
  assert.equal(validateScope({}), false);
});

// ---------- bigintReplacer ----------

test('bigintReplacer converts a top-level BigInt to its string form via JSON.stringify', () => {
  const out = JSON.stringify({ id: 42n }, bigintReplacer);
  assert.equal(out, '{"id":"42"}',
    'BigInt id must serialize as a quoted string so JSON.parse on the other side does not lose it');
});

test('bigintReplacer reaches nested BigInts through arrays and objects', () => {
  const value = {
    rowid: 1n,
    children: [
      { id: 2n, name: 'a' },
      { id: 3n, name: 'b' },
    ],
    nested: { inner: { rowid: 4n } },
  };
  const out = JSON.parse(JSON.stringify(value, bigintReplacer));
  assert.equal(out.rowid, '1');
  assert.equal(out.children[0].id, '2');
  assert.equal(out.children[1].id, '3');
  assert.equal(out.nested.inner.rowid, '4');
});

test('bigintReplacer passes non-BigInt values through unchanged', () => {
  assert.equal(bigintReplacer('k', 'a string'), 'a string');
  assert.equal(bigintReplacer('k', 42), 42);
  assert.equal(bigintReplacer('k', null), null);
  // Numbers next to MAX_SAFE_INTEGER stay numbers — the helper only catches
  // the BigInt type, not "values that look big."
  assert.equal(bigintReplacer('k', Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER);
});

// ---------- requireValidSessionId ----------

test('requireValidSessionId accepts a UUID-shaped sessionId and returns null', () => {
  assert.equal(requireValidSessionId('550e8400-e29b-41d4-a716-446655440000'), null);
  assert.equal(requireValidSessionId('abc_123'), null);
  assert.equal(requireValidSessionId('mindwright-unbound'), null);
});

test('requireValidSessionId rejects empty / non-string', () => {
  assert.match(requireValidSessionId(''), /session_id required/);
  assert.match(requireValidSessionId(null), /session_id required/);
  assert.match(requireValidSessionId(undefined), /session_id required/);
  assert.match(requireValidSessionId(42), /session_id required/);
  assert.match(requireValidSessionId({}), /session_id required/);
});

test('requireValidSessionId rejects path-traversal patterns (the main security ask)', () => {
  // SESSION_ID_PATTERN is the single source of truth for "path-safe"; any
  // input that could land in pipePath() / sessionDir() and escape must fail
  // here, not at the filesystem boundary.
  assert.match(requireValidSessionId('../etc/passwd'), /path-safe identifier/);
  assert.match(requireValidSessionId('a/b'), /path-safe identifier/);
  assert.match(requireValidSessionId('a\\b'), /path-safe identifier/);
  assert.match(requireValidSessionId('a.b'), /path-safe identifier/);
  assert.match(requireValidSessionId('a b'), /path-safe identifier/);
  assert.match(requireValidSessionId('a:b'), /path-safe identifier/);
});

test('requireValidSessionId rejects strings longer than the 128-char cap', () => {
  // Length cap defends both filesystem-path-limit on Windows and the
  // sqlite-row-size budget on memory tables.
  const tooLong = 'a'.repeat(129);
  assert.match(requireValidSessionId(tooLong), /path-safe identifier/);
  // 128 chars is allowed (boundary).
  assert.equal(requireValidSessionId('a'.repeat(128)), null);
});

// ---------- authzCrossSession ----------

test('authzCrossSession returns null when session_id matches the caller (same-session)', () => {
  const ctx = { sessionId: 'session-A' };
  assert.equal(authzCrossSession('session-A', {}, ctx, 'write'), null,
    'same-session ops are implicit — no confirm flag needed');
});

test('authzCrossSession returns an error when crossing sessions without confirm_cross_session:true', () => {
  const ctx = { sessionId: 'session-A' };
  const err = authzCrossSession('session-B', {}, ctx, 'write');
  assert.match(err, /does not match the caller's session/);
  assert.match(err, /confirm_cross_session:true/);
  assert.match(err, /Cross-session role write/);
});

test('authzCrossSession surfaces the opLabel verbatim so the LLM sees write vs read', () => {
  const ctx = { sessionId: 'session-A' };
  // The label is the only varying part of the error wording — pin both forms.
  const writeErr = authzCrossSession('session-B', {}, ctx, 'write');
  const readErr = authzCrossSession('session-B', {}, ctx, 'read');
  assert.match(writeErr, /role write/);
  assert.match(readErr, /role read/);
});

test('authzCrossSession returns null when crossing sessions WITH confirm_cross_session:true', () => {
  const ctx = { sessionId: 'session-A' };
  const out = authzCrossSession('session-B', { confirm_cross_session: true }, ctx, 'write');
  assert.equal(out, null, 'explicit confirm flag unlocks cross-session ops');
});

test('authzCrossSession only honors literal true (not truthy values like 1/"true")', () => {
  // The check is `!== true` so truthy-but-not-true values must still fail.
  // This is defensive against a tool-call that emits `confirm_cross_session:
  // "true"` (string) thinking it satisfies the gate.
  const ctx = { sessionId: 'session-A' };
  assert.match(authzCrossSession('session-B', { confirm_cross_session: 1 }, ctx, 'write'),
    /confirm_cross_session:true/);
  assert.match(authzCrossSession('session-B', { confirm_cross_session: 'true' }, ctx, 'write'),
    /confirm_cross_session:true/);
  assert.match(authzCrossSession('session-B', { confirm_cross_session: {} }, ctx, 'write'),
    /confirm_cross_session:true/);
});

// ---------- okResponse / errResponse ----------

test('okResponse wraps payload as MCP text content with bigint-aware JSON', () => {
  const r = okResponse({ id: 42n, name: 'a' });
  assert.equal(r.content[0].type, 'text');
  assert.equal(r.content[0].text, '{"id":"42","name":"a"}');
  assert.equal(r.isError, undefined, 'success responses must not set isError');
});

test('errResponse includes isError:true plus the error message and any extras', () => {
  const r = errResponse('something broke', { code: 'EBROKE', live_handles: ['ada-1'] });
  assert.equal(r.isError, true);
  const body = JSON.parse(r.content[0].text);
  assert.equal(body.error, 'something broke');
  assert.equal(body.code, 'EBROKE');
  assert.deepEqual(body.live_handles, ['ada-1']);
});

test('errResponse with no extras serializes a single-field body', () => {
  const r = errResponse('plain error');
  const body = JSON.parse(r.content[0].text);
  assert.deepEqual(body, { error: 'plain error' });
});
