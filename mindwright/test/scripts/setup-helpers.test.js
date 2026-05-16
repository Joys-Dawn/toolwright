// Coverage for the pure smoke-test assertion helpers extracted from
// scripts/setup.js so the threshold logic (Float32Array typecheck,
// embedding dim, unit-norm tolerance, sigmoid range) is exercised
// without the multi-GB model load the full setup script needs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EMBEDDING_DIM } from '../../lib/models.js';
import { assertEmbeddingShape, assertRerankScore } from '../../scripts/setup.js';

// Build a unit-normalized Float32Array of `dim` length so the norm-check
// path passes deterministically without depending on the actual embedder.
function unitVec(dim) {
  const v = new Float32Array(dim);
  // First entry holds all the magnitude — every other entry is 0, so
  // sqrt(sum of squares) == |v[0]| == 1.
  v[0] = 1;
  return v;
}

test('assertEmbeddingShape — happy path returns norm ≈ 1 on a unit Float32Array', () => {
  const v = unitVec(EMBEDDING_DIM);
  const norm = assertEmbeddingShape(v);
  assert.ok(Math.abs(norm - 1) < 1e-6, `expected ~1, got ${norm}`);
});

test('assertEmbeddingShape — non-Float32Array throws with a typed message', () => {
  assert.throws(
    () => assertEmbeddingShape([0, 0, 0]),
    /smoke test failed: embed did not return Float32Array/,
  );
  assert.throws(
    () => assertEmbeddingShape(null),
    /embed did not return Float32Array/,
  );
});

test('assertEmbeddingShape — wrong dimensionality is rejected', () => {
  const tooShort = unitVec(EMBEDDING_DIM - 1);
  assert.throws(
    () => assertEmbeddingShape(tooShort),
    new RegExp(`embedding dim ${EMBEDDING_DIM - 1}, expected ${EMBEDDING_DIM}`),
  );
  const tooLong = unitVec(EMBEDDING_DIM + 1);
  assert.throws(
    () => assertEmbeddingShape(tooLong),
    new RegExp(`embedding dim ${EMBEDDING_DIM + 1}, expected ${EMBEDDING_DIM}`),
  );
});

test('assertEmbeddingShape — non-unit-norm exceeds tolerance and throws', () => {
  // norm = 2; threshold is |norm - 1| > 1e-3
  const v = new Float32Array(EMBEDDING_DIM);
  v[0] = 2;
  assert.throws(
    () => assertEmbeddingShape(v),
    /embedding not unit-normalized/,
  );
});

test('assertEmbeddingShape — within 1e-3 tolerance is accepted', () => {
  // Pin the tolerance: a small deviation should pass; this guards against
  // an over-tight regression that breaks legitimate q8-quantization noise.
  const v = new Float32Array(EMBEDDING_DIM);
  v[0] = 1.0009; // |1.0009 - 1| = 9e-4 < 1e-3
  const norm = assertEmbeddingShape(v);
  assert.ok(Math.abs(norm - 1.0009) < 1e-5);
});

test('assertRerankScore — happy path with one sigmoid score in [0,1]', () => {
  const score = assertRerankScore([0.42]);
  assert.equal(score, 0.42);
  assert.equal(assertRerankScore([0]), 0);
  assert.equal(assertRerankScore([1]), 1);
});

test('assertRerankScore — wrong shape (non-array, empty, multi-element) throws', () => {
  assert.throws(() => assertRerankScore(0.5), /smoke test failed: rerank returned/);
  assert.throws(() => assertRerankScore([]), /smoke test failed: rerank returned/);
  assert.throws(() => assertRerankScore([0.1, 0.2]), /smoke test failed: rerank returned/);
  assert.throws(() => assertRerankScore(null), /smoke test failed: rerank returned/);
});

test('assertRerankScore — out-of-range or non-finite scores throw with the sigmoid hint', () => {
  // Sub-zero: indicates the sigmoid wasn't applied or the model returned a
  // raw logit instead of a probability — the user needs this surface.
  assert.throws(() => assertRerankScore([-0.1]), /outside expected sigmoid range/);
  // Super-1: also a logit-like signal.
  assert.throws(() => assertRerankScore([1.5]), /outside expected sigmoid range/);
  // NaN / Infinity should never reach the user as a "valid" score.
  assert.throws(() => assertRerankScore([NaN]), /outside expected sigmoid range/);
  assert.throws(() => assertRerankScore([Infinity]), /outside expected sigmoid range/);
});
