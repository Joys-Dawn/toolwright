'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { parseFlags } = require('../../coordinator/cli-utils');

describe('cli-utils', () => {
  describe('parseFlags', () => {
    it('parses key-value flags', () => {
      const { flags } = parseFlags(['--run', 'abc', '--stage', 'correctness']);
      assert.equal(flags.run, 'abc');
      assert.equal(flags.stage, 'correctness');
    });

    it('parses boolean flags (no value)', () => {
      const { flags } = parseFlags(['--verbose', '--dry-run']);
      assert.equal(flags.verbose, true);
      assert.equal(flags['dry-run'], true);
    });

    it('treats flag followed by another flag as boolean', () => {
      const { flags } = parseFlags(['--verbose', '--run', 'abc']);
      assert.equal(flags.verbose, true);
      assert.equal(flags.run, 'abc');
    });

    it('collects positional arguments', () => {
      const { positional } = parseFlags(['foo', 'bar', '--run', 'abc', 'baz']);
      assert.deepEqual(positional, ['foo', 'bar', 'baz']);
    });

    it('returns empty for no arguments', () => {
      const { flags, positional } = parseFlags([]);
      assert.deepEqual(flags, {});
      assert.deepEqual(positional, []);
    });

    it('handles flag at end of args as boolean', () => {
      const { flags } = parseFlags(['--run', 'abc', '--verbose']);
      assert.equal(flags.run, 'abc');
      assert.equal(flags.verbose, true);
    });

    it('last value wins for duplicate flags', () => {
      const { flags } = parseFlags(['--run', 'first', '--run', 'second']);
      assert.equal(flags.run, 'second');
    });
  });
});
