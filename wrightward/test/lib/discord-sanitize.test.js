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
    // Roster uses explicit handles. `bob-42` and `bob-99` share the name
    // `bob` so `@agent-bob` is an ambiguous name-only mention.
    const roster = {
      'sess-alice': { handle: 'alice-1' },
      'sess-bob': { handle: 'bob-42' },
      'sess-bob2': { handle: 'bob-99' }
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

    it('drops ambiguous "all" when a sibling concrete mention also resolved', () => {
      // Respects user intent: if the message contains at least one concrete
      // handle mention, a sibling ambiguous name-only mention must NOT
      // broadcast to everyone (which would dilute the targeted intent). The
      // `ambiguous` flag still fires so callers can surface a "did you mean?"
      // warning alongside the targeted delivery.
      const r = parseMentions('@agent-bob then @agent-alice-1', roster);
      assert.deepEqual(r.mentions, ['sess-alice']);
      assert.equal(r.ambiguous, true);
    });

    it('keeps "all" when the only mention is ambiguous (no concrete sibling)', () => {
      // Still broadcast when the user gave us nothing more specific to work
      // with — the ambiguous name is the only signal, so broadcasting is
      // the safest fallback.
      const r = parseMentions('@agent-bob please', roster);
      assert.deepEqual(r.mentions, ['all']);
      assert.equal(r.ambiguous, true);
    });

    it('drops mentions that match no roster entry', () => {
      const r = parseMentions('@agent-unknown-99 hello', roster);
      assert.deepEqual(r.mentions, []);
      assert.equal(r.stripped, 'hello');
    });

    it('strips all @agent- tokens and returns every resolved target', () => {
      const r = parseMentions('@agent-bob-42 fix @agent-alice-1 now', roster);
      assert.doesNotMatch(r.stripped, /@agent-/);
      assert.equal(r.stripped, 'fix now');
      // Fan-out preserves message order.
      assert.deepEqual(r.mentions, ['sess-bob', 'sess-alice']);
    });

    it('matches free-text @agent-<id> even inside <...> brackets', () => {
      // The bracket form is Discord's own snowflake-mention shape. We don't
      // adopt that syntax for agent routing — but our free-text regex still
      // picks up the `@agent-<id>` substring inside brackets. What matters is
      // that we never route `<@<numeric>>` (that test follows).
      const r = parseMentions('<@agent-alice-1> hi', roster);
      assert.deepEqual(r.mentions, ['sess-alice']);
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
      const r = parseMentions('hello @agent-alice-1    how are you', roster);
      assert.equal(r.stripped, 'hello how are you');
    });

    it('returns every mention in message order across multiple unambiguous handles', () => {
      const r = parseMentions('@agent-bob-42 and @agent-alice-1', roster);
      assert.deepEqual(r.mentions, ['sess-bob', 'sess-alice']);
    });

    it('dedupes the same session mentioned multiple times', () => {
      const r = parseMentions('@agent-alice-1 @agent-alice-1 done', roster);
      assert.deepEqual(r.mentions, ['sess-alice']);
    });

    // Test #16 from plan (explicit empty-mentions ambiguous=false).
    it('returns ambiguous=false when no mention resolved', () => {
      const r = parseMentions('plain text', roster);
      assert.deepEqual(r.mentions, []);
      assert.equal(r.ambiguous, false);
    });

    it('keeps ambiguous=false when only full-handle mentions are present', () => {
      // Pin: ambiguity is per-mention and must only latch when a name-only
      // collision fires. Multiple clean full-handle mentions do not count
      // as ambiguous even when the roster has siblings sharing a name.
      const r = parseMentions('@agent-bob-42 and @agent-alice-1', roster);
      assert.deepEqual(r.mentions, ['sess-bob', 'sess-alice']);
      assert.equal(r.ambiguous, false);
    });

    it('resolves literal @agent-all to the broadcast target without ambiguity', () => {
      // The explicit broadcast syntax is the user saying "send this to
      // every registered agent". Unlike the ambiguous-short-ID fallback
      // (which also emits `'all'`), this is deliberate intent — so
      // `ambiguous` must stay false.
      const r = parseMentions('@agent-all please stand by', roster);
      assert.deepEqual(r.mentions, ['all']);
      assert.equal(r.ambiguous, false);
      assert.equal(r.stripped, 'please stand by');
    });

    it('preserves @agent-all alongside concrete mentions (explicit intent not filtered)', () => {
      // The concrete-sibling filter exists to drop `'all'` contributed by
      // an ambiguous name-only mention when the user also addressed someone
      // specific. An explicit `@agent-all` is not ambiguity — it is the
      // user asking to broadcast AND to call out a specific session. Keep both.
      const r = parseMentions('@agent-all and @agent-alice-1 heads up', roster);
      assert.deepEqual(r.mentions, ['all', 'sess-alice']);
      assert.equal(r.ambiguous, false);
    });

    it('dedupes repeated @agent-all tokens in a single message', () => {
      const r = parseMentions('@agent-all @agent-all done', roster);
      assert.deepEqual(r.mentions, ['all']);
      assert.equal(r.ambiguous, false);
    });

    it('strips @agent-all from the message body like any other mention', () => {
      const r = parseMentions('hello @agent-all world', roster);
      assert.equal(r.stripped, 'hello world');
    });

    it('@agent-all coexists with an ambiguous name-only mention: ambiguous=true, broadcast preserved', () => {
      // An explicit broadcast already sets `'all'`. A sibling ambiguous
      // name-only mention does not add a duplicate (pushOnce guard) but
      // still flips the ambiguous flag — observability for the "did you
      // mean?" warning stays intact even though the broadcast intent is
      // unambiguous.
      const r = parseMentions('@agent-all also @agent-bob help', roster);
      assert.deepEqual(r.mentions, ['all']);
      assert.equal(r.ambiguous, true);
    });
  });

  describe('parseMentions — handle-form mentions', () => {
    // Handle-form addressing is the canonical mention form. `@agent-bob-42`
    // (full handle) and `@agent-bob` (name-only, resolved if unambiguous)
    // are what every Discord-facing surface advertises.

    const rosterWithHandles = {
      'sess-aaaaaaaa-1111': { handle: 'bob-42' },
      'sess-bbbbbbbb-2222': { handle: 'sam-17' },
      'sess-cccccccc-3333': { handle: 'bob-99' }
    };

    it('resolves full handle (@agent-bob-42) to the matching sessionId', () => {
      const r = parseMentions('@agent-bob-42 please review', rosterWithHandles);
      assert.deepEqual(r.mentions, ['sess-aaaaaaaa-1111']);
      assert.equal(r.stripped, 'please review');
      assert.equal(r.ambiguous, false);
    });

    it('resolves name-only (@agent-sam) when unambiguous', () => {
      // sam only has one live session (sam-17) — name alone is enough.
      const r = parseMentions('@agent-sam hi', rosterWithHandles);
      assert.deepEqual(r.mentions, ['sess-bbbbbbbb-2222']);
      assert.equal(r.ambiguous, false);
    });

    it('routes ambiguous name (@agent-bob) to "all" with ambiguous=true', () => {
      // Two live `bob-*` handles — the user must disambiguate. Routing to
      // broadcast plus the ambiguous flag lets the bridge post a "did you
      // mean bob-42 or bob-99?" warning without losing the message.
      const r = parseMentions('@agent-bob do the thing', rosterWithHandles);
      assert.deepEqual(r.mentions, ['all']);
      assert.equal(r.ambiguous, true);
    });

    it('unknown handle (@agent-eve-8) is dropped silently', () => {
      const r = parseMentions('@agent-eve-8 hello', rosterWithHandles);
      assert.deepEqual(r.mentions, []);
      assert.equal(r.ambiguous, false);
    });

    it('derives handle on the fly for legacy rows missing the handle field', () => {
      // Roster row from before the handle rollout has no `handle` — but
      // parseMentions must still match the derived value so the mention
      // resolves the first time, not "after the next heartbeat".
      const { deriveHandle } = require('../../lib/handles');
      const sid = 'legacy-sess-uuid-abc';
      const derived = deriveHandle(sid);
      const legacyRoster = { [sid]: { /* no handle field */ } };
      const r = parseMentions('@agent-' + derived + ' yo', legacyRoster);
      assert.deepEqual(r.mentions, [sid]);
    });

    it('handle-form resolution does not flip ambiguous=true when the mention lands cleanly', () => {
      // Regression guard: if the handle matches exactly, ambiguous should
      // stay false even when the name segment alone would have been
      // ambiguous. Explicit `bob-42` is unambiguous by construction.
      const r = parseMentions('@agent-bob-42 pinned', rosterWithHandles);
      assert.equal(r.ambiguous, false);
    });
  });
});
