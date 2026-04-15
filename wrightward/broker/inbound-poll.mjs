// Inbound Discord → bus pipeline.
//
// Polls the broadcast Discord text channel AND every active forum thread via
// REST. Each stream has an independent bookmark and independent seed-on-
// first-run semantics. Per-stream rejections (e.g., 403 on a thread archived
// mid-tick) are isolated with Promise.allSettled so one slow stream can't
// block the others.
//
// For each message: bot-author filter → allowedSenders gate → token redaction
// → UTF-8 clamp → @agent-<id> mention parse → fan-out routing to
// {thread owner} ∪ {resolved mentions}, deduped → append `user_message` to
// bus.jsonl under withAgentsLock.
//
// Bookmark shape at rest (bridge/last-polled.json):
//   { broadcast: string|null, threads: { [thread_id]: string } }
// Legacy `{ last_polled_message_id }` shape is migrated on read; writes always
// emit the new shape.
//
// Ordering note: chronological order is preserved WITHIN a single stream
// (Discord returns newest-first; we iterate in reverse). Across streams,
// there is no ordering guarantee — a broadcast and a thread message may
// interleave on bus.jsonl based on which HTTP response resolves first. Each
// event carries its own ts/id so consumers use bookmark offsets, not stream
// order.

import path from 'path';
import fs from 'fs';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { redactTokens, parseMentions, clampUtf8 } = require('../lib/discord-sanitize');
// Bind the agents module namespace rather than destructuring — lets tests
// install observable spies on `withAgentsLock` via `t.mock.method(agents, ...)`
// without having to replace an already-closed-over destructured reference.
const agents = require('../lib/agents');
const { append } = require('../lib/bus-log');
const { createEvent, SYNTHETIC_SENDER } = require('../lib/bus-schema');
const { atomicWriteJson } = require('../lib/atomic-write');

// Cap at 4000 bytes — plenty of room for a useful prompt while preventing
// a pathological large post from blowing up bus.jsonl.
const MAX_INBOUND_CONTENT_BYTES = 4000;
const LAST_POLLED_FILE_REL = 'bridge/last-polled.json';
const DEFAULT_POLL_INTERVAL_MS = 3000;
const BROADCAST_STREAM_KEY = 'broadcast';

function markerPath(collabDir) {
  return path.join(collabDir, LAST_POLLED_FILE_REL);
}

/**
 * Reads the inbound poll marker state. Migrates the legacy single-id shape
 * (`{ last_polled_message_id }`) to the new multi-stream shape on read; writes
 * always emit the new shape.
 *
 * @param {string} collabDir
 * @returns {{ broadcast: string|null, threads: Record<string, string> }}
 */
export function readMarker(collabDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(markerPath(collabDir), 'utf8'));
    if (raw && typeof raw === 'object') {
      // New shape.
      if ('broadcast' in raw || 'threads' in raw) {
        const broadcast = typeof raw.broadcast === 'string' && raw.broadcast.length > 0
          ? raw.broadcast
          : null;
        const threads = (raw.threads && typeof raw.threads === 'object' && !Array.isArray(raw.threads))
          ? sanitizeThreadsMap(raw.threads)
          : {};
        return { broadcast, threads };
      }
      // Legacy shape — map the single id into the new `broadcast` slot.
      if (typeof raw.last_polled_message_id === 'string' && raw.last_polled_message_id.length > 0) {
        return { broadcast: raw.last_polled_message_id, threads: {} };
      }
    }
  } catch (_) { /* fall through to default */ }
  return { broadcast: null, threads: {} };
}

