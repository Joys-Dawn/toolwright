'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { parseProduces, consumesStem, consumesStems } = require('../../coordinator/artifacts');

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

describe('artifacts.consumesStems', () => {
  // The shared array-aware helper that every phase type now uses. Tests cover
  // the three accepted shapes and the throw paths config-validation relies on.
  test('null / undefined input → []', () => {
    assert.deepEqual(consumesStems(null), []);
    assert.deepEqual(consumesStems(undefined), []);
  });

  test('single string yields a one-element stems array', () => {
    assert.deepEqual(consumesStems('plan'), ['plan']);
    assert.deepEqual(consumesStems('plan.md'), ['plan']);
  });

  test('empty string yields []', () => {
    assert.deepEqual(consumesStems(''), []);
  });

  test('array of strings preserves order and strips extensions', () => {
    assert.deepEqual(
      consumesStems(['research', 'plan.md', 'metrics.json']),
      ['research', 'plan', 'metrics']
    );
  });

  test('array preserves duplicate stems — callers decide whether to de-dupe', () => {
    // Future use case: a phase that wants to read two artifacts with the same
    // stem but different paths (unlikely but legal). De-duping here would hide
    // a config bug; leave that judgment to the caller.
    assert.deepEqual(consumesStems(['plan', 'plan.md']), ['plan', 'plan']);
  });

  test('throws on array entries that are not non-empty strings', () => {
    assert.throws(() => consumesStems(['plan', 42]), /array entry must be a non-empty string/);
    assert.throws(() => consumesStems(['plan', '']), /array entry must be a non-empty string/);
    assert.throws(() => consumesStems(['plan', null]), /array entry must be a non-empty string/);
  });

  test('throws on unsupported top-level shapes (object map, number)', () => {
    // Object maps are valid for `produces` but not for `consumes` — keep them
    // out so authors don't get half-working multi-consume mixed with stem-map.
    assert.throws(() => consumesStems({ plan: 'plan.md' }), /must be a string or an array/);
    assert.throws(() => consumesStems(42), /must be a string or an array/);
  });
});
