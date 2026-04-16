'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { NAMES } = require('../../lib/wordlist');

describe('NAMES wordlist', () => {
  it('is frozen (Object.freeze)', () => {
    assert.ok(Object.isFrozen(NAMES));
  });

  it('pins the first 20 entries — reordering rehandles every existing session', () => {
    // INVARIANT test: the wordlist is an append-only contract. Reordering
    // or removing an entry remaps every existing session UUID to a
    // different handle on next heartbeat, which silently breaks peer
    // memory (`bob-42 said X` resolves to a different session after the
    // rename). Add new names at the END only. If this snapshot fails,
    // the fix is to restore the original order, not update the snapshot.
    assert.deepEqual(NAMES.slice(0, 20), [
      'ada',   'alex',  'amy',   'andy',  'anna',  'ari',   'ava',   'beau',  'ben',   'beth',
      'bo',    'bob',   'buck',  'buffy', 'cal',   'cam',   'cara',  'carl',  'cleo',  'cody'
    ]);
  });

  it('contains buffy (user-requested)', () => {
    assert.ok(NAMES.includes('buffy'));
  });

  it('has at least 100 entries — required for collision-safe handle pool', () => {
    // 100 × 10000 number range = 1M slots. Birthday-paradox 50%-collision
    // at ~1183 concurrent sessions. Below 100 the collision math gets
    // uncomfortable at the project's expected 3–10 concurrent agents.
    assert.ok(NAMES.length >= 100, 'expected >=100 names, got ' + NAMES.length);
  });

  it('every entry is lowercase ASCII letters only', () => {
    for (const n of NAMES) {
      assert.ok(/^[a-z]+$/.test(n), 'bad name: ' + JSON.stringify(n));
    }
  });

  it('has no duplicate entries', () => {
    const unique = new Set(NAMES);
    assert.equal(unique.size, NAMES.length);
  });
});
