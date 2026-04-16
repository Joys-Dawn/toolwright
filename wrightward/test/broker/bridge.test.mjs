import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';
import {
  dispatchEvent,
  readBridgeFresh,
  seedBookmarkIfFresh,
  runDrainLoop
} from '../../broker/bridge.mjs';

// Seeds agents.json with a registered row for each given sessionId so the
// bridge's roster-based post_thread guard (added when the ghost-UUID fix
// removed the lazy-create path) accepts the target. Without a row, the
// guard drops the post with a log — which is the correct behavior, but
// breaks tests that used to rely on lazy-create materializing a thread.
function seedRegisteredAgents(collabDir, sessionIds) {
  const { registerAgent } = require('../../lib/agents');
  for (const sid of sessionIds) registerAgent(collabDir, sid);
}

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

    it('returns false for silent events (e.g. file_freed broadcast: targeted-only by default)', async () => {
      // file_freed with to="all" is post_thread_if_targeted → silent. Exercises
      // the bridge's silent short-circuit without assuming any event type
      // defaults to silent outright.
      const threads = makeThreadsStub();
      const api = makeApiStub();
      const event = {
        type: 'file_freed', from: 'sess-aaaaaaaa', to: 'all', body: 'file X freed'
      };
      const result = await dispatchEvent(event, policy, threads, api, BASE_CONFIG, collabDir);
      assert.equal(result, false);
      assert.equal(api._calls.postMessage.length, 0);
    });

    it('returns false for silent events when user policy demotes a type to silent', async () => {
      // Covers the "user-demoted" path: if a user overrides (say) note → silent,
      // the bridge must respect that even though note defaults to post_thread.
      const threads = makeThreadsStub();
      const api = makeApiStub();
      const customPolicy = mergePolicy({ note: { action: 'silent' } });
      const event = {
        type: 'note', from: 'sess-aaaaaaaa', to: 'sess-bbbbbbbb', body: 'hushed note'
      };
      const result = await dispatchEvent(event, customPolicy, threads, api, BASE_CONFIG, collabDir);
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
      seedRegisteredAgents(collabDir, ['sess-bbbbbbbb']);
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

    // Reads the bridge log for assertions. appendLog writes to
    // <collabDir>/bridge/bridge.log (see broker/lifecycle.mjs::logPath).
    // Returns '' when the file doesn't exist so tests can assert absence.
    function readBridgeLog() {
      const p = path.join(collabDir, 'bridge', 'bridge.log');
      return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
    }

    it('drops post_thread (no lazy-create) when target is not in agents.json', async () => {
      // Regression test for the ghost-UUID fix. Agents that hallucinated
      // plausible full UUIDs used to get a real Discord thread materialized
      // here by the lazy-create branch. The fix drops the post with a log
      // entry — silent/successful dispatch MUST NOT happen and MUST NOT
      // call ensureThreadForSession.
      // No seedRegisteredAgents — agents.json has no row for the target.
      const threads = makeThreadsStub({
        getThreadIdFor: () => null
      });
      const api = makeApiStub();
      const event = {
        type: 'handoff', from: 'sess-aaaaaaaa', to: 'sess-ghost',
        body: 'hallucinated target'
      };
      const result = await dispatchEvent(event, policy, threads, api, BASE_CONFIG, collabDir);
      assert.equal(result, false, 'must drop (return false), not succeed');
      assert.equal(threads._calls.ensureThreadForSession.length, 0,
        'lazy-create path removed — must not be exercised');
      assert.equal(api._calls.postMessage.length, 0,
        'no Discord post for a ghost target');
      // Operator-visibility half of "drop with a log": a silent drop would
      // leave operators blind when agents hallucinate UUIDs. Pin the exact
      // reason string so a regression can't swap in a generic message.
      assert.match(readBridgeLog(),
        /post_thread dropped: sess-ghost not in agents\.json/);
    });

    it('drops post_thread when target IS registered but has no thread (reconcile race)', async () => {
      // Registered agents must have had a thread created by the startup
      // reconciliation pass. If reconcile failed mid-batch and a post lands
      // for one of the gaps, drop rather than silently create — predictable
      // thread inventory is worth the dropped event.
      seedRegisteredAgents(collabDir, ['sess-bbbbbbbb']);
      const threads = makeThreadsStub({
        getThreadIdFor: () => null
      });
      const api = makeApiStub();
      const event = {
        type: 'handoff', from: 'sess-aaaaaaaa', to: 'sess-bbbbbbbb',
        body: 'hey'
      };
      const result = await dispatchEvent(event, policy, threads, api, BASE_CONFIG, collabDir);
      assert.equal(result, false);
      assert.equal(api._calls.postMessage.length, 0);
      assert.equal(threads._calls.ensureThreadForSession.length, 0);
      // Distinct reason from the not-in-agents.json path so operators can
      // tell "hallucinated UUID" from "reconcile race" in bridge.log.
      assert.match(readBridgeLog(),
        /post_thread dropped: sess-bbbbbbbb has no thread \(reconcile may have failed\)/);
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

    it('routes agent_message with to="user" to the sender\'s own thread (not broadcast)', async () => {
      // v3.4 routing special case: replies addressed to the human user land
      // in the sender's forum thread so the conversation stays inline. Pre-
      // v3.4 these events broadcast, scattering the conversation.
      seedRegisteredAgents(collabDir, ['sess-sender-a']);
      const threads = makeThreadsStub({
        getThreadIdFor: (sid) => (sid === 'sess-sender-a' ? 'thread-sender-a' : null)
      });
      const api = makeApiStub();
      const event = {
        type: 'agent_message', from: 'sess-sender-a', to: 'user',
        body: 'hello human'
      };
      const result = await dispatchEvent(event, policy, threads, api, BASE_CONFIG, collabDir);
      assert.equal(result, true);
      assert.equal(api._calls.postMessage.length, 1);
      assert.equal(api._calls.postMessage[0].channelId, 'thread-sender-a',
        'must post to sender\'s thread, NOT broadcast channel');
      assert.notEqual(api._calls.postMessage[0].channelId, 'broadcast-999');
    });

    it('posts multiple chunks for a long body to the broadcast channel in order', async () => {
      // Bodies that exceed CONTENT_CAP (1800) split into ordered posts. The
      // bridge must dispatch each chunk in sequence to the same channel —
      // no silent truncation, no scatter across channels.
      const { CONTENT_CAP } = require('../../discord/formatter');
      const threads = makeThreadsStub();
      const api = makeApiStub();
      const longBody = 'x'.repeat(CONTENT_CAP * 3);
      const event = {
        type: 'session_started', from: 'sess-aaaaaaaa', to: 'all',
        body: longBody
      };
      const result = await dispatchEvent(event, policy, threads, api, BASE_CONFIG, collabDir);
      assert.equal(result, true);
      assert.ok(api._calls.postMessage.length >= 3,
        'expected ≥3 postMessage calls for 3× cap body, got ' + api._calls.postMessage.length);
      for (const call of api._calls.postMessage) {
        assert.equal(call.channelId, 'broadcast-999',
          'every chunk must dispatch to the same channel');
      }
    });

    it('posts multiple chunks for a long body to a thread in order', async () => {
      const { CONTENT_CAP } = require('../../discord/formatter');
      seedRegisteredAgents(collabDir, ['sess-bbbbbbbb']);
      const threads = makeThreadsStub({
        getThreadIdFor: (sid) => (sid === 'sess-bbbbbbbb' ? 'thread-bb' : null)
      });
      const api = makeApiStub();
      const event = {
        type: 'handoff', from: 'sess-aaaaaaaa', to: 'sess-bbbbbbbb',
        body: 'z'.repeat(CONTENT_CAP * 2 + 200)
      };
      const result = await dispatchEvent(event, policy, threads, api, BASE_CONFIG, collabDir);
      assert.equal(result, true);
      assert.ok(api._calls.postMessage.length >= 2,
        'expected ≥2 postMessage calls for 2× cap body');
      for (const call of api._calls.postMessage) {
        assert.equal(call.channelId, 'thread-bb',
          'every chunk must land in the same thread');
      }
      // First chunk carries the full handle prefix; continuations carry ↳.
      assert.match(api._calls.postMessage[0].content, /\[handoff\]/);
      assert.match(api._calls.postMessage[1].content, /^↳/,
        'second chunk should start with continuation marker');
    });

    it('drops agent_message + to="user" when sender is not in agents.json', async () => {
      // Regression guard: the new routing points target_session_id at
      // event.from. If the sender's sessionId hallucinated or was pruned
      // between event write and dispatch, the same ghost-UUID drop path
      // must fire — otherwise we'd create phantom threads for dead agents.
      const threads = makeThreadsStub({
        getThreadIdFor: () => null
      });
      const api = makeApiStub();
      // No seedRegisteredAgents — sender sess-ghosted is absent.
      const event = {
        type: 'agent_message', from: 'sess-ghosted', to: 'user',
        body: 'reply from a ghost'
      };
      const result = await dispatchEvent(event, policy, threads, api, BASE_CONFIG, collabDir);
      assert.equal(result, false);
      assert.equal(api._calls.postMessage.length, 0);
      assert.equal(threads._calls.ensureThreadForSession.length, 0);
      const log = fs.readFileSync(path.join(collabDir, 'bridge', 'bridge.log'), 'utf8');
      assert.match(log,
        /post_thread dropped: sess-ghosted not in agents\.json/);
    });

    it('drops agent_message + to="user" when sender is registered but has no thread', async () => {
      // Reconcile race: sender exists in agents.json but the startup
      // reconcile failed to create a thread for it. The bridge must drop
      // (not lazy-create) to keep thread inventory predictable.
      seedRegisteredAgents(collabDir, ['sess-sender-b']);
      const threads = makeThreadsStub({
        getThreadIdFor: () => null
      });
      const api = makeApiStub();
      const event = {
        type: 'agent_message', from: 'sess-sender-b', to: 'user',
        body: 'reply'
      };
      const result = await dispatchEvent(event, policy, threads, api, BASE_CONFIG, collabDir);
      assert.equal(result, false);
      assert.equal(api._calls.postMessage.length, 0);
      assert.equal(threads._calls.ensureThreadForSession.length, 0);
      const log = fs.readFileSync(path.join(collabDir, 'bridge', 'bridge.log'), 'utf8');
      assert.match(log,
        /post_thread dropped: sess-sender-b has no thread \(reconcile may have failed\)/);
    });

    it('chunks a long agent_message + to="user" into ordered posts to sender\'s thread', async () => {
      // Integration of the two changes: routing a long user-facing reply
      // must BOTH land in the sender's thread AND split into ordered
      // chunks. Neither half alone catches a regression that breaks both.
      const { CONTENT_CAP } = require('../../discord/formatter');
      seedRegisteredAgents(collabDir, ['sess-sender-c']);
      const threads = makeThreadsStub({
        getThreadIdFor: (sid) => (sid === 'sess-sender-c' ? 'thread-c' : null)
      });
      const api = makeApiStub();
      const event = {
        type: 'agent_message', from: 'sess-sender-c', to: 'user',
        body: 'Here is the plan:\n' + 'q'.repeat(CONTENT_CAP * 2 + 500)
      };
      const result = await dispatchEvent(event, policy, threads, api, BASE_CONFIG, collabDir);
      assert.equal(result, true);
      assert.ok(api._calls.postMessage.length >= 2,
        'long body must split into ≥2 chunks');
      for (const call of api._calls.postMessage) {
        assert.equal(call.channelId, 'thread-c',
          'every chunk must land in the sender\'s own thread, not broadcast');
      }
    });

    it('mid-sequence chunk failure throws (earlier chunks already posted)', async () => {
      // If chunk 2 of 3 fails, chunk 1 stays posted in Discord and the error
      // propagates to the outer drain loop. The bookmark won't advance, so
      // next tick re-fires the whole event — chunk 1 duplicates on retry.
      // That's the v1 tradeoff (see plan Risks section).
      const { CONTENT_CAP } = require('../../discord/formatter');
      const threads = makeThreadsStub();
      let call = 0;
      const api = makeApiStub({
        postMessage: async () => {
          call++;
          if (call === 2) throw new Error('simulated Discord 5xx');
          return { id: 'msg-' + call };
        }
      });
      const event = {
        type: 'session_started', from: 'sess-aaaaaaaa', to: 'all',
        body: 'y'.repeat(CONTENT_CAP * 3)
      };
      await assert.rejects(
        dispatchEvent(event, policy, threads, api, BASE_CONFIG, collabDir),
        /simulated Discord 5xx/);
      // Chunk 1 posted before the failure; no third chunk attempted.
      assert.equal(call, 2, 'loop must abort on chunk 2 failure, not try chunk 3');
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

  // Regression guard for the final-session session_ended drain: a single
  // drain tick at shutdown was not enough when cleanup.js appended the
  // event AFTER the tick read the bus. The loop re-runs the tick until
  // the deadline so late appends are still caught.
  describe('runDrainLoop', () => {
    // Fake time-and-sleep controller. Drives the loop deterministically so
    // tests are instant — no real setTimeout, no wall clock.
    function makeClock() {
      let t = 0;
      return {
        now: () => t,
        sleep: (ms) => { t += ms; return Promise.resolve(); },
        advance: (ms) => { t += ms; }
      };
    }

    it('invokes tick multiple times within the deadline window', async () => {
      const clock = makeClock();
      let ticks = 0;
      await runDrainLoop({
        tick: async () => { ticks++; },
        deadlineMs: 1000,
        pollMs: 250,
        now: clock.now,
        sleep: clock.sleep
      });
      // Fake clock advances only via sleep (ticks themselves are instant).
      // Iteration N runs at t = N * pollMs; loop stops when now >= deadline.
      // With deadline=1000, pollMs=250: ticks at t=0, 250, 500, 750 → 4.
      assert.equal(ticks, 4, 'drain must poll repeatedly within the deadline');
    });

    it('returns promptly when the deadline is already in the past', async () => {
      const clock = makeClock();
      let ticks = 0;
      await runDrainLoop({
        tick: async () => { ticks++; },
        deadlineMs: -1,
        pollMs: 250,
        now: clock.now,
        sleep: clock.sleep
      });
      assert.equal(ticks, 0, 'expired deadline must skip the loop body entirely');
    });

    it('swallows tick errors via onError and keeps polling', async () => {
      const clock = makeClock();
      const errors = [];
      let ticks = 0;
      await runDrainLoop({
        tick: async () => {
          ticks++;
          if (ticks === 2) throw new Error('simulated tick failure');
        },
        deadlineMs: 800,
        pollMs: 250,
        onError: (err) => errors.push(err.message),
        now: clock.now,
        sleep: clock.sleep
      });
      // Iterations at t=0, 250, 500, 750 → 4 ticks; one throw; loop keeps going.
      assert.equal(ticks, 4);
      assert.deepEqual(errors, ['simulated tick failure']);
    });

    it('does not sleep after the final iteration', async () => {
      // Guards against wasted wall-clock time on shutdown: the final
      // iteration must not block for pollMs before the outer Promise.race
      // can wake and exit.
      const clock = makeClock();
      const sleepCalls = [];
      await runDrainLoop({
        tick: async () => {},
        deadlineMs: 500,
        pollMs: 250,
        now: clock.now,
        sleep: (ms) => { sleepCalls.push(ms); clock.advance(ms); return Promise.resolve(); }
      });
      // Iterations at t=0, 250 → 2 ticks. Between iteration 1 and 2 we sleep
      // once. After iteration 2, now=500 >= deadline → no trailing sleep.
      assert.equal(sleepCalls.length, 1,
        'sleep must not fire after the last iteration');
    });
  });
});
