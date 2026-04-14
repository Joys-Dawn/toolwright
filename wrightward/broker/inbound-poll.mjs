// Inbound Discord → bus pipeline.
//
// Polls a broadcast Discord text channel via REST, filters bot messages and
// non-allowlisted senders, sanitizes tokens, parses @agent-<id> mentions,
// and appends a user_message event to bus.jsonl targeted at the matching
// session.
//
// Bookmark is a single message ID persisted to bridge/last-polled.json.
// On restart, we resume from that ID so we don't re-ingest old messages.

import path from 'path';
import fs from 'fs';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { redactTokens, parseMentions, clampUtf8 } = require('../lib/discord-sanitize');
const { withAgentsLock, readAgents } = require('../lib/agents');
const { append } = require('../lib/bus-log');
const { createEvent, SYNTHETIC_SENDER } = require('../lib/bus-schema');
const { atomicWriteJson } = require('../lib/atomic-write');

// Cap at 4000 bytes — plenty of room for a useful prompt while preventing
// a pathological large post from blowing up bus.jsonl.
const MAX_INBOUND_CONTENT_BYTES = 4000;
const LAST_POLLED_FILE_REL = 'bridge/last-polled.json';
const DEFAULT_POLL_INTERVAL_MS = 3000;

function markerPath(collabDir) {
  return path.join(collabDir, LAST_POLLED_FILE_REL);
}

export function readMarker(collabDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(markerPath(collabDir), 'utf8'));
    return typeof raw.last_polled_message_id === 'string' && raw.last_polled_message_id.length > 0
      ? raw.last_polled_message_id
      : null;
  } catch (_) {
    return null;
  }
}

export function writeMarker(collabDir, id) {
  atomicWriteJson(markerPath(collabDir), { last_polled_message_id: id || null });
}

/**
 * Creates an inbound poller bound to a collab dir, API client, and config.
 *
 * @param {string} collabDir
 * @param {object} api - discord/api.js client
 * @param {object} options
 * @param {string} options.broadcastChannelId - the broadcast channel to poll
 * @param {string[]} options.allowedSenders - Discord user IDs permitted to route; empty array blocks all
 * @param {number} [options.pollIntervalMs]
 * @param {function} [options.logger] - optional `(line: string) => void` for diagnostic logs
 */
export function createInboundPoller(collabDir, api, options) {
  options = options || {};
  const broadcastChannelId = options.broadcastChannelId;
  if (!broadcastChannelId) throw new Error('broadcastChannelId required');
  if (!api || typeof api.getMessagesAfter !== 'function') {
    throw new Error('api with getMessagesAfter required');
  }

  const allowedSenders = new Set(options.allowedSenders || []);
  const pollIntervalMs = options.pollIntervalMs || DEFAULT_POLL_INTERVAL_MS;
  const log = typeof options.logger === 'function' ? options.logger : (() => {});

  let lastPolledId = readMarker(collabDir);
  let hasSeeded = lastPolledId !== null; // persisted marker counts as seeded
  let timer = null;
  let polling = false;

  async function pollOnce() {
    if (polling) return { polled: 0, ingested: 0, skipped: 0 };
    polling = true;
    let ingested = 0;
    let skipped = 0;
    try {
      // First-run seeding: with no marker, getMessagesAfter returns the most
      // recent 50 messages — which could include hours/days-old posts with
      // @agent-<id> mentions from prior sessions. Symmetric to the outbound
      // seedBookmarkIfFresh in bridge.mjs, we seed the inbound marker to the
      // current newest message ID and skip ingestion of pre-existing history.
      //
      // hasSeeded guards against the empty-channel case: if the broadcast has
      // no messages at seed time, we still only seed once per process — a
      // message posted after start flows through the normal after=null path
      // (which naturally matches only that single new message).
      if (!hasSeeded) {
        hasSeeded = true;
        const seed = await api.getMessagesAfter(broadcastChannelId, null, 1);
        if (Array.isArray(seed) && seed.length > 0 && seed[0] && seed[0].id) {
          lastPolledId = seed[0].id;
          writeMarker(collabDir, lastPolledId);
          log('[inbound] seeded marker to ' + lastPolledId + ' (first run)');
        } else {
          log('[inbound] channel empty at seed time');
        }
        return { polled: 0, ingested: 0, skipped: 0 };
      }

      const messages = await api.getMessagesAfter(broadcastChannelId, lastPolledId);
      if (!Array.isArray(messages) || messages.length === 0) {
        return { polled: 0, ingested: 0, skipped: 0 };
      }

      // Discord returns newest-to-oldest. Bookmark the NEWEST id — the next
      // poll uses `after=<newest>` to get only strictly-newer messages.
      const newest = messages[0];

      // Process chronologically so earlier mentions fire first.
      for (let i = messages.length - 1; i >= 0; i--) {
        try {
          const result = processMessage(messages[i]);
          if (result === 'ingested') ingested++;
          else skipped++;
        } catch (err) {
          skipped++;
          log('[inbound] processMessage error: ' + (err.message || err));
        }
      }

      if (newest && newest.id) {
        lastPolledId = newest.id;
        writeMarker(collabDir, lastPolledId);
      }
      return { polled: messages.length, ingested, skipped };
    } finally {
      polling = false;
    }
  }

  function processMessage(msg) {
    if (!msg || !msg.author) return 'skipped';
    const msgId = msg.id || '?';
    // Bots never route — prevents the bridge from ingesting its own posts
    // OR other bots in the channel. Covers a big class of loop bugs.
    if (msg.author.bot === true) return 'skipped';
    // Empty allowlist means inbound is fully disabled — send-only mode.
    if (allowedSenders.size === 0) {
      log('[inbound] skip msg=' + msgId + ' reason=empty_allowlist (send-only mode)');
      return 'skipped';
    }
    if (!allowedSenders.has(msg.author.id)) {
      log('[inbound] skip msg=' + msgId + ' reason=sender_not_allowed author_id=' + msg.author.id);
      return 'skipped';
    }

    const roster = readAgents(collabDir);
    const raw = typeof msg.content === 'string' ? msg.content : '';
    // Redact BEFORE clamping so multi-byte secrets aren't split.
    const redacted = redactTokens(raw);
    const clamped = clampUtf8(redacted, MAX_INBOUND_CONTENT_BYTES);
    const { routedTo, stripped, ambiguous } = parseMentions(clamped, roster);
    if (!routedTo) {
      // Most common cause: Message Content Intent is disabled in the dev
      // portal, so Discord returns content='' for messages that don't
      // natively mention the bot. Log content length so operators can tell
      // "no @agent-<id> in message" apart from "empty payload".
      log('[inbound] skip msg=' + msgId + ' reason=no_mention content_len=' +
        raw.length + ' roster_size=' + roster.length);
      return 'skipped';
    }

    const body = stripped || '(empty)';
    const meta = {
      source: 'discord',
      discord_user_id: msg.author.id,
      discord_message_id: msg.id,
      ambiguous_mention: ambiguous || false
    };

    withAgentsLock(collabDir, (token) => {
      append(token, collabDir, createEvent(
        SYNTHETIC_SENDER, routedTo, 'user_message', body, meta
      ));
    });
    return 'ingested';
  }

  return {
    start() {
      if (timer !== null) return;
      timer = setInterval(() => {
        pollOnce().catch((err) => log('[inbound] poll error: ' + (err.message || err)));
      }, pollIntervalMs);
      timer.unref();
    },
    stop() {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    },
    pollOnce,
    _state: () => ({ lastPolledId })
  };
}
