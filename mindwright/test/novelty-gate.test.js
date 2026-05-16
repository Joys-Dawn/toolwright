// Tests for the PreToolUse novelty gate and the length-bucketed top-K
// helper. Both live in hooks/pre-tool-use.js and are exported specifically
// so the gate logic can be unit-tested without spawning the hook
// subprocess (which reads stdin and would block node:test).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { noveltyPasses, topKForLength } from '../hooks/pre-tool-use.js';
import {
  NOVELTY_THRESHOLD,
  LENGTH_BUCKET_SMALL,
  LENGTH_BUCKET_MID,
  TOP_K_BY_LENGTH,
} from '../lib/constants.js';

// ----- topKForLength -----------------------------------------------------

test('topKForLength returns the small bucket at length 0', () => {
  assert.equal(topKForLength(0), TOP_K_BY_LENGTH.small);
});

test('topKForLength returns the small bucket exactly at LENGTH_BUCKET_SMALL', () => {
  // Bucket boundary is inclusive on the left (≤ small). 200 stays small.
  assert.equal(topKForLength(LENGTH_BUCKET_SMALL), TOP_K_BY_LENGTH.small);
});

test('topKForLength returns the mid bucket just past LENGTH_BUCKET_SMALL', () => {
  assert.equal(topKForLength(LENGTH_BUCKET_SMALL + 1), TOP_K_BY_LENGTH.mid);
});

test('topKForLength returns the mid bucket exactly at LENGTH_BUCKET_MID', () => {
  assert.equal(topKForLength(LENGTH_BUCKET_MID), TOP_K_BY_LENGTH.mid);
});

test('topKForLength returns the large bucket just past LENGTH_BUCKET_MID', () => {
  assert.equal(topKForLength(LENGTH_BUCKET_MID + 1), TOP_K_BY_LENGTH.large);
});

test('topKForLength returns the large bucket for very long inputs', () => {
  assert.equal(topKForLength(10_000), TOP_K_BY_LENGTH.large);
});

// ----- noveltyPasses -----------------------------------------------------

// Helper: build a vector that produces a chosen cosine against a reference
// when both have the SAME basis. We use 2D vectors throughout since the
// math is identical at any dimension.
function unitAt(theta) {
  return [Math.cos(theta), Math.sin(theta)];
}

test('noveltyPasses fires when there is no prior embedding (first PreToolUse)', () => {
  // The session-fresh path: no prior query has been embedded, so the gate
  // must let retrieval run.
  assert.equal(noveltyPasses(null, unitAt(0)), true);
  assert.equal(noveltyPasses(undefined, unitAt(0)), true);
});

test('noveltyPasses suppresses when cosine equals the threshold exactly', () => {
  // The gate fires iff cosine STRICTLY < NOVELTY_THRESHOLD. Equality
  // suppresses — there is no new information to justify a retrieval.
  const prev = unitAt(0);
  const curr = unitAt(Math.acos(NOVELTY_THRESHOLD));
  // Numerical noise: this construction yields cosine === NOVELTY_THRESHOLD
  // up to float precision. Confirm equality is the suppress side.
  assert.equal(noveltyPasses(prev, curr), false);
});

test('noveltyPasses fires when cosine is below the threshold', () => {
  // Two vectors 90° apart → cosine 0, well below the 0.85 threshold.
  assert.equal(noveltyPasses(unitAt(0), unitAt(Math.PI / 2)), true);
});

test('noveltyPasses suppresses when cosine is above the threshold (near-duplicate query)', () => {
  // Tiny rotation → cosine ≈ 1.0, above 0.85 → suppress.
  assert.equal(noveltyPasses(unitAt(0), unitAt(0.01)), false);
});

test('noveltyPasses suppresses identical vectors (cosine == 1)', () => {
  const v = unitAt(0);
  assert.equal(noveltyPasses(v, v), false);
});

test('noveltyPasses fires when prev and curr have different lengths (defensive recovery)', () => {
  // Malformed prior row (e.g. a partial write) must not wedge retrieval
  // silent. The gate catches cosineSimilarity's "length mismatch" throw and
  // returns true so the user still gets recall.
  assert.equal(noveltyPasses([1, 0, 0], [1, 0]), true);
});

test('noveltyPasses fires when prev is the zero vector (cosine defined as 0)', () => {
  // Zero-vector recovery in vec.js returns 0; 0 < 0.85 → fire.
  assert.equal(noveltyPasses([0, 0], [1, 0]), true);
});
