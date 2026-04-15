'use strict';

/**
 * Pure sanitization helpers for the Phase 3 Discord bridge.
 *
 * These functions have no I/O and no external dependencies — they run in
 * every hot path (inbound message ingestion, outbound log writes) and must
 * be trivially safe to call.
 */

// Discord bot token: 3 segments joined by '.' — <user-id b64url>.<ts b64url>.<hmac b64url>.
// Length floors match the documented token shape; tokens longer than the floor
// are common and fully matched. The `\b` word boundaries prevent matching a
// substring of a larger identifier.
//
// Order matters: BOT_TOKEN_HEADER runs first so we preserve the literal `Bot `
// prefix in the redaction (makes logs readable without revealing the token).
const BOT_TOKEN_HEADER = /\bBot\s+[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{27,}\b/g;
const BOT_TOKEN_BARE = /\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{27,}\b/g;

// Discord webhook URL — covers canary/ptb subdomains, the legacy discordapp.com
// alias (still resolves), and versioned /api/vN/webhooks/... paths. Based on
// Sapphire Discord Utilities WebhookRegex. The `[A-Za-z0-9_-]+` suffix is the
// webhook token (b64url), which on its own is sensitive and must not leak.
const WEBHOOK_URL = /https:\/\/(?:(?:canary|ptb)\.)?discord(?:app)?\.com\/api(?:\/v\d+)?\/webhooks\/\d+\/[A-Za-z0-9_-]+/g;

// `@agent-<id>` free-text mention. Deliberately does NOT match `<@...>` —
// that shape is Discord's own snowflake mention and conflicting with it
// would render as broken mentions in all Discord clients.
const AGENT_MENTION_RE = /@agent-([A-Za-z0-9_-]+)/g;

const { SHORT_ID_LEN } = require('./constants');

/**
 * Scrubs Discord bot tokens (bare + `Bot <token>` forms) and webhook URLs
 * from a string. Safe on non-string input (returns unchanged).
 *
 * Order: header form is redacted first so the literal `Bot ` prefix is
 * preserved in the output, making logs readable.
 */
function redactTokens(str) {
  if (typeof str !== 'string' || str.length === 0) return str;
  return str
    .replace(BOT_TOKEN_HEADER, 'Bot [REDACTED]')
    .replace(BOT_TOKEN_BARE, '[REDACTED]')
    .replace(WEBHOOK_URL, 'https://discord.com/api/webhooks/[REDACTED]');
}

/**
 * Truncates a string to at most `maxBytes` UTF-8 bytes without splitting a
 * multi-byte character mid-sequence.
 *
 * Walks back from the cut point while the byte is a UTF-8 continuation byte
 * (0x80–0xBF); the first non-continuation byte we hit is either a start
 * byte beyond the cut (so we stop before it) or a start byte we're at (so
 * we include it — but only if its full sequence fits, which it must if
 * we walked back to it).
 */
function clampUtf8(str, maxBytes) {
  if (typeof str !== 'string') return str;
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) return '';
  const buf = Buffer.from(str, 'utf8');
  if (buf.length <= maxBytes) return str;

  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xC0) === 0x80) {
    end--;
  }
  return buf.subarray(0, end).toString('utf8');
}

/**
 * Parses `@agent-<id>` mentions out of `content` and resolves them to known
 * sessions in `agentRoster`. Returns every resolved target in message order,
 * deduped — fan-out routing is the caller's responsibility.
 *
 * Per-mention resolution:
 *   1. Full session ID match resolves to that sessionId.
 *   2. Short-ID match (first 8 chars) resolves to the single matching session.
 *   3. Ambiguous short-ID (two sessions share the same 8-char prefix) resolves
 *      to `"all"` and sets `ambiguous: true` so callers can surface a warning.
 *   4. Mentions matching no roster entry are dropped silently.
 *
 * The `stripped` return is `content` with all `@agent-<id>` tokens removed
 * and whitespace collapsed — safe to append to bus.jsonl as message body.
 *
 * @param {string} content
 * @param {object} agentRoster - Map of sessionId → any (only keys are used).
 * @returns {{ mentions: string[], stripped: string, ambiguous: boolean }}
 *   `mentions` is the deduped, message-ordered list of resolved targets
 *   (sessionIds plus possibly `"all"` for ambiguous short-IDs). Empty when
 *   no mention resolves.
 */
function parseMentions(content, agentRoster) {
  if (typeof content !== 'string' || content.length === 0) {
    return { mentions: [], stripped: '', ambiguous: false };
  }

  const sessionIds = agentRoster && typeof agentRoster === 'object'
    ? Object.keys(agentRoster)
    : [];
  const sessionIdSet = new Set(sessionIds);

  // Build shortId → sessionId map; collisions mark the entry as null (ambiguous).
  const byShortId = new Map();
  for (const sid of sessionIds) {
    const shortId = sid.substring(0, SHORT_ID_LEN);
    if (byShortId.has(shortId)) {
      byShortId.set(shortId, null);
    } else {
      byShortId.set(shortId, sid);
    }
  }

  const mentions = [];
  const seen = new Set();
  let ambiguous = false;
  let concreteResolved = false;

  function pushOnce(target) {
    if (seen.has(target)) return;
    seen.add(target);
    mentions.push(target);
  }

  for (const m of content.matchAll(AGENT_MENTION_RE)) {
    const id = m[1];
    if (sessionIdSet.has(id)) {
      pushOnce(id);
      concreteResolved = true;
      continue;
    }
    const byShort = byShortId.get(id);
    if (byShort === null) {
      pushOnce('all');
      ambiguous = true;
    } else if (byShort) {
      pushOnce(byShort);
      concreteResolved = true;
    }
  }

  // When the user unambiguously addressed at least one concrete session in
  // this message, drop any `'all'` entry contributed by a sibling ambiguous
  // short-ID. Otherwise a single ambiguous mention dilutes the intent of the
  // whole message into a broadcast. `ambiguous` still surfaces so callers can
  // show a "did you mean X or Y?" warning alongside the targeted delivery.
  const filtered = concreteResolved ? mentions.filter((m) => m !== 'all') : mentions;

  const stripped = content
    .replace(AGENT_MENTION_RE, '')
    .replace(/\s+/g, ' ')
    .trim();

  return { mentions: filtered, stripped, ambiguous };
}

module.exports = { redactTokens, clampUtf8, parseMentions };
