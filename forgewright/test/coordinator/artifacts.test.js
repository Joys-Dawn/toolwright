'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { parseProduces, consumesStem } = require('../../coordinator/artifacts');

describe('artifacts.parseProduces', () => {
  test('returns null for missing or empty input', () => {
    assert.equal(parseProduces(null), null);
    assert.equal(parseProduces(undefined), null);
    assert.equal(parseProduces(''), null);
    assert.equal(parseProduces(0), null);
  });

  test('bare-name string → single, no extension', () => {
    const parsed = parseProduces('plan');
    assert.equal(parsed.kind, 'single');
    assert.deepEqual(parsed.entries, [{ stem: 'plan', filename: null, hasExtension: false }]);
  });

  test('extensioned string → single, with extension', () => {
    const parsed = parseProduces('plan.md');
    assert.equal(parsed.kind, 'single');
    assert.deepEqual(parsed.entries, [{ stem: 'plan', filename: 'plan.md', hasExtension: true }]);
  });

  test('multi-segment extensions split on the LAST dot', () => {
    const parsed = parseProduces('archive.tar.gz');
    assert.equal(parsed.entries[0].stem, 'archive.tar');
    assert.equal(parsed.entries[0].filename, 'archive.tar.gz');
  });

  test('leading-dot dotfiles are treated as bare names (no extension)', () => {
    const parsed = parseProduces('.hidden');
    assert.equal(parsed.entries[0].stem, '.hidden');
    assert.equal(parsed.entries[0].hasExtension, false);
  });

  test('trailing-dot strings are treated as bare names', () => {
    const parsed = parseProduces('plan.');
    assert.equal(parsed.entries[0].stem, 'plan.');
    assert.equal(parsed.entries[0].hasExtension, false);
  });

  test('object map → multi, one entry per key', () => {
    const parsed = parseProduces({
      metrics: 'metrics.json',
      model: 'model.bin',
      log: 'train.log',
    });
    assert.equal(parsed.kind, 'multi');
    assert.equal(parsed.entries.length, 3);
    assert.deepEqual(parsed.entries[0], { stem: 'metrics', filename: 'metrics.json', hasExtension: true });
    assert.deepEqual(parsed.entries[1], { stem: 'model', filename: 'model.bin', hasExtension: true });
    assert.deepEqual(parsed.entries[2], { stem: 'log', filename: 'train.log', hasExtension: true });
  });

  test('object map with bare-name values is allowed (hasExtension=false)', () => {
    const parsed = parseProduces({ plan: 'planfile' });
    assert.equal(parsed.kind, 'multi');
    assert.equal(parsed.entries[0].hasExtension, false);
    assert.equal(parsed.entries[0].filename, 'planfile');
  });

  test('object map skips entries with non-string keys/values', () => {
    const parsed = parseProduces({
      metrics: 'metrics.json',
      bad1: '',
      bad2: 123,
    });
    assert.equal(parsed.entries.length, 1);
    assert.equal(parsed.entries[0].stem, 'metrics');
  });

  test('returns null for object with zero usable entries', () => {
    assert.equal(parseProduces({}), null);
    assert.equal(parseProduces({ x: '', y: 0 }), null);
  });

  test('arrays are not accepted as multi-output (only object maps)', () => {
    assert.equal(parseProduces(['plan.md', 'tasks.json']), null);
  });
});

describe('artifacts.consumesStem', () => {
  test('returns the stem of a bare-name string', () => {
    assert.equal(consumesStem('plan'), 'plan');
  });

  test('returns the stem of an extensioned string', () => {
    assert.equal(consumesStem('plan.md'), 'plan');
  });

  test('returns null for missing input', () => {
    assert.equal(consumesStem(null), null);
    assert.equal(consumesStem(''), null);
    assert.equal(consumesStem(undefined), null);
  });

  test('returns null for non-string input (no map shape on consumes)', () => {
    assert.equal(consumesStem({ plan: 'plan.md' }), null);
  });
});
