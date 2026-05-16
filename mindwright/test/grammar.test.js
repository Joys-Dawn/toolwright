import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pluralize, agree } from '../lib/grammar.js';

test('pluralize emits singular noun for n=1', () => {
  assert.equal(pluralize(1, 'row'), '1 row');
  assert.equal(pluralize(1, 'fact'), '1 fact');
});

test('pluralize emits plural noun for n=0 (zero is plural in English)', () => {
  assert.equal(pluralize(0, 'row'), '0 rows');
});

test('pluralize emits plural noun for n>1 with default `${singular}s` suffix', () => {
  assert.equal(pluralize(5, 'row'), '5 rows');
  assert.equal(pluralize(2, 'embedding'), '2 embeddings');
});

test('pluralize honors explicit plural override (irregular nouns)', () => {
  assert.equal(pluralize(2, 'fact', 'facts'), '2 facts');
  assert.equal(pluralize(3, 'child', 'children'), '3 children');
  assert.equal(pluralize(1, 'child', 'children'), '1 child');
});

test('pluralize joins count and noun with one space', () => {
  // Regression guard: any joiner change would break callers that re-use the
  // output as a substring (e.g. `${pluralize(...)} are stored`).
  assert.match(pluralize(7, 'row'), /^7 rows$/);
});

test('agree returns singular form for n=1', () => {
  assert.equal(agree(1, 'is', 'are'), 'is');
  assert.equal(agree(1, 'exists', 'exist'), 'exists');
});

test('agree returns plural form for n!=1', () => {
  assert.equal(agree(0, 'is', 'are'), 'are');
  assert.equal(agree(5, 'is', 'are'), 'are');
  assert.equal(agree(2, 'exists', 'exist'), 'exist');
});
