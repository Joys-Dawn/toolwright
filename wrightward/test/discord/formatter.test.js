'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { formatEvent, CONTENT_CAP, SEVERITY_EMOJI } = require('../../discord/formatter');

describe('discord/formatter', () => {
  function ev(type, to, from, body, severity, meta) {
    return {
      type, to, from,
      body: body || '',
      severity: severity || 'info',
      meta: meta || {}
    };
  }

  describe('formatEvent action', () => {
    it('returns post_thread for note/finding/decision targeted at a session', () => {
      for (const t of ['note', 'finding', 'decision']) {
        const r = formatEvent(ev(t, 'sess-a', 'sess-b', 'hi'));
        assert.equal(r.action, 'post_thread', t + ' must mirror to thread when targeted');
        assert.equal(r.target_session_id, 'sess-a');
        assert.ok(r.content && r.content.length > 0);
      }
    });

    it('returns post_broadcast for note/finding/decision sent to "all"', () => {
      for (const t of ['note', 'finding', 'decision']) {
        const r = formatEvent(ev(t, 'all', 'sess-a', 'hi'));
        assert.equal(r.action, 'post_broadcast', t + ' to "all" promotes to broadcast');
        assert.ok(r.content && r.content.length > 0);
      }
    });

    it('returns post_thread for ack targeted at the original handoff sender', () => {
      // handleAck routes the ack event's `to` at the original sender; the
      // bridge then posts the ack into that sender's thread.
      const r = formatEvent(ev('ack', 'sess-a', 'sess-b', 'Ack: accepted'));
      assert.equal(r.action, 'post_thread');
      assert.equal(r.target_session_id, 'sess-a');
      assert.ok(r.content && r.content.length > 0);
    });

    it('returns silent for interest/rate_limited/delivery_failed (never types)', () => {
      for (const t of ['interest', 'rate_limited', 'delivery_failed']) {
        const r = formatEvent(ev(t, 'all', 'sess-a', 'x'));
        assert.equal(r.action, 'silent', t + ' must be silent');
      }
    });

    it('returns post_thread with target_session_id for handoff', () => {
      const r = formatEvent(ev('handoff', 'sess-recipient', 'sess-sender', 'do this'));
      assert.equal(r.action, 'post_thread');
      assert.equal(r.target_session_id, 'sess-recipient');
      assert.ok(r.content && r.content.length > 0);
    });

    it('returns post_broadcast for session_started', () => {
      const r = formatEvent(ev('session_started', 'all', 'sess-a', 'Session started'));
      assert.equal(r.action, 'post_broadcast');
      assert.ok(r.content && r.content.length > 0);
      assert.equal(r.target_session_id, undefined);
    });

    it('returns rename_thread with target_session_id for context_updated', () => {
      const r = formatEvent(ev('context_updated', 'all', 'sess-a', 'new task'));
      assert.equal(r.action, 'rename_thread');
      assert.equal(r.target_session_id, 'sess-a');
      assert.equal(r.content, null);
    });
  });

  describe('content formatting', () => {
    it('includes the info emoji ℹ️ for severity=info', () => {
      const r = formatEvent(ev('handoff', 'sess-a', 'sess-b', 'hi', 'info'));
      assert.ok(r.content.startsWith(SEVERITY_EMOJI.info + ' '), 'content: ' + r.content);
    });

    it('includes the warn emoji ⚠️ for blocker (policy default)', () => {
      const r = formatEvent(ev('blocker', 'sess-a', 'sess-b', 'blocked'));
      assert.ok(r.content.startsWith(SEVERITY_EMOJI.warn + ' '), 'content: ' + r.content);
    });

    it('includes the short-ID suffix (first 8 chars of from)', () => {
      const from = 'sess-abcdef1234567';
      const r = formatEvent(ev('handoff', 'sess-a', from, 'hi'));
      assert.match(r.content, /— sess-abc$/,
        'expected 8-char short-id suffix at end, got: ' + r.content);
    });

    it('includes the event type label in brackets', () => {
      const r = formatEvent(ev('handoff', 'sess-a', 'sess-b', 'hi'));
      assert.match(r.content, /\[handoff\]/);
    });

    it('preserves the event body', () => {
      const r = formatEvent(ev('handoff', 'sess-a', 'sess-b', 'please review the auth module'));
      assert.match(r.content, /please review the auth module/);
    });

    it('handles empty body without throwing', () => {
      const r = formatEvent(ev('handoff', 'sess-a', 'sess-b', ''));
      assert.ok(r.content && r.content.length > 0);
    });

    it('handles missing from gracefully (no short-ID suffix)', () => {
      const event = { type: 'handoff', to: 'sess-a', from: '', body: 'x', severity: 'info' };
      const r = formatEvent(event);
      assert.doesNotMatch(r.content, / — /);
    });
  });

  describe('truncation', () => {
    it('truncates body so total content stays under CONTENT_CAP bytes', () => {
      const longBody = 'x'.repeat(5000);
      const r = formatEvent(ev('handoff', 'sess-a', 'sess-b', longBody));
      assert.ok(Buffer.byteLength(r.content, 'utf8') <= CONTENT_CAP + 30,
        'content bytes=' + Buffer.byteLength(r.content, 'utf8') + ' exceeds cap ' + CONTENT_CAP);
    });

    it('appends … ellipsis when truncation occurred', () => {
      const longBody = 'y'.repeat(5000);
      const r = formatEvent(ev('handoff', 'sess-a', 'sess-b', longBody));
      assert.match(r.content, /…/);
    });

    it('does NOT append ellipsis when body fits entirely', () => {
      const r = formatEvent(ev('handoff', 'sess-a', 'sess-b', 'short'));
      assert.doesNotMatch(r.content, /…/);
    });

    it('closes an orphaned code fence on truncation', () => {
      // A code fence opened in the body must be closed by the formatter —
      // otherwise Discord would render the severity suffix as part of the
      // code block.
      const body = 'Here is some code:\n```python\n' + 'x'.repeat(3000);
      const r = formatEvent(ev('handoff', 'sess-a', 'sess-b', body));
      const fenceCount = (r.content.match(/```/g) || []).length;
      assert.equal(fenceCount % 2, 0,
        'truncated content must have even number of code fences, got ' + fenceCount);
    });

    it('leaves even-numbered code fences alone', () => {
      const body = 'a ```x``` b';
      const r = formatEvent(ev('handoff', 'sess-a', 'sess-b', body));
      const fences = (r.content.match(/```/g) || []).length;
      assert.equal(fences, 2);
    });

    it('does not split UTF-8 multi-byte characters on truncation', () => {
      const body = '😀'.repeat(500); // 500 × 4 bytes = 2000 bytes
      const r = formatEvent(ev('handoff', 'sess-a', 'sess-b', body));
      // Decoded content must parse back to valid JSON-serializable string
      assert.doesNotThrow(() => JSON.stringify(r.content));
      // No replacement char
      assert.doesNotMatch(r.content, /\ufffd/);
    });
  });
});
