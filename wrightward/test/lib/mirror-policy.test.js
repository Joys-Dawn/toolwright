'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_POLICY,
  HARD_RAIL_TYPES,
  MIRROR_ACTIONS,
  mergePolicy,
  decide
} = require('../../lib/mirror-policy');
const { BROADCAST_TARGETS } = require('../../lib/constants');

describe('mirror-policy', () => {
  describe('DEFAULT_POLICY', () => {
    it('covers every EVENT_TYPES member', () => {
      // If a new event type lands in bus-schema without a policy entry, decide()
      // will silently fall through to 'silent'. That is a valid default, but
      // we want the list of known types to be complete in the default policy
      // so reviewers can see (and deliberately choose) every mapping.
      const { EVENT_TYPES } = require('../../lib/bus-schema');
      for (const type of EVENT_TYPES) {
        assert.ok(DEFAULT_POLICY[type],
          `DEFAULT_POLICY missing entry for '${type}' — add an explicit mapping`);
      }
    });

    it('HARD_RAIL_TYPES match event types with action=never', () => {
      const neverTypes = Object.entries(DEFAULT_POLICY)
        .filter(([, v]) => v.action === 'never')
        .map(([k]) => k)
        .sort();
      assert.deepEqual([...HARD_RAIL_TYPES].sort(), neverTypes);
    });
  });

  describe('decide', () => {
    function ev(type, to, from, severity) {
      return { type, to, from, severity };
    }

    it('user_message → post_thread targeted at recipient', () => {
      const r = decide(ev('user_message', 'sess-A', 'sess-B'));
      assert.equal(r.action, 'post_thread');
      assert.equal(r.target_session_id, 'sess-A');
      assert.equal(r.severity, 'info');
    });

    it('handoff → post_thread targeted at recipient', () => {
      const r = decide(ev('handoff', 'sess-A', 'sess-B'));
      assert.equal(r.action, 'post_thread');
      assert.equal(r.target_session_id, 'sess-A');
    });

    it('blocker → post_thread with warn severity', () => {
      const r = decide(ev('blocker', 'sess-A', 'sess-B'));
      assert.equal(r.action, 'post_thread');
      assert.equal(r.severity, 'warn');
    });

    it('post_thread with to=all → promotes to post_broadcast', () => {
      const r = decide(ev('user_message', 'all', 'sess-B'));
      assert.equal(r.action, 'post_broadcast');
      assert.equal(r.target_session_id, undefined);
    });

    it('post_thread with array to → promotes to post_broadcast', () => {
      const r = decide(ev('handoff', ['sess-A', 'sess-C'], 'sess-B'));
      assert.equal(r.action, 'post_broadcast');
    });

    it('file_freed targeted at a session → post_thread', () => {
      const r = decide(ev('file_freed', 'sess-A', 'sess-B'));
      assert.equal(r.action, 'post_thread');
      assert.equal(r.target_session_id, 'sess-A');
    });

    it('file_freed with to=all → silent (only mirror when targeted)', () => {
      const r = decide(ev('file_freed', 'all', 'sess-B'));
      assert.equal(r.action, 'silent');
    });

    it('file_freed with array to → silent', () => {
      const r = decide(ev('file_freed', ['sess-A'], 'sess-B'));
      assert.equal(r.action, 'silent');
    });

    it('session_started → post_broadcast', () => {
      const r = decide(ev('session_started', 'all', 'sess-A'));
      assert.equal(r.action, 'post_broadcast');
    });

    it('session_ended → post_broadcast', () => {
      const r = decide(ev('session_ended', 'all', 'sess-A'));
      assert.equal(r.action, 'post_broadcast');
    });

    it('note/finding/decision → silent by default', () => {
      for (const type of ['note', 'finding', 'decision']) {
        const r = decide(ev(type, 'sess-A', 'sess-B'));
        assert.equal(r.action, 'silent', `${type} should be silent by default`);
      }
    });

    it('context_updated → rename_thread targeted at sender', () => {
      const r = decide(ev('context_updated', 'all', 'sess-A'));
      assert.equal(r.action, 'rename_thread');
      assert.equal(r.target_session_id, 'sess-A');
    });

    it('agent_message to a sessionId → post_thread targeted at recipient', () => {
      const r = decide(ev('agent_message', 'sess-A', 'sess-B'));
      assert.equal(r.action, 'post_thread');
      assert.equal(r.target_session_id, 'sess-A');
    });

    it('agent_message to "all" → post_broadcast (broadcast fallback)', () => {
      const r = decide(ev('agent_message', 'all', 'sess-A'));
      assert.equal(r.action, 'post_broadcast');
      assert.equal(r.target_session_id, undefined);
    });

    it('agent_message to "user" → post_broadcast (Discord-only reply)', () => {
      // "user" is a reserved audience that no real session matches in
      // matchesSession, so the bridge MUST fall through to the broadcast
      // channel rather than try to ensure a thread for sessionId="user".
      const r = decide(ev('agent_message', 'user', 'sess-A'));
      assert.equal(r.action, 'post_broadcast');
      assert.equal(r.target_session_id, undefined);
    });

    it('post_thread fallback respects every BROADCAST_TARGETS entry', () => {
      // Pin the contract: any string in BROADCAST_TARGETS must NOT be treated
      // as a sessionId — it has to fall through to broadcast. Adding a new
      // broadcast target without updating decide() would break this.
      for (const target of BROADCAST_TARGETS) {
        const r = decide(ev('user_message', target, 'sess-A'));
        assert.equal(r.action, 'post_broadcast',
          `target "${target}" should fall through to broadcast`);
        assert.equal(r.target_session_id, undefined);
      }
    });

    it('interest/ack/delivery_failed/rate_limited → never', () => {
      for (const type of ['interest', 'ack', 'delivery_failed', 'rate_limited']) {
        const r = decide(ev(type, 'all', 'sess-A'));
        assert.equal(r.action, 'never', `${type} should be 'never' by default`);
      }
    });

    it('unknown event type → silent (safe default)', () => {
      const r = decide(ev('unknown_future_type', 'sess-A', 'sess-B'));
      assert.equal(r.action, 'silent');
    });

    it('uses custom policy when provided', () => {
      const custom = mergePolicy({
        note: { action: 'post_broadcast', severity: 'info' }
      });
      const r = decide(ev('note', 'all', 'sess-A'), custom);
      assert.equal(r.action, 'post_broadcast');
    });
  });

  describe('mergePolicy', () => {
    it('returns a full copy of DEFAULT_POLICY when userPolicy is null', () => {
      const merged = mergePolicy(null);
      for (const type of Object.keys(DEFAULT_POLICY)) {
        assert.deepEqual(merged[type], DEFAULT_POLICY[type]);
      }
    });

    it('returns a full copy when userPolicy is undefined', () => {
      const merged = mergePolicy();
      assert.deepEqual(merged.note, DEFAULT_POLICY.note);
    });

    it('does not mutate DEFAULT_POLICY', () => {
      const merged = mergePolicy({ note: { action: 'post_broadcast' } });
      assert.equal(merged.note.action, 'post_broadcast');
      assert.equal(DEFAULT_POLICY.note.action, 'silent', 'DEFAULT_POLICY must stay pristine');
    });

    it('overrides action for non-rail types', () => {
      const merged = mergePolicy({ note: { action: 'post_broadcast', severity: 'info' } });
      assert.equal(merged.note.action, 'post_broadcast');
    });

    it('preserves default severity when override omits it', () => {
      const merged = mergePolicy({ blocker: { action: 'post_broadcast' } });
      assert.equal(merged.blocker.action, 'post_broadcast');
      assert.equal(merged.blocker.severity, 'warn', 'severity should inherit from default');
    });

    it('overrides severity when specified', () => {
      const merged = mergePolicy({ note: { severity: 'warn' } });
      assert.equal(merged.note.severity, 'warn');
    });

    it('HARD RAIL: interest cannot be elevated to post_broadcast', () => {
      const merged = mergePolicy({ interest: { action: 'post_broadcast', severity: 'info' } });
      assert.equal(merged.interest.action, 'never',
        'user override to post_broadcast must be discarded for interest');
    });

    it('HARD RAIL: ack cannot be elevated to post_thread', () => {
      const merged = mergePolicy({ ack: { action: 'post_thread' } });
      assert.equal(merged.ack.action, 'never');
    });

    it('HARD RAIL: delivery_failed cannot be elevated', () => {
      const merged = mergePolicy({ delivery_failed: { action: 'post_broadcast' } });
      assert.equal(merged.delivery_failed.action, 'never');
    });

    it('HARD RAIL: rate_limited cannot be elevated', () => {
      const merged = mergePolicy({ rate_limited: { action: 'post_broadcast' } });
      assert.equal(merged.rate_limited.action, 'never');
    });

    it('HARD RAIL: interest CAN be demoted to silent (effectively no-op)', () => {
      const merged = mergePolicy({ interest: { action: 'silent' } });
      assert.equal(merged.interest.action, 'silent');
    });

    it('ignores invalid action values (default wins)', () => {
      const merged = mergePolicy({ note: { action: 'bogus_action' } });
      assert.equal(merged.note.action, 'silent', 'invalid action must fall back to default');
    });

    it('ignores non-object overrides', () => {
      const merged = mergePolicy({ note: 'not an object' });
      assert.equal(merged.note.action, 'silent');
    });

    it('ignores array override body', () => {
      const merged = mergePolicy({ note: ['post_broadcast'] });
      assert.equal(merged.note.action, 'silent');
    });

    it('ignores array-shaped userPolicy entirely', () => {
      const merged = mergePolicy(['invalid']);
      assert.deepEqual(merged.note, DEFAULT_POLICY.note);
    });

    it('allows opting into mirroring for a new user-defined event type', () => {
      // Users can pre-configure types that the bridge doesn't know yet.
      const merged = mergePolicy({ custom_event: { action: 'post_broadcast', severity: 'info' } });
      assert.equal(merged.custom_event.action, 'post_broadcast');
    });
  });
});
