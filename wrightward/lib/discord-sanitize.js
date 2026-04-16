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

const { HANDLE_PATTERN, HANDLE_NAME_PATTERN } = require('./constants');

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
 * Per-mention resolution order (first match wins):
 *   1. Literal `@agent-all` resolves to the broadcast target `"all"`. This
 *      is an explicit user-driven broadcast — `ambiguous` stays false and
 *      the entry is preserved even when concrete mentions also resolve.
 *   2. Full handle (`@agent-bob-42`) — matched against the `handle` field on
 *      each roster row (falling back to `deriveHandle(sessionId)` when the
 *      field is absent).
 *   3. Name-only handle (`@agent-bob`) — if exactly one roster handle starts
 *      with `<name>-`, resolves to that sessionId. Multiple matches resolve
 *      to `"all"` with `ambiguous: true` so the caller can surface a "did
 *      you mean?" hint.
 *   4. Mentions matching no roster entry are dropped silently.
 *
 * The `stripped` return is `content` with all `@agent-<id>` tokens removed
 * and whitespace collapsed — safe to append to bus.jsonl as message body.
 *
 * @param {string} content
 * @param {object} agentRoster - Map of sessionId → row (row.handle consulted
 *   for handle-form mentions; if absent, derived on the fly).
 * @returns {{ mentions: string[], stripped: string, ambiguous: boolean }}
 *   `mentions` is the deduped, message-ordered list of resolved targets
 *   (sessionIds plus possibly `"all"` for ambiguous short-IDs). Empty when
 *   no mention resolves.
 */
function parseMentions(content, agentRoster) {
  if (typeof content !== 'string' || content.length === 0) {
    return { mentions: [], stripped: '', ambiguous: false };
  }

  const rosterEntries = agentRoster && typeof agentRoster === 'object'
    ? Object.entries(agentRoster)
    : [];

  // Built lazily — only required when a handle-shaped or name-only mention
  // actually appears. Keeps the sanitize module's pure-sync hot path cheap
  // for messages with no mentions or only @agent-all.
  let handleIndexCache = null;
  function getHandleIndex() {
    if (handleIndexCache) return handleIndexCache;
    const { handleFor } = require('./handles');
    const byHandle = new Map();
    const byName = new Map();
    for (const [sid, row] of rosterEntries) {
      const h = handleFor(sid, row);
      byHandle.set(h, sid);
      const dash = h.lastIndexOf('-');
      if (dash > 0) {
        const name = h.slice(0, dash);
        const bucket = byName.get(name);
        if (bucket) bucket.push(sid);
        else byName.set(name, [sid]);
      }
    }
    handleIndexCache = { byHandle, byName };
    return handleIndexCache;
  }

  const mentions = [];
  const seen = new Set();
  let ambiguous = false;
  let concreteResolved = false;
  // Tracks whether the user typed the literal `@agent-all` token. This is
  // distinct from an ambiguous name-only mention that resolves to `'all'` —
  // an explicit broadcast is deliberate user intent and must never be
  // dropped by the concrete-sibling filter below.
  let explicitAllMention = false;

  function pushOnce(target) {
    if (seen.has(target)) return;
    seen.add(target);
    mentions.push(target);
  }

  for (const m of content.matchAll(AGENT_MENTION_RE)) {
    const id = m[1];
    // Explicit broadcast syntax — `@agent-all` resolves to the broadcast
    // target `'all'`. Matched before any roster check so a pathological
    // session literally named 'all' can never shadow the broadcast intent.
    if (id === 'all') {
      pushOnce('all');
      explicitAllMention = true;
      continue;
    }
    // Full handle — `@agent-bob-42`.
    if (HANDLE_PATTERN.test(id)) {
      const { byHandle } = getHandleIndex();
      const sid = byHandle.get(id);
      if (sid) {
        pushOnce(sid);
        concreteResolved = true;
      }
      // Handle-shaped but unknown — drop silently.
      continue;
    }
    // Name-only handle — `@agent-bob`. Unambiguous → target; ambiguous → 'all'.
    if (HANDLE_NAME_PATTERN.test(id)) {
      const { byName } = getHandleIndex();
      const hits = byName.get(id);
      if (hits && hits.length === 1) {
        pushOnce(hits[0]);
        concreteResolved = true;
      } else if (hits && hits.length > 1) {
        pushOnce('all');
        ambiguous = true;
      }
      // No match — drop silently.
      continue;
    }
    // Anything else — not a handle-shaped mention, drop silently.
  }

  // When the user unambiguously addressed at least one concrete session in
  // this message, drop any `'all'` entry contributed by a sibling ambiguous
  // name-only mention. Otherwise a single ambiguous mention dilutes the
  // intent of the whole message into a broadcast. `ambiguous` still surfaces
  // so callers can show a "did you mean X or Y?" warning alongside the
  // targeted delivery. An explicit `@agent-all` bypasses the filter — the
  // user asked to broadcast AND to address specific sessions; honor both.
  const filtered = (concreteResolved && !explicitAllMention)
    ? mentions.filter((m) => m !== 'all')
    : mentions;

  const stripped = content
    .replace(AGENT_MENTION_RE, '')
    .replace(/\s+/g, ' ')
    .trim();

  return { mentions: filtered, stripped, ambiguous };
}

module.exports = { redactTokens, clampUtf8, parseMentions };
