import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveHandle, validateHandle, NAMES, HANDLE_PATTERN } from '../lib/handles.js';

// CANARY — if this fails after a refactor, the deriveHandle algorithm or the
// NAMES table has shifted, which means every persisted handle in production
// DBs would silently re-map (file's documented INVARIANT). Do NOT update the
// literal to make the test pass — investigate the underlying drift instead.
test('deriveHandle("test-canary-uuid") returns the pinned reference handle (drift sentinel)', () => {
  assert.equal(deriveHandle('test-canary-uuid'), 'ava-7878');
});

test('NAMES is a frozen wordlist of exactly 100 entries with "ada" at index 0', () => {
  assert.equal(NAMES.length, 100,
    'NAMES.length must stay 100 — collision math (1M slots) depends on this');
  assert.equal(NAMES[0], 'ada',
    'NAMES[0] must stay "ada" — every UUID that maps to index 0 hardcodes this');
  assert.equal(NAMES[99], 'tess',
    'NAMES[99] must stay "tess" — the last entry anchors append-only growth');
  assert.equal(Object.isFrozen(NAMES), true,
    'NAMES must be frozen so a runtime push() can not violate the invariant');
});

test('deriveHandle is deterministic — same UUID maps to same handle across calls', () => {
  const uuid = '550e8400-e29b-41d4-a716-446655440000';
  const h1 = deriveHandle(uuid);
  const h2 = deriveHandle(uuid);
  const h3 = deriveHandle(uuid);
  assert.equal(h1, h2);
  assert.equal(h2, h3);
});

test('deriveHandle output always matches HANDLE_PATTERN', () => {
  const uuids = [
    '550e8400-e29b-41d4-a716-446655440000',
    'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
    '6ba7b810-9dad-11d1-80b4-00c04fd430c8',
    'short-uuid',
    'x',
    'a'.repeat(200),
  ];
  for (const uuid of uuids) {
    const handle = deriveHandle(uuid);
    assert.match(handle, HANDLE_PATTERN,
      `deriveHandle(${JSON.stringify(uuid)}) returned ${handle} which does not match HANDLE_PATTERN`);
  }
});

test('deriveHandle throws on empty string', () => {
  assert.throws(
    () => deriveHandle(''),
    /non-empty string/,
    'empty string must throw — silent fallback would mint a real-looking handle from nothing',
  );
});

test('deriveHandle throws on non-string inputs (null/undefined/number/object)', () => {
  for (const bad of [null, undefined, 0, 42, {}, [], true]) {
    assert.throws(
      () => deriveHandle(bad),
      /non-empty string/,
      `deriveHandle(${JSON.stringify(bad)}) must throw — only strings are valid sessionIds`,
    );
  }
});

test('validateHandle accepts well-formed handles', () => {
  for (const h of ['ada-0', 'ada-1', 'tess-9999', 'bob-42', 'dex-6826', 'ivy-2448']) {
    assert.equal(validateHandle(h), true, `expected ${h} to validate`);
  }
});

test('validateHandle rejects malformed handles', () => {
  for (const bad of [
    '',
    'ada',           // no number
    'ada-',          // empty number
    'ada-10000',     // 5 digits — pattern caps at 4
    'Ada-1',         // uppercase
    'ada_1',         // underscore not dash
    '1-ada',         // reversed
    'ada-1-extra',   // trailing
    null,
    undefined,
    42,
    {},
  ]) {
    assert.equal(validateHandle(bad), false,
      `expected ${JSON.stringify(bad)} to fail validateHandle`);
  }
});

test('HANDLE_PATTERN matches the same shape deriveHandle emits (lockstep regression)', () => {
  // If deriveHandle's emitted shape ever drifts from HANDLE_PATTERN, callers
  // that use validateHandle as a routing guard will start rejecting freshly
  // minted handles. Sample a few derivations and re-validate.
  for (const uuid of ['a', 'aa', 'ab', 'zzz', 'session-1', 'session-2', 'session-3']) {
    const handle = deriveHandle(uuid);
    assert.equal(validateHandle(handle), true,
      `freshly derived handle ${handle} must pass validateHandle`);
  }
});
