import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';
import {
  dispatchEvent,
  readBridgeFresh,
  seedBookmarkIfFresh
} from '../../broker/bridge.mjs';

const require = createRequire(import.meta.url);
const { ensureCollabDir } = require('../../lib/collab-dir');
const { busPath, readBookmark, writeBookmark, append } = require('../../lib/bus-log');
const { withAgentsLock } = require('../../lib/agents');
const { createEvent } = require('../../lib/bus-schema');
const { BRIDGE_SESSION_ID } = require('../../lib/constants');
const busMeta = require('../../lib/bus-meta');
const { mergePolicy } = require('../../lib/mirror-policy');

// Minimal threads stub — records calls so tests can assert which methods fired.
function makeThreadsStub(overrides = {}) {
  const calls = {
    getThreadIdFor: [],
    ensureThreadForSession: [],
    renameThread: [],
    archiveThread: []
  };
  const stub = {
    getThreadIdFor: (sid) => {
      calls.getThreadIdFor.push(sid);
      return overrides.getThreadIdFor ? overrides.getThreadIdFor(sid) : null;
    },
    ensureThreadForSession: async (sid, hint) => {
      calls.ensureThreadForSession.push({ sid, hint });
      return overrides.ensureThreadForSession
        ? await overrides.ensureThreadForSession(sid, hint)
        : 'thread-' + sid;
    },
    renameThread: async (sid, newTask) => {
      calls.renameThread.push({ sid, newTask });
      return overrides.renameThread
        ? await overrides.renameThread(sid, newTask)
        : 'thread-' + sid;
    },
    archiveThread: async (sid) => {
      calls.archiveThread.push(sid);
      return overrides.archiveThread ? await overrides.archiveThread(sid) : 'thread-' + sid;
    }
  };
  stub._calls = calls;
  return stub;
}

// Minimal api stub — only postMessage is exercised by dispatchEvent.
function makeApiStub(overrides = {}) {
  const calls = { postMessage: [] };
  const stub = {
    postMessage: async (channelId, content) => {
      calls.postMessage.push({ channelId, content });
      return overrides.postMessage
        ? await overrides.postMessage(channelId, content)
        : { id: 'msg-' + Date.now() };
    }
  };
  stub._calls = calls;
  return stub;
}

const BASE_CONFIG = {
  discord: {
    BROADCAST_CHANNEL_ID: 'broadcast-999',
    FORUM_CHANNEL_ID: 'forum-888'
  }
};

