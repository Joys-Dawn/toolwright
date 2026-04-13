'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { sleepSync } = require('../../lib/sleep-sync');

describe('sleepSync', () => {
  it('blocks for approximately the requested duration', () => {
    const start = Date.now();
    sleepSync(100);
    const elapsed = Date.now() - start;
    // Generous upper bound: Windows scheduling and CI hosts can stretch 100ms
    // well past its nominal value. Lower bound is slightly tightened to guard
    // against a broken implementation that returns immediately (e.g., a typo
    // that passes 0 to Atomics.wait).
    assert.ok(elapsed >= 80, 'elapsed was ' + elapsed + 'ms — sleepSync returned too early');
    assert.ok(elapsed < 500, 'elapsed was ' + elapsed + 'ms — sleepSync took too long');
  });

  it('returns near-immediately for ms=0', () => {
    const start = Date.now();
    sleepSync(0);
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 50, 'elapsed was ' + elapsed + 'ms — ms=0 should not block');
  });
});