function sanitizeThreadsMap(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof k === 'string' && k.length > 0 && typeof v === 'string' && v.length > 0) {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Writes the marker state in the new shape. Accepts either a full state
 * object `{ broadcast, threads }` or — for backwards-compat with older tests
 * — a single string treated as the broadcast marker.
 */
export function writeMarker(collabDir, state) {
  let broadcast = null;
  let threads = {};
  if (typeof state === 'string') {
    broadcast = state.length > 0 ? state : null;
  } else if (state && typeof state === 'object') {
    broadcast = typeof state.broadcast === 'string' && state.broadcast.length > 0
      ? state.broadcast
      : null;
    threads = state.threads && typeof state.threads === 'object' && !Array.isArray(state.threads)
      ? sanitizeThreadsMap(state.threads)
      : {};
  }
  atomicWriteJson(markerPath(collabDir), { broadcast, threads });
}

/**
 * Creates an inbound poller bound to a collab dir, API client, and config.
 *
 * @param {string} collabDir
 * @param {object} api - discord/api.js client
 * @param {object} options
 * @param {string} options.broadcastChannelId - the broadcast channel to poll
 * @param {string[]} options.allowedSenders - Discord user IDs permitted to route; empty array blocks all
 * @param {function} [options.threadsProvider] - `() => [{ sessionId, thread_id, rendered_name }]`
 *   returning active (non-archived) threads to poll each tick. Defaults to `() => []`
 *   (broadcast-only) when unspecified — useful for unit tests.
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
  const threadsProvider = typeof options.threadsProvider === 'function'
    ? options.threadsProvider
    : () => [];

  // Persisted marker state lifted into closure at construct time.
  const initial = readMarker(collabDir);
  let broadcastMarker = initial.broadcast;
  /** @type {Map<string, string>} */
  const threadMarkers = new Map(Object.entries(initial.threads));
  // Streams that have either a persisted marker OR have completed seeding
  // during this process lifetime. Keyed by `'broadcast'` or thread_id.
  const seededStreams = new Set();
  if (broadcastMarker !== null) seededStreams.add(BROADCAST_STREAM_KEY);
  for (const tid of threadMarkers.keys()) seededStreams.add(tid);

  let timer = null;
  let polling = false;

  function persistMarkers() {
    writeMarker(collabDir, {
      broadcast: broadcastMarker,
      threads: Object.fromEntries(threadMarkers)
    });
  }

  // Per-stream poll. Handles seeding, fetch, process, marker advance.
  // `streamKey` is the seededStreams/markers key ('broadcast' or thread_id);
  // `channelId` is the Discord API channel id; `threadContext` is null for
  // the broadcast channel, otherwise `{ thread_id, sessionId }`.
  async function pollStream(streamKey, channelId, threadContext) {
    const isBroadcast = streamKey === BROADCAST_STREAM_KEY;
    const getMarker = () => isBroadcast
      ? broadcastMarker
      : (threadMarkers.get(streamKey) || null);
    const setMarker = (id) => {
      if (isBroadcast) broadcastMarker = id;
      else threadMarkers.set(streamKey, id);
    };

    if (!seededStreams.has(streamKey)) {
      // Order matters: only flip seededStreams AFTER the seed fetch resolves
      // successfully. If we flipped first and the fetch threw, the next tick
      // would skip the seed branch, fetch with a null marker, and ingest up
      // to Discord's default 50-message history — replaying pre-existing
      // mentions or thread replies as brand-new user_message events.
      const seed = await api.getMessagesAfter(channelId, null, 1);
      seededStreams.add(streamKey);
      if (Array.isArray(seed) && seed.length > 0 && seed[0] && seed[0].id) {
        setMarker(seed[0].id);
        persistMarkers();
        log('[inbound] seeded stream=' + streamKey + ' to ' + seed[0].id);
      } else {
        log('[inbound] stream=' + streamKey + ' empty at seed time');
      }
      return { polled: 0, ingested: 0, skipped: 0 };
    }

    const messages = await api.getMessagesAfter(channelId, getMarker());
    if (!Array.isArray(messages) || messages.length === 0) {
      return { polled: 0, ingested: 0, skipped: 0 };
    }

    // Discord returns newest-to-oldest. Bookmark the NEWEST id — next poll
    // uses `after=<newest>` to get only strictly-newer messages.
    const newest = messages[0];
    let ingested = 0;
    let skipped = 0;
    // Process chronologically so earlier mentions fire first.
    for (let i = messages.length - 1; i >= 0; i--) {
      try {
        const result = processMessage(messages[i], threadContext, channelId);
        if (result === 'ingested') ingested++;
        else skipped++;
      } catch (err) {
        skipped++;
        log('[inbound] processMessage error stream=' + streamKey + ': ' +
          (err.message || err));
      }
    }

    if (newest && newest.id) {
      setMarker(newest.id);
      persistMarkers();
    }
    return { polled: messages.length, ingested, skipped };
  }

  function safeListActiveThreads() {
    try {
      const list = threadsProvider();
      return Array.isArray(list) ? list : [];
    } catch (err) {
      log('[inbound] threadsProvider error: ' + (err.message || err));
      return [];
    }
  }

  async function pollOnce() {
    if (polling) return { polled: 0, ingested: 0, skipped: 0 };
    polling = true;
    try {
      const activeThreads = safeListActiveThreads();
      // allSettled so one stream's rejection (e.g., 403 on archived thread)
      // does NOT abort the others. Per-stream errors are logged inside each
      // task's own catch; the outer `results` loop picks up anything
      // unexpected that escapes.
      const tasks = [];
      tasks.push(pollStream(BROADCAST_STREAM_KEY, broadcastChannelId, null)
        .catch((err) => {
          log('[inbound] broadcast poll error: ' + (err.message || err));
          return { polled: 0, ingested: 0, skipped: 0 };
        }));
      for (const t of activeThreads) {
        if (!t || !t.thread_id || !t.sessionId) continue;
        tasks.push(pollStream(t.thread_id, t.thread_id, {
          thread_id: t.thread_id,
          sessionId: t.sessionId
        }).catch((err) => {
          log('[inbound] thread ' + t.thread_id + ' error: ' + (err.message || err));
          return { polled: 0, ingested: 0, skipped: 0 };
        }));
      }
      const results = await Promise.allSettled(tasks);
      let polled = 0, ingested = 0, skipped = 0;
      for (const r of results) {
        if (r.status === 'fulfilled' && r.value) {
          polled += r.value.polled || 0;
          ingested += r.value.ingested || 0;
          skipped += r.value.skipped || 0;
        }
      }
      return { polled, ingested, skipped };
    } finally {
      polling = false;
    }
  }

  function processMessage(msg, threadContext, channelId) {
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

    const roster = agents.readAgents(collabDir);
    const raw = typeof msg.content === 'string' ? msg.content : '';
    // Redact BEFORE clamping so multi-byte secrets aren't split.
    const redacted = redactTokens(raw);
    const clamped = clampUtf8(redacted, MAX_INBOUND_CONTENT_BYTES);
    const { mentions, stripped, ambiguous } = parseMentions(clamped, roster);

    // Fan-out target set: thread owner (when polling a thread) first, then
    // every resolved mention in message order. Set preserves insertion order
    // per the JS spec; filter(Boolean) drops the undefined sessionId when
    // polling the broadcast channel (threadContext is null).
    const targets = [...new Set(
      [threadContext && threadContext.sessionId, ...mentions].filter(Boolean)
    )];

    if (targets.length === 0) {
      // Most common cause: Message Content Intent is disabled in the dev
      // portal, so Discord returns content='' for messages that don't
      // natively mention the bot. Log content length so operators can tell
      // "no @agent-<id> in message" apart from "empty payload".
      log('[inbound] skip msg=' + msgId + ' reason=no_mention content_len=' +
        raw.length + ' roster_size=' + roster.length);
      return 'skipped';
    }

    // Single-target → string form (cleaner for single-recipient events).
    // Multi-target → array form (createEvent and matchesSession both accept).
    const to = targets.length === 1 ? targets[0] : targets;
    const body = stripped || '(empty)';
    const meta = {
      source: 'discord',
      discord_user_id: msg.author.id,
      discord_message_id: msg.id,
      discord_channel_id: channelId,
      discord_thread_id: threadContext ? threadContext.thread_id : null,
      ambiguous_mention: ambiguous || false
    };

    agents.withAgentsLock(collabDir, (token) => {
      append(token, collabDir, createEvent(
        SYNTHETIC_SENDER, to, 'user_message', body, meta
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
    _state: () => ({
      broadcastMarker,
      threadMarkers: new Map(threadMarkers),
      seededStreams: new Set(seededStreams)
    })
  };
}
