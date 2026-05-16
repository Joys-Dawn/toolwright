// Tests for lib/vec.js#cosineSimilarity. The function is the single point of
// numerical contact between the novelty gate (hooks/pre-tool-use.js) and the
// embedder output — its guards have to behave exactly as the gate expects.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cosineSimilarity } from '../lib/vec.js';

test('cosineSimilarity throws when either input is missing', () => {
  assert.throws(() => cosineSimilarity(null, [1, 2]), /both vectors are required/);
  assert.throws(() => cosineSimilarity([1, 2], null), /both vectors are required/);
  assert.throws(() => cosineSimilarity(undefined, undefined), /both vectors are required/);
});

test('cosineSimilarity throws when an input lacks .length', () => {
  assert.throws(
    () => cosineSimilarity({ 0: 1, 1: 2 }, [1, 2]),
    /inputs must be array-like with \.length/,
  );
});

test('cosineSimilarity throws on length mismatch with both lengths in the message', () => {
  assert.throws(
    () => cosineSimilarity([1, 2, 3], [1, 2]),
    /length mismatch \(3 vs 2\)/,
  );
});

test('cosineSimilarity throws on empty inputs', () => {
  assert.throws(() => cosineSimilarity([], []), /inputs must be non-empty/);
});

test('cosineSimilarity returns 1 for identical non-zero vectors', () => {
  const v = [1, 2, 3, 4];
  assert.equal(cosineSimilarity(v, v), 1);
});

test('cosineSimilarity returns -1 for diametrically opposed vectors', () => {
  assert.equal(cosineSimilarity([1, 2, 3], [-1, -2, -3]), -1);
});

test('cosineSimilarity returns 0 for orthogonal vectors', () => {
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
});

test('cosineSimilarity returns 0 when the first vector is the zero vector', () => {
  // The function's contract: a zero vector has cosine 0. The novelty gate
  // relies on this — without it, dividing by zero would yield NaN and the
  // gate's `cos < THRESHOLD` would silently always evaluate false.
  assert.equal(cosineSimilarity([0, 0, 0], [1, 2, 3]), 0);
});

test('cosineSimilarity returns 0 when the second vector is the zero vector', () => {
  assert.equal(cosineSimilarity([1, 2, 3], [0, 0, 0]), 0);
});

test('cosineSimilarity matches across Array and Float32Array of the same values', () => {
  // Hooks pass Float32Arrays in (transformers.js output); fixtures often
  // pass plain Arrays. The function MUST be agnostic to that distinction.
  const f32 = new Float32Array([0.1, 0.2, 0.3, 0.4]);
  const arr = [0.1, 0.2, 0.3, 0.4];
  const fromF32 = cosineSimilarity(f32, f32);
  const fromArr = cosineSimilarity(arr, arr);
  assert.ok(Math.abs(fromF32 - fromArr) < 1e-6);
});

test('cosineSimilarity handles a non-normalized pair without crashing', () => {
  // bge-m3 emits L2-unit-normalized vectors so cosine reduces to a dot
  // product, but the helper computes magnitudes — a hand-built fixture vector
  // (not normalized) must still produce a scalar in [-1, 1].
  const a = [3, 0];
  const b = [4, 0];
  assert.equal(cosineSimilarity(a, b), 1);
});

test('cosineSimilarity is symmetric', () => {
  const a = [1, 2, 3, 4];
  const b = [4, 3, 2, 1];
  const ab = cosineSimilarity(a, b);
  const ba = cosineSimilarity(b, a);
  assert.equal(ab, ba);
});
