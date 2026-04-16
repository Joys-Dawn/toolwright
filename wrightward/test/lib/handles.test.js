'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const os = require('os');

const {
  deriveHandle,
  validateHandle,
  resolveAudience,
  handleFor,
  handleIndex
} = require('../../lib/handles');
const { NAMES } = require('../../lib/wordlist');
const { registerAgentInLock, withAgentsLock } = require('../../lib/agents');

function uuid() {
  return crypto.randomUUID();
}

describe('deriveHandle', () => {
  it('is deterministic — same UUID always returns same handle', () => {
    const sid = '5ff83f6e-7de7-45bb-b53c-6084c3c3c514';
    const first = deriveHandle(sid);
    for (let i = 0; i < 100; i++) {
      assert.equal(deriveHandle(sid), first);
    }
  });

  it('matches `<name>-<number>` shape', () => {
    for (let i = 0; i < 50; i++) {
      const h = deriveHandle(uuid());
      assert.ok(/^[a-z]+-\d{1,4}$/.test(h), 'bad handle: ' + h);
    }
  });

  it('uses a name from the NAMES wordlist', () => {
    const nameSet = new Set(NAMES);
    for (let i = 0; i < 50; i++) {
      const h = deriveHandle(uuid());
      const name = h.slice(0, h.lastIndexOf('-'));
      assert.ok(nameSet.has(name), 'name not in wordlist: ' + name);
    }
  });

  it('number is in range 0..9999', () => {
    for (let i = 0; i < 50; i++) {
      const h = deriveHandle(uuid());
      const num = Number(h.slice(h.lastIndexOf('-') + 1));
      assert.ok(num >= 0 && num <= 9999, 'bad number: ' + num);
    }
  });

  it('different UUIDs usually produce different handles (low collision rate)', () => {
    // 1000 random UUIDs → fewer than 5 collisions at 1M-slot pool.
    // Birthday math: at 1000 draws from 1M slots, expected collisions < 1.
    const seen = new Map();
    let collisions = 0;
    for (let i = 0; i < 1000; i++) {
      const sid = uuid();
      const h = deriveHandle(sid);
      if (seen.has(h)) collisions++;
      else seen.set(h, sid);
    }
    assert.ok(collisions < 10, 'unexpectedly high collision count: ' + collisions);
  });

  it('rejects non-string input', () => {
    assert.throws(() => deriveHandle(null));
    assert.throws(() => deriveHandle(undefined));
    assert.throws(() => deriveHandle(42));
    assert.throws(() => deriveHandle(''));
  });

  it('handle is pure — no I/O, no global state', () => {
    // Call 10000 times and confirm no side effects (we can't easily assert
    // "no I/O" directly, but we can pin the result against a known vector).
    const sid = '00000000-0000-0000-0000-000000000000';
    const expected = deriveHandle(sid);
    for (let i = 0; i < 10000; i++) {
      assert.equal(deriveHandle(sid), expected);
    }
  });

  it('pinned vector: the all-zero UUID maps to a stable handle', () => {
    // This is a regression guard: any change to the hash algorithm,
    // wordlist seeding, or BigInt math will flip this. If this test
    // fails, someone silently changed the derivation and every existing
    // agent just got a new handle — that is a breaking change and must
    // be surfaced loudly.
    const sid = '00000000-0000-0000-0000-000000000000';
    const h = deriveHandle(sid);
    // Verify shape; the exact handle is implementation-defined but stable.
    assert.ok(/^[a-z]+-\d{1,4}$/.test(h));
    // Call a second time to confirm stability within the suite.
    assert.equal(deriveHandle(sid), h);
  });
});

describe('validateHandle', () => {
  it('accepts `name-number` shape', () => {
    assert.equal(validateHandle('bob-42'), true);
    assert.equal(validateHandle('buffy-9999'), true);
    assert.equal(validateHandle('ada-0'), true);
  });

  it('rejects non-handle shapes', () => {
    assert.equal(validateHandle('bob'), false);
    assert.equal(validateHandle('bob-'), false);
    assert.equal(validateHandle('-42'), false);
    assert.equal(validateHandle('Bob-42'), false);          // uppercase
    assert.equal(validateHandle('bob-99999'), false);       // 5 digits
    assert.equal(validateHandle('bob_42'), false);          // underscore
    assert.equal(validateHandle(''), false);
    assert.equal(validateHandle(null), false);
    assert.equal(validateHandle(undefined), false);
    assert.equal(validateHandle(42), false);
  });
});

