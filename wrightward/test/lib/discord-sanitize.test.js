'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { redactTokens, clampUtf8, parseMentions } = require('../../lib/discord-sanitize');

// A fake but syntactically valid bot token (3 segments, proper lengths).
// Never use a real token in tests — if a regex change starts matching more
// narrowly we want to notice, and real tokens are secrets.
const FAKE_TOKEN = 'MTExMTExMTExMTExMTExMTEx.XxXxXx.abcdefghijklmnopqrstuvwxyz_';

describe('discord-sanitize', () => {
  describe('redactTokens', () => {
    it('returns non-string input unchanged', () => {
      assert.equal(redactTokens(null), null);
      assert.equal(redactTokens(undefined), undefined);
      assert.equal(redactTokens(42), 42);
      assert.deepEqual(redactTokens({ x: 1 }), { x: 1 });
    });

    it('returns empty string unchanged', () => {
      assert.equal(redactTokens(''), '');
    });

    it('redacts a bare bot token', () => {
      const out = redactTokens(`token=${FAKE_TOKEN} after`);
      assert.doesNotMatch(out, /MTExMTE/);
      assert.match(out, /\[REDACTED\]/);
    });

    it('redacts Bot <token> header form, preserving `Bot` prefix', () => {
      const out = redactTokens(`Authorization: Bot ${FAKE_TOKEN}`);
      assert.doesNotMatch(out, /MTExMTE/);
      assert.match(out, /Bot \[REDACTED\]/);
    });

    it('redacts Bot <token> with extra whitespace', () => {
      const out = redactTokens(`Bot    ${FAKE_TOKEN}`);
      assert.match(out, /Bot \[REDACTED\]/);
    });

    it('redacts Bot <token> with newline whitespace', () => {
      const out = redactTokens(`Bot\n${FAKE_TOKEN}`);
      assert.match(out, /Bot \[REDACTED\]/);
    });

    it('redacts multiple tokens in one string', () => {
      const out = redactTokens(`t1=${FAKE_TOKEN} t2=${FAKE_TOKEN}`);
      assert.equal(out.match(/\[REDACTED\]/g).length, 2);
    });

    it('does not redact random dotted strings that are too short', () => {
      // '.' -separated but segments too short — must stay untouched, otherwise
      // we'd scrub ordinary filenames and IPs.
      const out = redactTokens('foo.bar.baz');
      assert.equal(out, 'foo.bar.baz');
    });

    it('does not redact version numbers', () => {
      assert.equal(redactTokens('v1.2.3-alpha'), 'v1.2.3-alpha');
    });

    it('redacts canary.discord.com webhook URLs', () => {
      const url = 'https://canary.discord.com/api/webhooks/123456789/secrettoken_abcdef';
      const out = redactTokens(`See ${url}`);
      assert.doesNotMatch(out, /secrettoken/);
      assert.match(out, /\[REDACTED\]/);
    });

    it('redacts ptb.discord.com webhook URLs', () => {
      const url = 'https://ptb.discord.com/api/webhooks/123/abc_-';
      assert.match(redactTokens(url), /\[REDACTED\]/);
    });

    it('redacts legacy discordapp.com webhook URLs', () => {
      const url = 'https://discordapp.com/api/webhooks/123/abctok';
      assert.match(redactTokens(url), /\[REDACTED\]/);
    });

    it('redacts versioned /api/vN/webhooks/... URLs', () => {
      const url = 'https://discord.com/api/v10/webhooks/999/tok_def';
      assert.match(redactTokens(url), /\[REDACTED\]/);
    });

    it('does not redact non-webhook discord.com URLs', () => {
      const out = redactTokens('Visit https://discord.com/invite/abc123 for info');
      assert.match(out, /discord\.com\/invite/);
    });
  });

  describe('clampUtf8', () => {
    it('returns empty string for maxBytes <= 0', () => {
      assert.equal(clampUtf8('hello', 0), '');
      assert.equal(clampUtf8('hello', -1), '');
    });

    it('returns non-string input unchanged', () => {
      assert.equal(clampUtf8(null, 100), null);
      assert.equal(clampUtf8(42, 100), 42);
    });

    it('returns string unchanged when under limit', () => {
      assert.equal(clampUtf8('hello', 100), 'hello');
    });

    it('truncates ASCII at exact byte count', () => {
      assert.equal(clampUtf8('abcdefg', 4), 'abcd');
    });

    it('does not split 2-byte UTF-8 character (é = c3 a9)', () => {
      // 'é' is 2 bytes. Cut at 1 byte → empty (can't fit); cut at 2 → 'é'.
      assert.equal(clampUtf8('é', 1), '');
      assert.equal(clampUtf8('é', 2), 'é');
    });

    it('does not split 3-byte UTF-8 character (한 = 3 bytes)', () => {
      assert.equal(clampUtf8('한', 1), '');
      assert.equal(clampUtf8('한', 2), '');
      assert.equal(clampUtf8('한', 3), '한');
    });

    it('does not split 4-byte UTF-8 character (😀 = 4 bytes)', () => {
      assert.equal(clampUtf8('😀', 1), '');
      assert.equal(clampUtf8('😀', 3), '');
      assert.equal(clampUtf8('😀', 4), '😀');
    });

    it('keeps earlier chars when cut lands inside later multi-byte char', () => {
      // 'A😀' = 0x41 + 4 bytes = 5 bytes total. Cut at 3 → just 'A'.
      assert.equal(clampUtf8('A😀', 3), 'A');
      assert.equal(clampUtf8('A😀', 5), 'A😀');
    });

    it('preserves surrogate pair as a single grapheme when it fits', () => {
      const s = 'Hi 😀 world';
      // Byte length: 'Hi ' (3) + '😀' (4) + ' world' (6) = 13
      assert.equal(Buffer.byteLength(s, 'utf8'), 13);
      assert.equal(clampUtf8(s, 13), s);
      assert.equal(clampUtf8(s, 7), 'Hi 😀');
    });
  });

  describe('parseMentions', () => {
    const roster = {
      'sess-abc12345': {},
      'sess-def67890': {},
      'sess-abc12346': {} // same short-ID prefix as sess-abc12345 → ambiguous short
    };

    it('returns empty mentions and empty stripped for empty content', () => {
      const r = parseMentions('', roster);
      assert.deepEqual(r.mentions, []);
      assert.equal(r.stripped, '');
      assert.equal(r.ambiguous, false);
    });

    it('returns empty mentions for non-string content', () => {
      const r = parseMentions(null, roster);
      assert.deepEqual(r.mentions, []);
    });

    it('returns empty mentions when no @agent- mentions present', () => {
      const r = parseMentions('just a regular message', roster);
      assert.deepEqual(r.mentions, []);
      assert.equal(r.stripped, 'just a regular message');
      assert.equal(r.ambiguous, false);
    });

    it('matches full session ID in @agent-<sessionId>', () => {
      const r = parseMentions('@agent-sess-def67890 please review', roster);
      assert.deepEqual(r.mentions, ['sess-def67890']);
      assert.equal(r.stripped, 'please review');
    });

    it('matches a short-ID (first 8 chars) when unambiguous', () => {
      const r = parseMentions('@agent-sess-def please', { 'sess-def67890': {} });
      // 'sess-def' is 8 chars — first 8 of 'sess-def67890'. Short-ID match.
      assert.deepEqual(r.mentions, ['sess-def67890']);
    });

    it('routes ambiguous short-ID to "all" with ambiguous=true', () => {
      // 'sess-abc' is the 8-char prefix of both sess-abc12345 and sess-abc12346.
      const r = parseMentions('@agent-sess-abc help', roster);
      assert.deepEqual(r.mentions, ['all']);
      assert.equal(r.ambiguous, true);
    });

    it('full-ID match resolves to single session without ambiguity', () => {
      // Full-ID mentions never trigger ambiguity — even when the roster has
      // short-ID collisions among other sessions. Fan-out only comes from
      // resolving multiple *distinct* mentions.
      const r = parseMentions('@agent-sess-abc12345', roster);
      assert.deepEqual(r.mentions, ['sess-abc12345']);
      assert.equal(r.ambiguous, false);
    });

    it('drops ambiguous "all" when a sibling concrete mention also resolved', () => {
      // Respects user intent: if the message contains at least one
      // unambiguous full-ID mention, a sibling ambiguous short-ID must NOT
      // broadcast to everyone (which would dilute the targeted intent). The
      // `ambiguous` flag still fires so callers can surface a "did you mean?"
      // warning alongside the targeted delivery.
      const r = parseMentions('@agent-sess-abc then @agent-sess-def67890', roster);
      assert.deepEqual(r.mentions, ['sess-def67890']);
      assert.equal(r.ambiguous, true);
    });

    it('keeps "all" when the only mention is ambiguous (no concrete sibling)', () => {
      // Still broadcast when the user gave us nothing more specific to work
      // with — the ambiguous short-ID is the only signal, so broadcasting is
      // the safest fallback.
      const r = parseMentions('@agent-sess-abc please', roster);
      assert.deepEqual(r.mentions, ['all']);
      assert.equal(r.ambiguous, true);
    });

    it('drops ambiguous "all" when a concrete short-ID mention also resolved', () => {
      // Symmetry: both full-ID and unambiguous short-ID count as "concrete"
      // for the drop-`all` rule. Here `sess-def` is a unique short-ID that
      // resolves to sess-def67890; the ambiguous `sess-abc` sibling should
      // not override it with a broadcast.
      const r = parseMentions('@agent-sess-abc and @agent-sess-def', roster);
      assert.deepEqual(r.mentions, ['sess-def67890']);
      assert.equal(r.ambiguous, true);
    });

    it('drops mentions that match no roster entry', () => {
      const r = parseMentions('@agent-unknown hello', roster);
      assert.deepEqual(r.mentions, []);
      assert.equal(r.stripped, 'hello');
    });

    it('strips all @agent- tokens and returns every resolved target', () => {
      const r = parseMentions('@agent-sess-def67890 fix @agent-sess-abc12345 now', roster);
      assert.doesNotMatch(r.stripped, /@agent-/);
      assert.equal(r.stripped, 'fix now');
      // Fan-out preserves message order.
      assert.deepEqual(r.mentions, ['sess-def67890', 'sess-abc12345']);
    });

    it('matches free-text @agent-<id> even inside <...> brackets', () => {
      // The bracket form is Discord's own snowflake-mention shape. We don't
      // adopt that syntax for agent routing — but our free-text regex still
      // picks up the `@agent-<id>` substring inside brackets. What matters is
      // that we never route `<@<numeric>>` (that test follows).
      const r = parseMentions('<@agent-sess-def67890> hi', roster);
      assert.deepEqual(r.mentions, ['sess-def67890']);
    });

    it('ignores <@12345> pure numeric Discord mentions', () => {
      const r = parseMentions('<@1234567890> hello', roster);
      assert.deepEqual(r.mentions, []);
    });

    it('handles null/undefined agentRoster gracefully', () => {
      assert.doesNotThrow(() => parseMentions('@agent-x hi', null));
      const r = parseMentions('@agent-x hi', null);
      assert.deepEqual(r.mentions, []);
    });

    it('collapses extra whitespace left behind after stripping mentions', () => {
      const r = parseMentions('hello @agent-sess-def67890    how are you', roster);
      assert.equal(r.stripped, 'hello how are you');
    });

    // Test #14 from plan.
    it('returns every mention in message order when short-IDs do not collide', () => {
      const roster2 = {
        'sess-aaaaaaaa': {},
        'sess-bbbbbbbb': {}
      };
      const r = parseMentions('@agent-sess-aaa and @agent-sess-bbb', roster2);
      assert.deepEqual(r.mentions, ['sess-aaaaaaaa', 'sess-bbbbbbbb']);
    });

    // Test #15 from plan.
    it('dedupes the same session mentioned multiple times', () => {
      const r = parseMentions('@agent-sess-def67890 @agent-sess-def67890 done', roster);
      assert.deepEqual(r.mentions, ['sess-def67890']);
    });

    // Test #16 from plan (explicit empty-mentions ambiguous=false).
    it('returns ambiguous=false when no mention resolved', () => {
      const r = parseMentions('plain text', roster);
      assert.deepEqual(r.mentions, []);
      assert.equal(r.ambiguous, false);
    });

    it('keeps ambiguous=false if only full-ID mentions are present', () => {
      // Pin: ambiguity is per-mention and must only latch when an actual
      // short-ID collision fires. Multiple clean full-ID mentions do not
      // count as ambiguous even when the roster has unrelated collisions.
      const r = parseMentions('@agent-sess-abc12345 and @agent-sess-def67890', roster);
      assert.deepEqual(r.mentions, ['sess-abc12345', 'sess-def67890']);
      assert.equal(r.ambiguous, false);
    });
  });
});
