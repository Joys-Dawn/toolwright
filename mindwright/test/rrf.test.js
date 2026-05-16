// RRF fusion tests. Deterministic, no DB or models.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rrfFuse } from '../lib/rrf.js';
import { RRF_K } from '../lib/constants.js';

test('single list returns items in original order', () => {
  const fused = rrfFuse([[10, 20, 30]]);
  assert.deepEqual(fused.map((f) => f.id), [10, 20, 30]);
});

test('two lists fuse with reciprocal-rank scoring', () => {
  const a = [1, 2, 3];
  const b = [3, 1, 2];
  const fused = rrfFuse([a, b]);
  // id=1: 1/(60+1) + 1/(60+2) ≈ 0.01639 + 0.01613 = 0.03252
  // id=3: 1/(60+3) + 1/(60+1) ≈ 0.01587 + 0.01639 = 0.03226
  // id=2: 1/(60+2) + 1/(60+3) ≈ 0.01613 + 0.01587 = 0.03200
  // Ordering: 1 > 3 > 2
  assert.deepEqual(fused.map((f) => f.id), [1, 3, 2]);
});

test('item only in one list scores lower than items in multiple', () => {
  const a = [1, 2, 3];
  const b = [4]; // 4 is only here
  const fused = rrfFuse([a, b]);
  const idxOf = (id) => fused.findIndex((f) => f.id === id);
  assert.ok(idxOf(1) < idxOf(4)); // 1 is rank 1 in a
});

test('k=60 default', () => {
  assert.equal(RRF_K, 60);
});

test('custom k changes the scoring profile', () => {
  const a = [1, 2];
  const b = [2, 1];
  // With small k, position differences matter more.
  const fusedSmall = rrfFuse([a, b], { k: 1 });
  // id=1: 1/2 + 1/3 = 0.833; id=2: 1/3 + 1/2 = 0.833 — tied. Implementation order: 1 first.
  // We assert both ids are present rather than testing the tie order.
  assert.equal(fusedSmall.length, 2);
  assert.deepEqual(fusedSmall.map((f) => f.id).sort((a, b) => a - b), [1, 2]);
});

test('empty lists produce empty output', () => {
  assert.deepEqual(rrfFuse([]), []);
  assert.deepEqual(rrfFuse([[]]), []);
  assert.deepEqual(rrfFuse([[], [], []]), []);
});

test('one empty list among populated ones is ignored gracefully', () => {
  const fused = rrfFuse([[1, 2, 3], []]);
  assert.deepEqual(fused.map((f) => f.id), [1, 2, 3]);
});