describe('broker/bridge', () => {
  let tmpDir, collabDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-unit-'));
    collabDir = ensureCollabDir(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('dispatchEvent', () => {
    const policy = mergePolicy();

    it('skips events with meta.source=discord (loop guard — prevents rebroadcast)', async () => {
      const threads = makeThreadsStub();
      const api = makeApiStub();
      const event = {
        type: 'user_message', from: 'sess-aaaaaaaa', to: 'sess-bbbbbbbb',
        body: 'hi', meta: { source: 'discord' }
      };
      const result = await dispatchEvent(event, policy, threads, api, BASE_CONFIG, collabDir);
      assert.equal(result, false);
      assert.equal(api._calls.postMessage.length, 0);
    });

    it('returns false for silent events (note/finding/decision default to silent)', async () => {
      const threads = makeThreadsStub();
      const api = makeApiStub();
      const event = {
        type: 'note', from: 'sess-aaaaaaaa', to: 'all', body: 'routine note'
      };
      const result = await dispatchEvent(event, policy, threads, api, BASE_CONFIG, collabDir);
      assert.equal(result, false);
      assert.equal(api._calls.postMessage.length, 0);
    });

    it('posts to the broadcast channel for session_started (post_broadcast action)', async () => {
      const threads = makeThreadsStub();
      const api = makeApiStub();
      const event = {
        type: 'session_started', from: 'sess-aaaaaaaa', to: 'all', body: 'session up'
      };
      const result = await dispatchEvent(event, policy, threads, api, BASE_CONFIG, collabDir);
      assert.equal(result, true);
      assert.equal(api._calls.postMessage.length, 1);
      assert.equal(api._calls.postMessage[0].channelId, 'broadcast-999');
    });

    it('posts to an existing mapped thread (getThreadIdFor returns non-null)', async () => {
      const threads = makeThreadsStub({
        getThreadIdFor: (sid) => (sid === 'sess-bbbbbbbb' ? 'thread-existing' : null)
      });
      const api = makeApiStub();
      const event = {
        type: 'handoff', from: 'sess-aaaaaaaa', to: 'sess-bbbbbbbb',
        body: 'take over'
      };
      const result = await dispatchEvent(event, policy, threads, api, BASE_CONFIG, collabDir);
      assert.equal(result, true);
      assert.equal(threads._calls.ensureThreadForSession.length, 0,
        'must not re-create when mapping exists');
      assert.equal(api._calls.postMessage.length, 1);
      assert.equal(api._calls.postMessage[0].channelId, 'thread-existing');
    });

    it('creates a thread lazily when no mapping exists, then posts to the new thread', async () => {
      const threads = makeThreadsStub({
        getThreadIdFor: () => null,
        ensureThreadForSession: async (sid) => 'thread-new-' + sid
      });
      const api = makeApiStub();
      const event = {
        type: 'handoff', from: 'sess-aaaaaaaa', to: 'sess-bbbbbbbb',
        body: 'take over'
      };
      const result = await dispatchEvent(event, policy, threads, api, BASE_CONFIG, collabDir);
      assert.equal(result, true);
      assert.equal(threads._calls.ensureThreadForSession.length, 1);
      assert.equal(threads._calls.ensureThreadForSession[0].sid, 'sess-bbbbbbbb');
      assert.equal(api._calls.postMessage[0].channelId, 'thread-new-sess-bbbbbbbb');
    });

    it('renames thread on context_updated (rename_thread action) using meta.new_task', async () => {
      const threads = makeThreadsStub();
      const api = makeApiStub();
      const event = {
        type: 'context_updated', from: 'sess-aaaaaaaa', to: 'all',
        body: 'stale-body-task',
        meta: { prev_task: 'old', new_task: 'new shiny task' }
      };
      const result = await dispatchEvent(event, policy, threads, api, BASE_CONFIG, collabDir);
      assert.equal(result, true);
      assert.equal(threads._calls.renameThread.length, 1);
      assert.equal(threads._calls.renameThread[0].sid, 'sess-aaaaaaaa');
      assert.equal(threads._calls.renameThread[0].newTask, 'new shiny task',
        'rename must prefer meta.new_task over event.body');
      assert.equal(api._calls.postMessage.length, 0,
        'rename_thread does not post a message — PATCH only');
    });

    it('rename_thread falls back to event.body when meta.new_task is absent', async () => {
      const threads = makeThreadsStub();
      const api = makeApiStub();
      const event = {
        type: 'context_updated', from: 'sess-aaaaaaaa', to: 'all',
        body: 'body-encoded task'
      };
      await dispatchEvent(event, policy, threads, api, BASE_CONFIG, collabDir);
      assert.equal(threads._calls.renameThread.length, 1);
      assert.equal(threads._calls.renameThread[0].newTask, 'body-encoded task');
    });

    it('returns false from rename_thread when renameThread yields no id', async () => {
      const threads = makeThreadsStub({
        renameThread: async () => null
      });
      const api = makeApiStub();
      const event = {
        type: 'context_updated', from: 'sess-aaaaaaaa', to: 'all',
        body: 'whatever'
      };
      const result = await dispatchEvent(event, policy, threads, api, BASE_CONFIG, collabDir);
      assert.equal(result, false);
    });
  });

  describe('seedBookmarkIfFresh', () => {
    it('no-ops when bookmark already has lastDeliveredOffset > 0', () => {
      withAgentsLock(collabDir, (token) => {
        writeBookmark(token, collabDir, BRIDGE_SESSION_ID, {
          lastDeliveredOffset: 50,
          lastScannedOffset: 50,
          lastDeliveredId: '',
          lastDeliveredTs: 0,
          generation: 0
        });
      });
      seedBookmarkIfFresh(collabDir);
      const bm = readBookmark(collabDir, BRIDGE_SESSION_ID);
      assert.equal(bm.lastDeliveredOffset, 50, 'bookmark must be preserved');
    });

    it('seeds both offsets to 0 when bus.jsonl does not exist yet', () => {
      assert.equal(fs.existsSync(busPath(collabDir)), false);
      seedBookmarkIfFresh(collabDir);
      const bm = readBookmark(collabDir, BRIDGE_SESSION_ID);
      assert.equal(bm.lastDeliveredOffset, 0);
      assert.equal(bm.lastScannedOffset, 0);
    });

    it('seeds both offsets to current bus.jsonl file size when bus has history', () => {
      withAgentsLock(collabDir, (token) => {
        append(token, collabDir, createEvent('sess-aaaaaaaa', 'all', 'note', 'hello'));
        append(token, collabDir, createEvent('sess-aaaaaaaa', 'all', 'note', 'world'));
      });
      const size = fs.statSync(busPath(collabDir)).size;
      assert.ok(size > 0, 'precondition: bus.jsonl has content');

      seedBookmarkIfFresh(collabDir);
      const bm = readBookmark(collabDir, BRIDGE_SESSION_ID);
      assert.equal(bm.lastDeliveredOffset, size,
        'must seed to current file size so history is NOT re-mirrored');
      assert.equal(bm.lastScannedOffset, size);
    });

    it('preserves current meta.generation in the seeded bookmark', () => {
      busMeta.writeMeta(collabDir, { generation: 7, eventCount: 0, lastTs: 0 });
      seedBookmarkIfFresh(collabDir);
      const bm = readBookmark(collabDir, BRIDGE_SESSION_ID);
      assert.equal(bm.generation, 7);
    });
  });

  describe('readBridgeFresh', () => {
    it('returns no events and endOffset=0 when bus.jsonl is empty', () => {
      let out;
      withAgentsLock(collabDir, (token) => {
        out = readBridgeFresh(token, collabDir);
      });
      assert.deepEqual(out.events, []);
      assert.equal(out.endOffset, 0);
      assert.equal(out.isStale, false);
    });

    it('returns all appended events when the bookmark starts at offset 0', () => {
      withAgentsLock(collabDir, (token) => {
        append(token, collabDir, createEvent('sess-aaaaaaaa', 'all', 'note', 'a'));
        append(token, collabDir, createEvent('sess-aaaaaaaa', 'all', 'note', 'b'));
      });
      let out;
      withAgentsLock(collabDir, (token) => {
        out = readBridgeFresh(token, collabDir);
      });
      assert.equal(out.events.length, 2);
      assert.equal(out.events[0].body, 'a');
      assert.equal(out.events[1].body, 'b');
    });

    it('marks the bookmark stale and rescans from offset 0 on generation mismatch', () => {
      // Append a real event so something is available to rescan.
      withAgentsLock(collabDir, (token) => {
        append(token, collabDir, createEvent('sess-aaaaaaaa', 'all', 'note', 'one'));
      });
      // Seed a bookmark with a generation that doesn't match meta (meta is still 0).
      withAgentsLock(collabDir, (token) => {
        writeBookmark(token, collabDir, BRIDGE_SESSION_ID, {
          lastDeliveredOffset: 999,
          lastScannedOffset: 999,
          lastDeliveredId: '',
          lastDeliveredTs: 0,
          generation: 999
        });
      });
      let out;
      withAgentsLock(collabDir, (token) => {
        out = readBridgeFresh(token, collabDir);
      });
      assert.equal(out.isStale, true, 'generation mismatch must set isStale=true');
      assert.equal(out.events.length, 1, 'fromOffset=0 rescan must surface the event');
      assert.equal(out.events[0].body, 'one');
    });

    it('applies ts+id dedup when fromOffset <= lastDeliveredOffset (prevents double-mirror)', () => {
      // Append two events, mark the first as already-delivered via bookmark,
      // then expect the dedup filter to drop it while keeping the second.
      let firstId, firstTs;
      withAgentsLock(collabDir, (token) => {
        const e1 = createEvent('sess-aaaaaaaa', 'all', 'note', 'first');
        const e2 = createEvent('sess-aaaaaaaa', 'all', 'note', 'second');
        append(token, collabDir, e1);
        append(token, collabDir, e2);
        firstId = e1.id;
        firstTs = e1.ts;
      });
      withAgentsLock(collabDir, (token) => {
        writeBookmark(token, collabDir, BRIDGE_SESSION_ID, {
          lastDeliveredOffset: 0,       // forces fromOffset=0 (not stale, same gen)
          lastScannedOffset: 0,
          lastDeliveredId: firstId,
          lastDeliveredTs: firstTs,
          generation: 0
        });
      });
      let out;
      withAgentsLock(collabDir, (token) => {
        out = readBridgeFresh(token, collabDir);
      });
      assert.equal(out.events.length, 1,
        'dedup must drop the event already delivered at lastDeliveredTs/lastDeliveredId');
      assert.equal(out.events[0].body, 'second');
    });
  });
});
