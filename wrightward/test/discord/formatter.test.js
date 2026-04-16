'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  formatEvent,
  splitIntoChunks,
  CONTENT_CAP,
  SEVERITY_EMOJI
} = require('../../discord/formatter');
const { deriveHandle } = require('../../lib/handles');

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
        assert.equal(r.contents.length, 1);
        assert.ok(r.contents[0].length > 0);
      }
    });

    it('returns post_broadcast for note/finding/decision sent to "all"', () => {
      for (const t of ['note', 'finding', 'decision']) {
        const r = formatEvent(ev(t, 'all', 'sess-a', 'hi'));
        assert.equal(r.action, 'post_broadcast', t + ' to "all" promotes to broadcast');
        assert.equal(r.contents.length, 1);
        assert.ok(r.contents[0].length > 0);
      }
    });

    it('returns post_thread for ack targeted at the original handoff sender', () => {
      const r = formatEvent(ev('ack', 'sess-a', 'sess-b', 'Ack: accepted'));
      assert.equal(r.action, 'post_thread');
      assert.equal(r.target_session_id, 'sess-a');
      assert.equal(r.contents.length, 1);
    });

    it('returns silent with empty contents for never types', () => {
      for (const t of ['interest', 'rate_limited', 'delivery_failed']) {
        const r = formatEvent(ev(t, 'all', 'sess-a', 'x'));
        assert.equal(r.action, 'silent', t + ' must be silent');
        assert.deepEqual(r.contents, []);
      }
    });

    it('returns post_thread with target_session_id for handoff', () => {
      const r = formatEvent(ev('handoff', 'sess-recipient', 'sess-sender', 'do this'));
      assert.equal(r.action, 'post_thread');
      assert.equal(r.target_session_id, 'sess-recipient');
      assert.equal(r.contents.length, 1);
    });

    it('returns post_broadcast for session_started', () => {
      const r = formatEvent(ev('session_started', 'all', 'sess-a', 'Session started'));
      assert.equal(r.action, 'post_broadcast');
      assert.equal(r.contents.length, 1);
      assert.equal(r.target_session_id, undefined);
    });

    it('returns rename_thread with empty contents and target_session_id', () => {
      const r = formatEvent(ev('context_updated', 'all', 'sess-a', 'new task'));
      assert.equal(r.action, 'rename_thread');
      assert.equal(r.target_session_id, 'sess-a');
      assert.deepEqual(r.contents, [], 'rename_thread posts no content — threads.renameThread handles the PATCH');
    });
  });

  describe('content formatting — sender badge at TOP', () => {
    it('starts with severity emoji + space + bold handle', () => {
      const from = '5ff83f6e-7de7-45bb-b53c-6084c3c3c514';
      const r = formatEvent(ev('handoff', 'sess-a', from, 'hi'));
      const expectedHandle = deriveHandle(from);
      assert.ok(r.contents[0].startsWith(SEVERITY_EMOJI.info + ' **' + expectedHandle + '**'),
        'content: ' + r.contents[0]);
    });

    it('uses a handle passed via roster instead of deriving', () => {
      const from = '5ff83f6e-7de7-45bb-b53c-6084c3c3c514';
      const roster = { [from]: { handle: 'bob-42' } };
      const r = formatEvent(ev('handoff', 'sess-a', from, 'hi'), undefined, roster);
      assert.ok(r.contents[0].startsWith(SEVERITY_EMOJI.info + ' **bob-42**'),
        'content: ' + r.contents[0]);
    });

    it('renders **system** for missing/synthetic sender', () => {
      const event = { type: 'handoff', to: 'sess-a', from: '', body: 'x',
        severity: 'info', meta: {} };
      const r = formatEvent(event);
      assert.match(r.contents[0], /\*\*system\*\*/);
      assert.doesNotMatch(r.contents[0], / — /);
    });

    it('renders **system** for wrightward:runtime synthetic sender', () => {
      const r = formatEvent(ev('handoff', 'sess-a', 'wrightward:runtime', 'synthetic'));
      assert.match(r.contents[0], /\*\*system\*\*/);
    });

    it('renders **system** for __bridge__ sender (bridge-originated events)', () => {
      const r = formatEvent(ev('handoff', 'sess-a', '__bridge__', 'bridge notice'));
      assert.match(r.contents[0], /\*\*system\*\*/);
      assert.doesNotMatch(r.contents[0], /\*\*[a-z]+-\d+\*\*/,
        'must not render a derived handle for reserved synthetic senders');
    });

    it('no tail short-ID suffix (new layout puts badge at TOP)', () => {
      const from = '5ff83f6e-7de7-45bb-b53c-6084c3c3c514';
      const r = formatEvent(ev('handoff', 'sess-a', from, 'hi'));
      assert.doesNotMatch(r.contents[0], / — /);
    });

    it('includes the info emoji ℹ️ for severity=info', () => {
      const r = formatEvent(ev('handoff', 'sess-a', 'sess-b', 'hi', 'info'));
      assert.ok(r.contents[0].startsWith(SEVERITY_EMOJI.info + ' '));
    });

    it('includes the warn emoji ⚠️ for blocker (policy default)', () => {
      const r = formatEvent(ev('blocker', 'sess-a', 'sess-b', 'blocked'));
      assert.ok(r.contents[0].startsWith(SEVERITY_EMOJI.warn + ' '));
    });

    it('includes the event type label in brackets', () => {
      const r = formatEvent(ev('handoff', 'sess-a', 'sess-b', 'hi'));
      assert.match(r.contents[0], /\[handoff\]/);
    });

    it('preserves the event body', () => {
      const r = formatEvent(ev('handoff', 'sess-a', 'sess-b', 'please review the auth module'));
      assert.match(r.contents[0], /please review the auth module/);
    });

    it('handles empty body without throwing', () => {
      const r = formatEvent(ev('handoff', 'sess-a', 'sess-b', ''));
      assert.equal(r.contents.length, 1);
      assert.ok(r.contents[0].length > 0);
    });
  });

  describe('chunking — multi-message behavior for long bodies', () => {
    // Every chunk must stay within Discord's hard 2000-byte message cap.
    // CONTENT_CAP (1800) leaves headroom for synthetic code-fence close
    // and language-tag reopen on the next chunk.
    const DISCORD_HARD_CAP = 2000;

    it('body below cap produces exactly one chunk (fast path)', () => {
      const r = formatEvent(ev('handoff', 'sess-a', 'sess-b', 'short enough'));
      assert.equal(r.contents.length, 1);
      // No continuation marker should appear anywhere.
      assert.doesNotMatch(r.contents[0], /↳/);
    });

    it('body at the cap threshold stays in one chunk', () => {
      // Precise boundary: whatever fits under CONTENT_CAP after adding the
      // first prefix is one chunk; anything larger goes multi-chunk.
      const bodyLen = Math.max(1, CONTENT_CAP - 100); // leave ample prefix room
      const body = 'x'.repeat(bodyLen);
      const r = formatEvent(ev('handoff', 'sess-a', 'sess-b', body));
      assert.equal(r.contents.length, 1,
        'body of ' + bodyLen + ' bytes should still fit in one chunk');
    });

    it('body 2× cap produces at least 2 chunks', () => {
      const body = 'x'.repeat(CONTENT_CAP * 2);
      const r = formatEvent(ev('handoff', 'sess-a', 'sess-b', body));
      assert.ok(r.contents.length >= 2,
        'expected ≥2 chunks for 2× cap body, got ' + r.contents.length);
    });

    it('body 3× cap produces at least 3 chunks', () => {
      const body = 'x'.repeat(CONTENT_CAP * 3);
      const r = formatEvent(ev('handoff', 'sess-a', 'sess-b', body));
      assert.ok(r.contents.length >= 3,
        'expected ≥3 chunks for 3× cap body, got ' + r.contents.length);
    });

    it('every chunk stays under Discord hard cap (2000 bytes)', () => {
      const body = 'z'.repeat(CONTENT_CAP * 3 + 77);
      const r = formatEvent(ev('handoff', 'sess-a', 'sess-b', body));
      for (let i = 0; i < r.contents.length; i++) {
        const len = Buffer.byteLength(r.contents[i], 'utf8');
        assert.ok(len <= DISCORD_HARD_CAP,
          'chunk ' + i + ' is ' + len + ' bytes, exceeds Discord hard cap ' + DISCORD_HARD_CAP);
      }
    });

    it('first chunk starts with full prefix (emoji + handle + type)', () => {
      const from = '5ff83f6e-7de7-45bb-b53c-6084c3c3c514';
      const handle = deriveHandle(from);
      const body = 'q'.repeat(CONTENT_CAP * 2);
      const r = formatEvent(ev('handoff', 'sess-a', from, body));
      assert.ok(r.contents[0].startsWith(SEVERITY_EMOJI.info + ' **' + handle + '** [handoff]'),
        'first chunk prefix: ' + r.contents[0].slice(0, 60));
    });

    it('continuation chunks start with ↳ + handle + (n/N) marker', () => {
      const from = '5ff83f6e-7de7-45bb-b53c-6084c3c3c514';
      const handle = deriveHandle(from);
      const body = 'q'.repeat(CONTENT_CAP * 3);
      const r = formatEvent(ev('handoff', 'sess-a', from, body));
      const total = r.contents.length;
      for (let i = 1; i < total; i++) {
        // (i+1/total) — i is zero-indexed, marker is 1-indexed
        const expected = '↳ **' + handle + '** (' + (i + 1) + '/' + total + ')';
        assert.ok(r.contents[i].startsWith(expected),
          'chunk ' + i + ' should start with "' + expected + '", got: ' + r.contents[i].slice(0, 60));
      }
    });

    it('handle is present on every chunk (survives any scroll position)', () => {
      // Regression guard: the whole point of moving the badge to the top is
      // that a user who scrolls mid-stream can still see who sent a chunk.
      const from = '5ff83f6e-7de7-45bb-b53c-6084c3c3c514';
      const handle = deriveHandle(from);
      const body = 'z'.repeat(CONTENT_CAP * 3);
      const r = formatEvent(ev('handoff', 'sess-a', from, body));
      for (let i = 0; i < r.contents.length; i++) {
        assert.ok(r.contents[i].includes('**' + handle + '**'),
          'chunk ' + i + ' missing handle: ' + r.contents[i].slice(0, 80));
      }
    });

    it('no content is silently lost — body slices reconstruct original', () => {
      // Strip each chunk's prefix and concatenate the bodies: result must
      // equal the original body. Detects any silent truncation in the
      // chunking loop.
      const from = '5ff83f6e-7de7-45bb-b53c-6084c3c3c514';
      const handle = deriveHandle(from);
      const original = 'abcdefghij'.repeat(700); // 7000 bytes, forces ~4 chunks
      const r = formatEvent(ev('handoff', 'sess-a', from, original));

      let reconstructed = '';
      for (let i = 0; i < r.contents.length; i++) {
        let chunk = r.contents[i];
        if (i === 0) {
          // Strip `ℹ️ **handle** [handoff] ` prefix
          const prefix = SEVERITY_EMOJI.info + ' **' + handle + '** [handoff] ';
          assert.ok(chunk.startsWith(prefix));
          chunk = chunk.slice(prefix.length);
        } else {
          // Strip `↳ **handle** (n/N) ` prefix
          const m = chunk.match(/^↳ \*\*[a-z]+-\d+\*\* \(\d+\/\d+\) /);
          assert.ok(m, 'chunk ' + i + ' missing continuation prefix');
          chunk = chunk.slice(m[0].length);
        }
        reconstructed += chunk;
      }
      assert.equal(reconstructed, original,
        'reconstructed body (' + reconstructed.length + ' bytes) does not match original (' +
        original.length + ' bytes)');
    });

    it('every chunk has an even number of code fences (balanced)', () => {
      // A ```python block spanning a chunk boundary must be closed at end of
      // chunk K and reopened at start of chunk K+1. Otherwise Discord renders
      // half a code block as ordinary text.
      const body = 'Here is code:\n```python\n' + 'x = 1\n'.repeat(500) + '```\nEnd.';
      const r = formatEvent(ev('handoff', 'sess-a', 'sess-b', body));
      for (let i = 0; i < r.contents.length; i++) {
        const fences = (r.contents[i].match(/```/g) || []).length;
        assert.equal(fences % 2, 0,
          'chunk ' + i + ' has ' + fences + ' fences (odd — unbalanced)');
      }
    });

    it('mid-split continuation inherits the language tag', () => {
      // If a python fence opens in chunk 1 and doesn't close before the split,
      // chunk 2 should reopen with ```python so the code highlighting persists.
      const body = '```python\n' + '# line\n'.repeat(600);
      const r = formatEvent(ev('handoff', 'sess-a', 'sess-b', body));
      assert.ok(r.contents.length >= 2, 'expected multi-chunk');
      // Chunk 2 should contain a reopened ```python fence early on.
      const chunk2Head = r.contents[1].slice(0, 200);
      assert.match(chunk2Head, /```python/,
        'chunk 2 should reopen the python fence near its start: ' + chunk2Head);
    });

    it('does not split UTF-8 multi-byte characters across chunks', () => {
      // 4-byte emoji repeated — cuts at a byte budget could land mid-codepoint.
      const body = '😀'.repeat(800);
      const r = formatEvent(ev('handoff', 'sess-a', 'sess-b', body));
      assert.ok(r.contents.length >= 2);
      for (let i = 0; i < r.contents.length; i++) {
        assert.doesNotThrow(() => JSON.stringify(r.contents[i]));
        assert.doesNotMatch(r.contents[i], /\ufffd/,
          'chunk ' + i + ' contains replacement char (UTF-8 split)');
      }
    });

    it('preserves even-numbered fences (no unnecessary rebalancing)', () => {
      const body = 'a ```x``` b';
      const r = formatEvent(ev('handoff', 'sess-a', 'sess-b', body));
      const fences = (r.contents[0].match(/```/g) || []).length;
      assert.equal(fences, 2);
    });
  });

  describe('splitIntoChunks — direct helper tests', () => {
    // The pure helper is exposed so the chunking logic can be verified in
    // isolation, without the bus-event machinery on top.
    it('empty body → single chunk with prefix only', () => {
      const chunks = splitIntoChunks('', 'PRE ', (n, t) => '↳ (' + n + '/' + t + ') ', 100);
      assert.equal(chunks.length, 1);
      assert.equal(chunks[0].trim(), 'PRE');
    });

    it('body fits in budget → single chunk, fast path', () => {
      const chunks = splitIntoChunks('hello', 'PRE ', (n, t) => '↳ (' + n + '/' + t + ') ', 100);
      assert.equal(chunks.length, 1);
      assert.equal(chunks[0], 'PRE hello');
    });

    it('closes orphan fence on fast path', () => {
      const chunks = splitIntoChunks('```python\ncode', 'PRE ', (n, t) => '', 100);
      assert.equal(chunks.length, 1);
      const fences = (chunks[0].match(/```/g) || []).length;
      assert.equal(fences % 2, 0);
    });

    it('splits body into N chunks when over budget', () => {
      const body = 'abcdefghij'.repeat(30); // 300 bytes
      const chunks = splitIntoChunks(body, 'PRE ', (n, t) => '↳ (' + n + '/' + t + ') ', 100);
      assert.ok(chunks.length >= 3, 'expected ≥3 chunks for 300b body with cap=100');
      // Every chunk under cap + fence-close overhead (6 bytes).
      for (const c of chunks) {
        assert.ok(Buffer.byteLength(c, 'utf8') <= 100 + 6,
          'chunk bytes ' + Buffer.byteLength(c, 'utf8') + ' exceeds cap');
      }
    });

    it('pathological prefix > cap: still makes progress (no infinite loop)', () => {
      // Safety branch for the degenerate case where the reserved prefix
      // alone already exceeds the per-message cap. The helper must not spin
      // — it emits a minimal slice per iteration so the loop terminates.
      const longPrefix = 'P'.repeat(60); // prefix alone > cap=50
      const body = 'abcdefghij'.repeat(10); // 100 bytes
      const chunks = splitIntoChunks(body, longPrefix, (n, t) => 'C ', 50);
      // Must terminate with some chunks, not loop forever.
      assert.ok(chunks.length > 0);
      assert.ok(chunks.length <= 99,
        'emergency branch must respect MAX_CHUNKS bound');
    });

    it('pathological MAX_CHUNKS safety: caps chunk count at 99 with ellipsis', () => {
      // Body big enough to exceed 99 chunks at cap=50 → truncate at final.
      const body = 'x'.repeat(50 * 150); // 7500 bytes with cap=50 ≈ 150 chunks
      const chunks = splitIntoChunks(body, 'P ', (n, t) => '↳(' + n + '/' + t + ') ', 50);
      assert.ok(chunks.length <= 99,
        'chunk count must be bounded by MAX_CHUNKS, got ' + chunks.length);
      assert.match(chunks[chunks.length - 1], /…$/,
        'truncated final chunk must end in ellipsis');
    });
  });
});