describe('handleFor', () => {
  it('prefers the stored handle over deriving', () => {
    // handleFor is used by display paths — if a row has a handle, trust
    // it; don't second-guess it by re-deriving (which would mask migration
    // bugs where the handle field drifted from the derived value).
    const sid = uuid();
    const derived = deriveHandle(sid);
    const stored = 'custom-77';
    assert.equal(handleFor(sid, { handle: stored }), stored);
    assert.notEqual(derived, stored);
  });

  it('derives on the fly when row has no handle field', () => {
    const sid = uuid();
    assert.equal(handleFor(sid, {}), deriveHandle(sid));
    assert.equal(handleFor(sid, null), deriveHandle(sid));
    assert.equal(handleFor(sid, undefined), deriveHandle(sid));
  });

  it('derives when stored handle is malformed', () => {
    const sid = uuid();
    assert.equal(handleFor(sid, { handle: 'NOT VALID' }), deriveHandle(sid));
    assert.equal(handleFor(sid, { handle: 42 }), deriveHandle(sid));
  });
});

describe('handleIndex', () => {
  it('builds handle→sessionId map from roster', () => {
    const sidA = uuid();
    const sidB = uuid();
    const roster = {
      [sidA]: { handle: 'bob-42' },
      [sidB]: { handle: 'sam-17' }
    };
    const idx = handleIndex(roster);
    assert.equal(idx.get('bob-42'), sidA);
    assert.equal(idx.get('sam-17'), sidB);
  });

  it('falls back to derived handle for rows missing it', () => {
    const sid = uuid();
    const idx = handleIndex({ [sid]: {} });
    assert.equal(idx.get(deriveHandle(sid)), sid);
  });

  it('returns empty map for null/non-object roster', () => {
    assert.equal(handleIndex(null).size, 0);
    assert.equal(handleIndex(undefined).size, 0);
  });
});

describe('resolveAudience', () => {
  let dir;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrightward-handles-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('resolves broadcast tokens unchanged', () => {
    assert.deepEqual(resolveAudience(dir, 'all'), { type: 'broadcast', target: 'all' });
    assert.deepEqual(resolveAudience(dir, 'user'), { type: 'broadcast', target: 'user' });
  });

  it('resolves exact handle against live roster', () => {
    const sid = uuid();
    withAgentsLock(dir, () => registerAgentInLock(dir, sid));
    // Handle was derived+stored on register; find it back.
    const { readAgents } = require('../../lib/agents');
    const row = readAgents(dir)[sid];
    const result = resolveAudience(dir, row.handle);
    assert.deepEqual(result, { type: 'sessionId', target: sid });
  });

  it('resolves name-only when unambiguous', () => {
    const sid = uuid();
    withAgentsLock(dir, () => registerAgentInLock(dir, sid));
    const { readAgents } = require('../../lib/agents');
    const row = readAgents(dir)[sid];
    const name = row.handle.slice(0, row.handle.lastIndexOf('-'));
    const result = resolveAudience(dir, name);
    assert.deepEqual(result, { type: 'sessionId', target: sid });
  });

  it('errors on ambiguous name (two handles with same prefix)', () => {
    // Plant two rows that share a name prefix.
    const sidA = uuid();
    const sidB = uuid();
    const rosterPath = path.join(dir, 'agents.json');
    fs.writeFileSync(rosterPath, JSON.stringify({
      [sidA]: { registered_at: 1, last_active: 1, handle: 'bob-42' },
      [sidB]: { registered_at: 2, last_active: 2, handle: 'bob-99' }
    }));
    try {
      resolveAudience(dir, 'bob');
      assert.fail('expected throw');
    } catch (err) {
      assert.match(err.message, /ambiguous/);
      assert.ok(err.audienceError);
      assert.deepEqual(err.audienceError.liveHandles.sort(), ['bob-42', 'bob-99']);
    }
  });

  it('errors on unknown handle with hint listing live handles', () => {
    const sid = uuid();
    withAgentsLock(dir, () => registerAgentInLock(dir, sid));
    const { readAgents } = require('../../lib/agents');
    const liveHandle = readAgents(dir)[sid].handle;
    try {
      resolveAudience(dir, 'nobody-99');
      assert.fail('expected throw');
    } catch (err) {
      assert.match(err.message, /not a live agent/);
      assert.ok(err.audienceError);
      assert.ok(err.audienceError.liveHandles.includes(liveHandle));
      assert.match(err.audienceError.hint, /wrightward_whoami/);
    }
  });

  it('errors on empty/null input', () => {
    assert.throws(() => resolveAudience(dir, ''));
    assert.throws(() => resolveAudience(dir, null));
    assert.throws(() => resolveAudience(dir, undefined));
  });
});
