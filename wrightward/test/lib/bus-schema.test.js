'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createEvent, isUrgent, matchesSession, validateEvent, EVENT_TYPES, URGENT_TYPES, SYNTHETIC_SENDER } = require('../../lib/bus-schema');
const { BRIDGE_SESSION_ID } = require('../../lib/constants');

describe('bus-schema', () => {
  describe('createEvent', () => {
    it('returns object with all required fields', () => {
      const e = createEvent('sess-1', 'sess-2', 'note', 'hello');
      assert.ok(typeof e.id === 'string' && e.id.length > 0);
      assert.ok(typeof e.ts === 'number' && e.ts > 0);
      assert.equal(e.from, 'sess-1');
      assert.equal(e.to, 'sess-2');
      assert.equal(e.type, 'note');
      assert.equal(e.body, 'hello');
      assert.deepEqual(e.meta, {});
      assert.equal(e.severity, 'info');
      assert.equal(e.expires_at, null);
    });

    it('generates unique IDs (UUID format)', () => {
      const a = createEvent('sess-1', 'all', 'note', '');
      const b = createEvent('sess-1', 'all', 'note', '');
      assert.notEqual(a.id, b.id);
      // UUID v4 format: 8-4-4-4-12 hex
      assert.match(a.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });

    it('validates from via validateSessionId', () => {
      assert.throws(() => createEvent('../../evil', 'all', 'note', ''), /Invalid session ID/);
      assert.throws(() => createEvent('', 'all', 'note', ''), /Invalid session ID/);
      assert.throws(() => createEvent('has spaces', 'all', 'note', ''), /Invalid session ID/);
    });

    it('accepts SYNTHETIC_SENDER as from (runtime-emitted events)', () => {
      const e = createEvent(SYNTHETIC_SENDER, 'all', 'user_message', 'from runtime');
      assert.equal(e.from, SYNTHETIC_SENDER);
    });

    it('validates type is known', () => {
      assert.throws(() => createEvent('sess-1', 'all', 'unknown_type', ''), /Unknown event type/);
    });

    it('accepts to as string', () => {
      const e = createEvent('sess-1', 'sess-2', 'note', '');
      assert.equal(typeof e.to, 'string');
    });

    it('accepts to as array', () => {
      const e = createEvent('sess-1', ['sess-2', 'sess-3'], 'note', '');
      assert.ok(Array.isArray(e.to));
      assert.deepEqual(e.to, ['sess-2', 'sess-3']);
    });

    it('rejects empty to array', () => {
      assert.throws(() => createEvent('sess-1', [], 'note', ''), /to array must not be empty/);
    });

    it('rejects non-string non-array to', () => {
      assert.throws(() => createEvent('sess-1', 123, 'note', ''), /to must be a string or array/);
    });

    it('sets expires_at when provided', () => {
      const exp = Date.now() + 60000;
      const e = createEvent('sess-1', 'all', 'handoff', 'task', {}, 'info', exp);
      assert.equal(e.expires_at, exp);
    });

    it('passes meta through', () => {
      const meta = { task_ref: 'auth', files_unlocked: ['a.js'] };
      const e = createEvent('sess-1', 'sess-2', 'handoff', '', meta);
      assert.deepEqual(e.meta, meta);
    });

    it('passes severity through', () => {
      const e = createEvent('sess-1', 'all', 'blocker', '', {}, 'critical');
      assert.equal(e.severity, 'critical');
    });

    it('accepts Phase 3 rate_limited event type', () => {
      const e = createEvent(SYNTHETIC_SENDER, 'all', 'rate_limited', 'Dropped 3 posts',
        { destination_channel: 'broadcast', dropped_count: 3, first_event_id: 'evt-x' });
      assert.equal(e.type, 'rate_limited');
    });

    it('accepts Phase 3 context_updated event type', () => {
      const e = createEvent('sess-1', 'all', 'context_updated', 'new task',
        { prev_task: 'old task', new_task: 'new task' });
      assert.equal(e.type, 'context_updated');
    });

    it('rejects BRIDGE_SESSION_ID as event from — bridge is not a real sender', () => {
      // Events originating from the bridge use SYNTHETIC_SENDER (runtime sender).
      // __bridge__ is a bookmark-only identifier; allowing it as `from` would
      // let a real session impersonate the bridge on bus.jsonl.
      assert.throws(
        () => createEvent(BRIDGE_SESSION_ID, 'all', 'note', 'hi'),
        /Invalid session ID/
      );
    });
  });

  describe('isUrgent', () => {
    it('returns true for each urgent type', () => {
      for (const type of URGENT_TYPES) {
        assert.ok(isUrgent({ type }), `expected ${type} to be urgent`);
      }
    });

    it('returns false for non-urgent types', () => {
      const nonUrgent = [...EVENT_TYPES].filter(t => !URGENT_TYPES.has(t));
      assert.ok(nonUrgent.length > 0, 'should have non-urgent types');
      for (const type of nonUrgent) {
        assert.ok(!isUrgent({ type }), `expected ${type} to NOT be urgent`);
      }
    });
  });

  describe('matchesSession', () => {
    it('excludes events from self (sender exclusion)', () => {
      const e = { from: 'sess-1', to: 'sess-1' };
      assert.equal(matchesSession(e, 'sess-1'), false);
    });

    it('matches direct target', () => {
      const e = { from: 'sess-2', to: 'sess-1' };
      assert.equal(matchesSession(e, 'sess-1'), true);
    });

    it('matches "all" broadcast', () => {
      const e = { from: 'sess-2', to: 'all' };
      assert.equal(matchesSession(e, 'sess-1'), true);
    });

    it('excludes "all" broadcast from self', () => {
      const e = { from: 'sess-1', to: 'all' };
      assert.equal(matchesSession(e, 'sess-1'), false);
    });

    it('matches array to with session in list', () => {
      const e = { from: 'sess-2', to: ['other', 'sess-1'] };
      assert.equal(matchesSession(e, 'sess-1'), true);
    });

    it('does not match array to without session', () => {
      const e = { from: 'sess-2', to: ['other1', 'other2'] };
      assert.equal(matchesSession(e, 'sess-1'), false);
    });

    it('matches "all" in array', () => {
      const e = { from: 'sess-2', to: ['all'] };
      assert.equal(matchesSession(e, 'sess-1'), true);
    });

    it('returns false for role:* (Phase 1)', () => {
      const e = { from: 'sess-2', to: 'role:tester' };
      assert.equal(matchesSession(e, 'sess-1'), false);
    });

    it('returns false for unrecognized to value', () => {
      const e = { from: 'sess-2', to: 'discord' };
      assert.equal(matchesSession(e, 'sess-1'), false);
    });
  });

  describe('validateEvent', () => {
    function validEvent() {
      return createEvent('sess-1', 'all', 'note', 'test');
    }

    it('passes for valid event', () => {
      assert.doesNotThrow(() => validateEvent(validEvent()));
    });

    it('rejects missing id', () => {
      const e = validEvent();
      delete e.id;
      assert.throws(() => validateEvent(e), /missing id/);
    });

    it('rejects empty id', () => {
      const e = validEvent();
      e.id = '';
      assert.throws(() => validateEvent(e), /missing id/);
    });

    it('rejects missing ts', () => {
      const e = validEvent();
      delete e.ts;
      assert.throws(() => validateEvent(e), /missing ts/);
    });

    it('rejects ts = 0', () => {
      const e = validEvent();
      e.ts = 0;
      assert.throws(() => validateEvent(e), /missing ts/);
    });

    it('rejects missing from', () => {
      const e = validEvent();
      delete e.from;
      assert.throws(() => validateEvent(e), /missing from/);
    });

    it('rejects missing to', () => {
      const e = validEvent();
      delete e.to;
      assert.throws(() => validateEvent(e), /missing to/);
    });

    it('rejects invalid type', () => {
      const e = validEvent();
      e.type = 'bogus';
      assert.throws(() => validateEvent(e), /Unknown event type/);
    });

    it('rejects null', () => {
      assert.throws(() => validateEvent(null), /must be an object/);
    });
  });
});
