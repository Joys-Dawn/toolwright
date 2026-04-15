import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';
import { createInboundPoller, readMarker, writeMarker } from '../../broker/inbound-poll.mjs';

const require = createRequire(import.meta.url);
const { ensureCollabDir } = require('../../lib/collab-dir');
const { registerAgent } = require('../../lib/agents');
const { busPath } = require('../../lib/bus-log');

function makeMockApi(messagesQueue) {
  const calls = [];
  const api = {
    async getMessagesAfter(channelId, afterId) {
      calls.push({ channelId, afterId });
      if (typeof messagesQueue === 'function') return messagesQueue(channelId, afterId, calls.length - 1);
      return messagesQueue.shift() || [];
    }
  };
  api.calls = calls;
  return api;
}

function readBus(collabDir) {
  const bp = busPath(collabDir);
  if (!fs.existsSync(bp)) return [];
  return fs.readFileSync(bp, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

describe('broker/inbound-poll', () => {
  let tmpDir, collabDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-inbound-'));
    collabDir = ensureCollabDir(tmpDir);
    registerAgent(collabDir, 'sess-abcdef12');
    registerAgent(collabDir, 'sess-12345678');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('construction', () => {
    it('throws when broadcastChannelId missing', () => {
      const api = makeMockApi([]);
      assert.throws(() => createInboundPoller(collabDir, api, {}), /broadcastChannelId/);
    });

    it('throws when api is missing getMessagesAfter', () => {
      assert.throws(() => createInboundPoller(collabDir, {}, { broadcastChannelId: 'c' }),
        /getMessagesAfter/);
    });
  });

  describe('pollOnce', () => {
    it('returns { polled: 0 } when no messages', async () => {
      const api = makeMockApi([[]]);
      const p = createInboundPoller(collabDir, api, {
        broadcastChannelId: 'b', allowedSenders: ['u1']
      });
      const r = await p.pollOnce();
      assert.equal(r.polled, 0);
      assert.equal(readBus(collabDir).length, 0);
    });

    it('filters bot messages', async () => {
      const api = makeMockApi([[
        { id: 'm1', author: { id: 'u1', bot: true }, content: '@agent-sess-abcdef12 hi' }
      ]]);
      const p = createInboundPoller(collabDir, api, {
        broadcastChannelId: 'b', allowedSenders: ['u1']
      });
      const r = await p.pollOnce();
      assert.equal(r.ingested, 0);
      assert.equal(readBus(collabDir).length, 0);
    });

    it('rejects messages from non-allowlisted users', async () => {
      const api = makeMockApi([[
        { id: 'm1', author: { id: 'u-not-allowed', bot: false }, content: '@agent-sess-abcdef12 hi' }
      ]]);
      const p = createInboundPoller(collabDir, api, {
        broadcastChannelId: 'b', allowedSenders: ['u1']
      });
      const r = await p.pollOnce();
      assert.equal(r.ingested, 0);
      assert.equal(readBus(collabDir).length, 0);
    });

    it('rejects all inbound when allowedSenders is empty', async () => {
      const api = makeMockApi([[
        { id: 'm1', author: { id: 'u1', bot: false }, content: '@agent-sess-abcdef12 hi' }
      ]]);
      const p = createInboundPoller(collabDir, api, {
        broadcastChannelId: 'b', allowedSenders: []
      });
      const r = await p.pollOnce();
      assert.equal(r.ingested, 0);
    });

    it('ingests message matching a known session short-id', async () => {
      writeMarker(collabDir, 'seed'); // skip first-run seeding
      const api = makeMockApi([[
        { id: 'm1', author: { id: 'u1', bot: false }, content: '@agent-sess-abc please fix auth' }
      ]]);
      const p = createInboundPoller(collabDir, api, {
        broadcastChannelId: 'b', allowedSenders: ['u1']
      });
      await p.pollOnce();
      const events = readBus(collabDir).filter((e) => e.type === 'user_message');
      assert.equal(events.length, 1);
      assert.equal(events[0].to, 'sess-abcdef12');
      assert.match(events[0].body, /please fix auth/);
      assert.equal(events[0].meta.source, 'discord');
      assert.equal(events[0].meta.discord_user_id, 'u1');
      assert.equal(events[0].meta.discord_message_id, 'm1');
    });

    it('redacts tokens BEFORE appending to bus', async () => {
      writeMarker(collabDir, 'seed');
      const SECRET = 'MTExMTExMTExMTExMTExMTEx.XxXxXx.abcdefghijklmnopqrstuvwxyz_';
      const api = makeMockApi([[
        { id: 'm1', author: { id: 'u1', bot: false },
          content: '@agent-sess-abc token is ' + SECRET + ' please rotate' }
      ]]);
      const p = createInboundPoller(collabDir, api, {
        broadcastChannelId: 'b', allowedSenders: ['u1']
      });
      await p.pollOnce();
      const events = readBus(collabDir).filter((e) => e.type === 'user_message');
      assert.equal(events.length, 1);
      // Snapshot: the appended body MUST NOT contain the token, even partial.
      assert.doesNotMatch(events[0].body, /MTExMTE/);
      assert.match(events[0].body, /\[REDACTED\]/);
    });

    it('bookmarks the newest message ID (Discord returns newest-first)', async () => {
      writeMarker(collabDir, 'seed');
      const api = makeMockApi([[
        { id: 'm3', author: { id: 'u1', bot: false }, content: '@agent-sess-abc c' },
        { id: 'm2', author: { id: 'u1', bot: false }, content: '@agent-sess-abc b' },
        { id: 'm1', author: { id: 'u1', bot: false }, content: '@agent-sess-abc a' }
      ]]);
      const p = createInboundPoller(collabDir, api, {
        broadcastChannelId: 'b', allowedSenders: ['u1']
      });
      await p.pollOnce();
      assert.equal(readMarker(collabDir).broadcast, 'm3');
      // Processed chronologically — oldest first.
      const events = readBus(collabDir).filter((e) => e.type === 'user_message');
      assert.equal(events.length, 3);
      assert.match(events[0].body, /a$/);
      assert.match(events[2].body, /c$/);
    });

    it('passes last-polled id to getMessagesAfter on subsequent poll', async () => {
      const api = makeMockApi([
        [{ id: 'm1', author: { id: 'u1', bot: false }, content: '@agent-sess-abc hi' }],
        [] // second poll returns nothing
      ]);
      const p = createInboundPoller(collabDir, api, {
        broadcastChannelId: 'b', allowedSenders: ['u1']
      });
      await p.pollOnce();
      await p.pollOnce();
      assert.equal(api.calls[0].afterId, null);
      assert.equal(api.calls[1].afterId, 'm1');
    });

    it('first poll seeds marker to newest message ID without ingesting', async () => {
      // Simulates fresh bridge startup with a broadcast channel that has
      // hours/days of history. Without seeding, the first poll would ingest
      // every @agent-<id> mention in the recent 50 messages — potentially
      // replaying commands from a prior session.
      const api = makeMockApi([[
        { id: 'old-3', author: { id: 'u1', bot: false }, content: '@agent-sess-abc stale-a' },
        { id: 'old-2', author: { id: 'u1', bot: false }, content: '@agent-sess-abc stale-b' },
        { id: 'old-1', author: { id: 'u1', bot: false }, content: '@agent-sess-abc stale-c' }
      ]]);
      const p = createInboundPoller(collabDir, api, {
        broadcastChannelId: 'b', allowedSenders: ['u1']
      });
      const r = await p.pollOnce();
      assert.equal(r.ingested, 0, 'first-run seed must not ingest pre-existing messages');
      assert.equal(readBus(collabDir).filter(e => e.type === 'user_message').length, 0);
      // Marker should point at the newest message (old-3) so the next real
      // poll uses after=old-3 and only sees strictly-newer posts.
      assert.equal(readMarker(collabDir).broadcast, 'old-3');
    });

    it('persists bookmark across instances (restart recovery)', async () => {
      const api = makeMockApi([[
        { id: 'msg-xyz', author: { id: 'u1', bot: false }, content: '@agent-sess-abc ping' }
      ]]);
      const p1 = createInboundPoller(collabDir, api, {
        broadcastChannelId: 'b', allowedSenders: ['u1']
      });
      await p1.pollOnce();

      // New instance reads the persisted marker
      const api2 = makeMockApi([[]]);
      const p2 = createInboundPoller(collabDir, api2, {
        broadcastChannelId: 'b', allowedSenders: ['u1']
      });
      await p2.pollOnce();
      assert.equal(api2.calls[0].afterId, 'msg-xyz');
    });

    it('drops messages with no actionable @agent mention', async () => {
      writeMarker(collabDir, 'seed');
      const api = makeMockApi([[
        { id: 'm1', author: { id: 'u1', bot: false }, content: 'just chatting, no mention' }
      ]]);
      const p = createInboundPoller(collabDir, api, {
        broadcastChannelId: 'b', allowedSenders: ['u1']
      });
      await p.pollOnce();
      assert.equal(readBus(collabDir).filter(e => e.type === 'user_message').length, 0);
    });

    it('marks ambiguous-mention meta when short-id collides', async () => {
      writeMarker(collabDir, 'seed');
      // Two sessions sharing the same 8-char short id → ambiguous.
      const { registerAgent } = require('../../lib/agents');
      registerAgent(collabDir, 'sess-xxxxyyyy1');
      registerAgent(collabDir, 'sess-xxxxyyyy2');
      const api = makeMockApi([[
        { id: 'm1', author: { id: 'u1', bot: false }, content: '@agent-sess-xxx help' }
      ]]);
      const p = createInboundPoller(collabDir, api, {
        broadcastChannelId: 'b', allowedSenders: ['u1']
      });
      await p.pollOnce();
      const events = readBus(collabDir).filter(e => e.type === 'user_message');
      assert.equal(events.length, 1);
      assert.equal(events[0].to, 'all');
      assert.equal(events[0].meta.ambiguous_mention, true);
    });

    it('does not run concurrently (reentrancy guard)', async () => {
      // If pollOnce is called twice in rapid succession, the second should
      // be a no-op to avoid double-processing the same API response.
      let firstResolve;
      const api = {
        async getMessagesAfter() {
          // Pause the first call.
          return new Promise((r) => { firstResolve = () => r([]); });
        }
      };
      const p = createInboundPoller(collabDir, api, {
        broadcastChannelId: 'b', allowedSenders: ['u1']
      });
      const a = p.pollOnce();
      const b = p.pollOnce(); // should early-return
      const bRes = await b;
      assert.equal(bRes.polled, 0);
      firstResolve();
      await a;
    });
  });

  describe('start/stop lifecycle', () => {
    it('start is idempotent', () => {
      const api = makeMockApi(() => []);
      const p = createInboundPoller(collabDir, api, {
        broadcastChannelId: 'b', allowedSenders: ['u1']
      });
      p.start();
      p.start();
      p.stop();
    });

    it('stop before start does not throw', () => {
      const api = makeMockApi(() => []);
      const p = createInboundPoller(collabDir, api, {
        broadcastChannelId: 'b', allowedSenders: ['u1']
      });
      assert.doesNotThrow(() => p.stop());
    });
  });

  // Marker persistence is the single source of truth for "where did we leave
  // off last tick" — a bug here either replays history (duplicate user
  // messages) or skips live messages (silent data loss). These tests cover
  // the input shapes readMarker/writeMarker must tolerate without either.
  describe('readMarker/writeMarker edge cases', () => {
    function markerFile(dir) {
      return path.join(dir, 'bridge/last-polled.json');
    }

    it('readMarker returns the default shape when the marker file is missing', () => {
      // Fresh collabDir — no bridge/last-polled.json written yet.
      assert.deepEqual(readMarker(collabDir), { broadcast: null, threads: {} });
    });

    it('readMarker returns the default shape when the file contains invalid JSON', () => {
      const file = markerFile(collabDir);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, 'not { valid json');

      assert.deepEqual(readMarker(collabDir), { broadcast: null, threads: {} });
    });

    it('readMarker discards the threads field when it is an array (not an object)', () => {
      // Preserves the broadcast marker but falls back to `{}` for threads —
      // an array-shaped field would otherwise let Object.entries iterate
      // numeric keys and poison the map.
      const file = markerFile(collabDir);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({
        broadcast: 'bcast-1',
        threads: ['not', 'an', 'object']
      }));

      assert.deepEqual(readMarker(collabDir),
        { broadcast: 'bcast-1', threads: {} });
    });

    it('readMarker treats empty legacy last_polled_message_id as default', () => {
      // The old single-marker shape used '' as "unseeded" in some early
      // builds — migrate to the null default rather than seeding an empty
      // string that would serialize as after= on the next fetch.
      const file = markerFile(collabDir);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ last_polled_message_id: '' }));

      assert.deepEqual(readMarker(collabDir), { broadcast: null, threads: {} });
    });

    it('writeMarker accepts a plain string and stores it as the broadcast marker', () => {
      // Older broadcast-only tests call writeMarker(dir, 'seed') — that
      // shape must keep working so test setup doesn't need to migrate.
      writeMarker(collabDir, 'bcast-only-id');
      assert.deepEqual(readMarker(collabDir),
        { broadcast: 'bcast-only-id', threads: {} });
    });

    it('writeMarker normalizes an array-shaped threads field to an empty object', () => {
      writeMarker(collabDir, { broadcast: 'b', threads: ['not', 'an', 'object'] });
      assert.deepEqual(readMarker(collabDir),
        { broadcast: 'b', threads: {} });
    });

    it('writeMarker drops non-string and empty-string entries from the threads map', () => {
      // sanitizeThreadsMap is internal — verify its contract via the
      // write/read round-trip. A buggy caller (e.g., a test fixture passing
      // a stale number) must not persist garbage that poisons the next read.
      writeMarker(collabDir, {
        broadcast: 'b',
        threads: {
          'thread-ok': 'id-ok',
          'thread-nonstring': 42,
          '': 'empty-key',
          'thread-empty-value': ''
        }
      });
      assert.deepEqual(readMarker(collabDir),
        { broadcast: 'b', threads: { 'thread-ok': 'id-ok' } });
    });
  });
});
