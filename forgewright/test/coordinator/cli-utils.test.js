'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { parseFlags, requireFlag } = require('../../coordinator/cli-utils');

describe('cli-utils', () => {
  describe('parseFlags', () => {
    test('parses key/value flags', () => {
      const { flags, positional } = parseFlags(['--workflow', 'abc', '--result', 'completed']);
      assert.deepEqual(flags, { workflow: 'abc', result: 'completed' });
      assert.deepEqual(positional, []);
    });

    test('treats flag with no value as boolean true', () => {
      const { flags } = parseFlags(['--force']);
      assert.equal(flags.force, true);
    });

    test('treats flag followed by another flag as boolean', () => {
      const { flags } = parseFlags(['--skip', '--workflow', 'abc']);
      assert.equal(flags.skip, true);
      assert.equal(flags.workflow, 'abc');
    });

    test('collects positional arguments', () => {
      const { flags, positional } = parseFlags(['feature', 'Add markdown', '--workflow', 'wf-1']);
      assert.deepEqual(flags, { workflow: 'wf-1' });
      assert.deepEqual(positional, ['feature', 'Add markdown']);
    });

    test('returns empty for no argv', () => {
      const { flags, positional } = parseFlags([]);
      assert.deepEqual(flags, {});
      assert.deepEqual(positional, []);
    });
  });

  describe('requireFlag', () => {
    test('returns value when present', () => {
      assert.equal(requireFlag({ workflow: 'abc' }, 'workflow'), 'abc');
    });

    test('throws when flag is missing', () => {
      assert.throws(() => requireFlag({}, 'workflow'), /Missing required flag: --workflow/);
    });

    test('throws when flag is bare (no value)', () => {
      assert.throws(() => requireFlag({ workflow: true }, 'workflow'), /Missing required flag: --workflow/);
    });
  });
});
