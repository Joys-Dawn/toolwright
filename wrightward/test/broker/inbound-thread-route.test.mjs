import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';
import { createInboundPoller, readMarker, writeMarker } from '../../broker/inbound-poll.mjs';

const require = createRequire(import.meta.url);
const { ensureCollabDir } = require('../../lib/collab-dir');
const agents = require('../../lib/agents');
const { registerAgent } = agents;
const { busPath } = require('../../lib/bus-log');
const { atomicWriteJson } = require('../../lib/atomic-write');
const { DiscordApiError } = require('../../discord/api');
const { createThreads } = require('../../discord/threads');

// Mock API that keys message queues per channel so the poller's broadcast +
// thread streams get isolated responses. Each channel's queue is drained in
// order — first getMessagesAfter(c) returns queue[c][0], next returns [1],
// and so on; empty `[]` is returned when the queue runs out.
function makeChannelMockApi(perChannelQueues) {
  const calls = [];
  const rejects = new Map(); // channelId → Error to throw
  const api = {
    async getMessagesAfter(channelId, afterId, limit) {
      calls.push({ channelId, afterId, limit });
      if (rejects.has(channelId)) {
        throw rejects.get(channelId);
      }
      const q = perChannelQueues[channelId];
      if (!q || q.length === 0) return [];
      return q.shift();
    }
  };
  api.calls = calls;
  api.rejectFor = (channelId, err) => rejects.set(channelId, err);
  api.clearRejectFor = (channelId) => rejects.delete(channelId);
  return api;
}

function readBus(collabDir) {
  const bp = busPath(collabDir);
  if (!fs.existsSync(bp)) return [];
  return fs.readFileSync(bp, 'utf8').trim().split('\n').filter(Boolean)
    .map((l) => JSON.parse(l));
}

// Writes a thread index entry directly, matching the shape that
// discord/threads.js creates via ensureThreadForSession.
function writeThreadsIndex(collabDir, idx) {
  atomicWriteJson(path.join(collabDir, 'bus-index/discord-threads.json'), idx);
}

// Exercises the REAL discord/threads.js::listActiveThreads — guarantees the
// tests pick up any future semantic change to the active-threads contract.
// listActiveThreads only reads the index file, so we pass a no-op `api` and
// a placeholder forum-channel id to satisfy the factory's argument checks.
function makeThreadsProvider(collabDir) {
  return createThreads(collabDir, {}, 'forum-noop').listActiveThreads;
}

describe('broker/inbound-poll thread routing', () => {
  let tmpDir, collabDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-thread-route-'));
    collabDir = ensureCollabDir(tmpDir);
    registerAgent(collabDir, 'sess-aaaaaaaa1');
    registerAgent(collabDir, 'sess-bbbbbbbb2');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // Test 1 from plan.
  it('routes a thread-only reply to the thread owner with no mention required', async () => {
    writeThreadsIndex(collabDir, {
      'sess-aaaaaaaa1': { thread_id: 'thread-A', archived_at: null, rendered_name: 'task (sess-aaa)' }
    });
    // Seed both streams so no first-run ingest-skip fires.
    writeMarker(collabDir, { broadcast: 'seed-b', threads: { 'thread-A': 'seed-A' } });

    const api = makeChannelMockApi({
      'b': [[]],
      'thread-A': [[
        { id: 'mA1', author: { id: 'u1', bot: false }, content: 'try Map not Object' }
      ]]
    });

    const p = createInboundPoller(collabDir, api, {
      broadcastChannelId: 'b',
      allowedSenders: ['u1'],
      threadsProvider: makeThreadsProvider(collabDir)
    });
    await p.pollOnce();

    const events = readBus(collabDir).filter((e) => e.type === 'user_message');
    assert.equal(events.length, 1);
    assert.equal(events[0].to, 'sess-aaaaaaaa1');
    assert.equal(events[0].body, 'try Map not Object');
    assert.equal(events[0].meta.discord_thread_id, 'thread-A');
    assert.equal(events[0].meta.discord_channel_id, 'thread-A');
  });

  // Test 2 from plan.
  it('fan-outs thread reply with @mention to both thread owner and mentioned session', async () => {
    writeThreadsIndex(collabDir, {
      'sess-aaaaaaaa1': { thread_id: 'thread-A', archived_at: null, rendered_name: 't' }
    });
    writeMarker(collabDir, { broadcast: 'seed-b', threads: { 'thread-A': 'seed-A' } });

    const api = makeChannelMockApi({
      'b': [[]],
      'thread-A': [[
        { id: 'mA1', author: { id: 'u1', bot: false },
          content: '@agent-sess-bbbbbbbb2 look at this' }
      ]]
    });

    const p = createInboundPoller(collabDir, api, {
      broadcastChannelId: 'b',
      allowedSenders: ['u1'],
      threadsProvider: makeThreadsProvider(collabDir)
    });
    await p.pollOnce();

    const events = readBus(collabDir).filter((e) => e.type === 'user_message');
    assert.equal(events.length, 1);
    // Array-form `to` — thread owner first, then mentioned session in message order.
    assert.deepEqual(events[0].to, ['sess-aaaaaaaa1', 'sess-bbbbbbbb2']);
    assert.equal(events[0].body, 'look at this');
  });

  // Test 3 from plan.
  it('dedupes when the mention resolves to the thread owner itself', async () => {
    writeThreadsIndex(collabDir, {
      'sess-aaaaaaaa1': { thread_id: 'thread-A', archived_at: null, rendered_name: 't' }
    });
    writeMarker(collabDir, { broadcast: 'seed-b', threads: { 'thread-A': 'seed-A' } });

    const api = makeChannelMockApi({
      'b': [[]],
      'thread-A': [[
        { id: 'mA1', author: { id: 'u1', bot: false },
          content: '@agent-sess-aaaaaaaa1 ping' }
      ]]
    });

    const p = createInboundPoller(collabDir, api, {
      broadcastChannelId: 'b',
      allowedSenders: ['u1'],
      threadsProvider: makeThreadsProvider(collabDir)
    });
    await p.pollOnce();

    const events = readBus(collabDir).filter((e) => e.type === 'user_message');
    assert.equal(events.length, 1);
    // Single-target → string form (not array with one item).
    assert.equal(events[0].to, 'sess-aaaaaaaa1');
  });

  // Test 4 from plan.
  it('routes ambiguous short-id alongside thread owner and sets meta.ambiguous_mention', async () => {
    // Two sessions share the same 8-char prefix 'sess-xx'.
    registerAgent(collabDir, 'sess-xxxx0001');
    registerAgent(collabDir, 'sess-xxxx0002');
    writeThreadsIndex(collabDir, {
      'sess-aaaaaaaa1': { thread_id: 'thread-A', archived_at: null, rendered_name: 't' }
    });
    writeMarker(collabDir, { broadcast: 'seed-b', threads: { 'thread-A': 'seed-A' } });

    const api = makeChannelMockApi({
      'b': [[]],
      'thread-A': [[
        { id: 'mA1', author: { id: 'u1', bot: false },
          content: '@agent-sess-xxx something' }
      ]]
    });

    const p = createInboundPoller(collabDir, api, {
      broadcastChannelId: 'b',
      allowedSenders: ['u1'],
      threadsProvider: makeThreadsProvider(collabDir)
    });
    await p.pollOnce();

    const events = readBus(collabDir).filter((e) => e.type === 'user_message');
    assert.equal(events.length, 1);
    assert.deepEqual(events[0].to, ['sess-aaaaaaaa1', 'all']);
    assert.equal(events[0].meta.ambiguous_mention, true);
  });

  // Test 5 from plan.
  it('does not poll archived threads', async () => {
    writeThreadsIndex(collabDir, {
      'sess-aaaaaaaa1': { thread_id: 'thread-A', archived_at: Date.now(), rendered_name: 't' },
      'sess-bbbbbbbb2': { thread_id: 'thread-B', archived_at: null, rendered_name: 't' }
    });
    writeMarker(collabDir, { broadcast: 'seed-b', threads: {
      'thread-A': 'seed-A', 'thread-B': 'seed-B'
    } });

    const api = makeChannelMockApi({ 'b': [[]], 'thread-B': [[]] });

    const p = createInboundPoller(collabDir, api, {
      broadcastChannelId: 'b',
      allowedSenders: ['u1'],
      threadsProvider: makeThreadsProvider(collabDir)
    });
    await p.pollOnce();

    const channels = api.calls.map((c) => c.channelId);
    assert.ok(!channels.includes('thread-A'),
      'archived thread must not be polled. Channels called: ' + JSON.stringify(channels));
    assert.ok(channels.includes('thread-B'));
    assert.ok(channels.includes('b'));
  });

  // Test 6 from plan.
  it('seeds a per-thread marker on first poll without ingesting history', async () => {
    writeThreadsIndex(collabDir, {
      'sess-aaaaaaaa1': { thread_id: 'thread-A', archived_at: null, rendered_name: 't' }
    });
    // Seed broadcast so only the thread needs seeding.
    writeMarker(collabDir, { broadcast: 'seed-b', threads: {} });

    const api = makeChannelMockApi({
      'b': [[]],
      // First getMessagesAfter(thread-A, null, 1) returns newest message.
      'thread-A': [[
        { id: 'old-newest', author: { id: 'u1', bot: false },
          content: '@agent-sess-aaa stale' }
      ]]
    });

    const p = createInboundPoller(collabDir, api, {
      broadcastChannelId: 'b',
      allowedSenders: ['u1'],
      threadsProvider: makeThreadsProvider(collabDir)
    });
    const r = await p.pollOnce();

    assert.equal(r.ingested, 0, 'seed must not ingest history');
    assert.equal(readBus(collabDir).filter((e) => e.type === 'user_message').length, 0);
    const mk = readMarker(collabDir);
    assert.equal(mk.threads['thread-A'], 'old-newest');
  });

  // Test 7 from plan.
  it('advances the per-thread marker after a poll that ingests new messages', async () => {
    writeThreadsIndex(collabDir, {
      'sess-aaaaaaaa1': { thread_id: 'thread-A', archived_at: null, rendered_name: 't' }
    });
    writeMarker(collabDir, { broadcast: 'seed-b', threads: { 'thread-A': 'old-m' } });

    const api = makeChannelMockApi({
      'b': [[]],
      'thread-A': [[
        { id: 'new-m3', author: { id: 'u1', bot: false }, content: 'third' },
        { id: 'new-m2', author: { id: 'u1', bot: false }, content: 'second' },
        { id: 'new-m1', author: { id: 'u1', bot: false }, content: 'first' }
      ]]
    });

    const p = createInboundPoller(collabDir, api, {
      broadcastChannelId: 'b',
      allowedSenders: ['u1'],
      threadsProvider: makeThreadsProvider(collabDir)
    });
    await p.pollOnce();

    const mk = readMarker(collabDir);
    assert.equal(mk.threads['thread-A'], 'new-m3');
    // Processed chronologically: first, second, third in bus order.
    const events = readBus(collabDir).filter((e) => e.type === 'user_message');
    assert.equal(events.length, 3);
    assert.equal(events[0].body, 'first');
    assert.equal(events[2].body, 'third');
  });

  // Test 8 from plan.
  it('readMarker migrates legacy { last_polled_message_id } to the new shape', () => {
    // Write legacy shape directly.
    atomicWriteJson(path.join(collabDir, 'bridge/last-polled.json'),
      { last_polled_message_id: 'legacy-X' });
    const mk = readMarker(collabDir);
    assert.deepEqual(mk, { broadcast: 'legacy-X', threads: {} });
  });

  // Test 9 from plan.
  it('isolates per-thread rejections: one 403 does not stop broadcast or other threads', async () => {
    writeThreadsIndex(collabDir, {
      'sess-aaaaaaaa1': { thread_id: 'thread-A', archived_at: null, rendered_name: 't' },
      'sess-bbbbbbbb2': { thread_id: 'thread-B', archived_at: null, rendered_name: 't' }
    });
    writeMarker(collabDir, { broadcast: 'seed-b', threads: {
      'thread-A': 'seed-A', 'thread-B': 'seed-B'
    } });

    const api = makeChannelMockApi({
      'b': [[{ id: 'mb', author: { id: 'u1', bot: false },
              content: '@agent-sess-aaaaaaaa1 from broadcast' }]],
      'thread-B': [[{ id: 'mB', author: { id: 'u1', bot: false },
                     content: 'from B thread' }]]
    });
    // thread-A throws a 403 when polled — simulates mid-tick archival.
    api.rejectFor('thread-A', new DiscordApiError(403, 'Forbidden'));

    const logs = [];
    const p = createInboundPoller(collabDir, api, {
      broadcastChannelId: 'b',
      allowedSenders: ['u1'],
      threadsProvider: makeThreadsProvider(collabDir),
      logger: (line) => logs.push(line)
    });
    await p.pollOnce();

    const events = readBus(collabDir).filter((e) => e.type === 'user_message');
    // Broadcast and thread-B both drained despite thread-A's failure.
    const bodies = events.map((e) => e.body).sort();
    assert.deepEqual(bodies, ['from B thread', 'from broadcast'].sort());
    // Logged the specific thread error with the thread_id for operator triage.
    assert.ok(
      logs.some((l) => l.includes('thread thread-A') && l.includes('error')),
      'expected a log line mentioning the failed thread id; got: ' + JSON.stringify(logs)
    );
  });

  // Test 10 from plan.
  it('thread poll with no messages is a no-op — marker unchanged, no lock/append', async () => {
    writeThreadsIndex(collabDir, {
      'sess-aaaaaaaa1': { thread_id: 'thread-A', archived_at: null, rendered_name: 't' }
    });
    writeMarker(collabDir, { broadcast: 'seed-b', threads: { 'thread-A': 'stable-marker' } });

    const api = makeChannelMockApi({ 'b': [[]], 'thread-A': [[]] });
    const p = createInboundPoller(collabDir, api, {
      broadcastChannelId: 'b',
      allowedSenders: ['u1'],
      threadsProvider: makeThreadsProvider(collabDir)
    });
    await p.pollOnce();

    assert.equal(readBus(collabDir).length, 0);
    // Marker unchanged — empty response must not touch state.
    assert.equal(readMarker(collabDir).threads['thread-A'], 'stable-marker');
  });

  // Test 11 from plan.
  it('does not hold the agents lock while fetching from Discord', async (t) => {
    // inbound-poll.mjs binds the agents module as a namespace (not destructured),
    // so property access `agents.withAgentsLock` resolves at call time and
    // `t.mock.method` actually intercepts. Captures inLockCallback synchronously
    // around the (synchronous) file-lock callback; asserts that no
    // getMessagesAfter call fires while the flag is set.
    writeThreadsIndex(collabDir, {
      'sess-aaaaaaaa1': { thread_id: 'thread-A', archived_at: null, rendered_name: 't' }
    });
    writeMarker(collabDir, { broadcast: 'seed-b', threads: { 'thread-A': 'seed-A' } });

    let inLockCallback = false;
    let violated = false;

    const api = {
      async getMessagesAfter(channelId) {
        if (inLockCallback) violated = true;
        if (channelId === 'thread-A') {
          return [{ id: 'mA', author: { id: 'u1', bot: false }, content: 'hi' }];
        }
        return [];
      }
    };

    const originalWithLock = agents.withAgentsLock;
    t.mock.method(agents, 'withAgentsLock', function (dir, fn) {
      inLockCallback = true;
      try {
        return originalWithLock.call(this, dir, function (token) {
          return fn(token);
        });
      } finally {
        inLockCallback = false;
      }
    });

    const p = createInboundPoller(collabDir, api, {
      broadcastChannelId: 'b',
      allowedSenders: ['u1'],
      threadsProvider: makeThreadsProvider(collabDir)
    });
    await p.pollOnce();

    assert.equal(violated, false, 'getMessagesAfter must never run inside withAgentsLock');
    // Guard against vacuous pass: if the mock never fired, the test would be
    // trivially green no matter what the poller did. The prior monkey-patch
    // shape (which destructured withAgentsLock at module-load time) silently
    // suffered exactly this bug.
    assert.ok(agents.withAgentsLock.mock.callCount() > 0,
      'mocked withAgentsLock must have been invoked — test would otherwise be vacuous');
  });

  // Test 12 from plan.
  it('picks up threads added to the index between ticks', async () => {
    writeThreadsIndex(collabDir, {}); // start empty
    writeMarker(collabDir, { broadcast: 'seed-b', threads: {} });

    const api = makeChannelMockApi({
      'b': [[], []],
      'thread-NEW': [
        // First call after thread appears: seed returns newest-only message
        [{ id: 'new-seed', author: { id: 'u1', bot: false }, content: 'old' }],
        // Second call after seed: no new messages
        []
      ]
    });

    const p = createInboundPoller(collabDir, api, {
      broadcastChannelId: 'b',
      allowedSenders: ['u1'],
      threadsProvider: makeThreadsProvider(collabDir)
    });

    await p.pollOnce(); // no threads yet
    let channels = api.calls.map((c) => c.channelId);
    assert.ok(!channels.includes('thread-NEW'));

    // Thread appears in index (as ensureThreadForSession would have written).
    writeThreadsIndex(collabDir, {
      'sess-aaaaaaaa1': { thread_id: 'thread-NEW', archived_at: null, rendered_name: 't' }
    });

    await p.pollOnce();
    channels = api.calls.map((c) => c.channelId);
    assert.ok(channels.includes('thread-NEW'),
      'newly-registered thread must be polled on next tick');
  });

  // Test 13 from plan.
  it('gracefully degrades to broadcast-only when no threads are registered', async () => {
    writeMarker(collabDir, { broadcast: 'seed-b', threads: {} });
    writeThreadsIndex(collabDir, {});

    const api = makeChannelMockApi({
      'b': [[{ id: 'mb', author: { id: 'u1', bot: false },
              content: '@agent-sess-aaaaaaaa1 hi' }]]
    });

    const p = createInboundPoller(collabDir, api, {
      broadcastChannelId: 'b',
      allowedSenders: ['u1'],
      threadsProvider: makeThreadsProvider(collabDir)
    });
    await p.pollOnce();

    const channels = new Set(api.calls.map((c) => c.channelId));
    assert.deepEqual([...channels], ['b']);
    const events = readBus(collabDir).filter((e) => e.type === 'user_message');
    assert.equal(events.length, 1);
    assert.equal(events[0].to, 'sess-aaaaaaaa1');
    // Broadcast-only meta: discord_thread_id is null.
    assert.equal(events[0].meta.discord_thread_id, null);
    assert.equal(events[0].meta.discord_channel_id, 'b');
  });

  // Coverage gap — security parity plan §Requirements #3. The bot filter
  // must apply to thread-context routing. Without this check a Discord bot
  // (including the bridge's own mirror) posting in a forum thread could
  // ingest as a user_message, creating loops.
  it('filters bot-author messages posted inside a forum thread', async () => {
    writeThreadsIndex(collabDir, {
      'sess-aaaaaaaa1': { thread_id: 'thread-A', archived_at: null, rendered_name: 't' }
    });
    writeMarker(collabDir, { broadcast: 'seed-b', threads: { 'thread-A': 'seed-A' } });

    const api = makeChannelMockApi({
      'b': [[]],
      'thread-A': [[
        { id: 'mA-bot', author: { id: 'bot-1', bot: true }, content: 'loop candidate' }
      ]]
    });

    const p = createInboundPoller(collabDir, api, {
      broadcastChannelId: 'b',
      // Include 'bot-1' so the test isolates the bot-flag filter — otherwise
      // the allowlist would short-circuit before the bot check.
      allowedSenders: ['u1', 'bot-1'],
      threadsProvider: makeThreadsProvider(collabDir)
    });
    await p.pollOnce();

    const events = readBus(collabDir).filter((e) => e.type === 'user_message');
    assert.equal(events.length, 0,
      'bot messages must never route via thread context — same rule as broadcast');
  });

  // Coverage gap — security parity plan §Requirements #3. Thread-context
  // routing must NOT bypass the allowedSenders gate; otherwise anyone
  // visible in the forum channel could address an agent simply by posting
  // in its thread.
  it('rejects thread messages from non-allowlisted users', async () => {
    writeThreadsIndex(collabDir, {
      'sess-aaaaaaaa1': { thread_id: 'thread-A', archived_at: null, rendered_name: 't' }
    });
    writeMarker(collabDir, { broadcast: 'seed-b', threads: { 'thread-A': 'seed-A' } });

    const api = makeChannelMockApi({
      'b': [[]],
      'thread-A': [[
        { id: 'mA-stranger', author: { id: 'u-stranger', bot: false },
          content: 'hello from a stranger' }
      ]]
    });

    const p = createInboundPoller(collabDir, api, {
      broadcastChannelId: 'b',
      allowedSenders: ['u-trusted'],
      threadsProvider: makeThreadsProvider(collabDir)
    });
    await p.pollOnce();

    const events = readBus(collabDir).filter((e) => e.type === 'user_message');
    assert.equal(events.length, 0,
      'thread context does not override the allowlist; only allowlisted users route');
  });

  // Coverage gap — plan §Requirement #5 + Risks: a failed per-thread fetch
  // must NOT advance the marker, or a transient 5xx would cause the next
  // tick to skip whatever messages arrived during the failure window.
  // Test 9 pins stream isolation; this pins marker stability.
  it('does not advance the thread marker when a post-seed fetch rejects', async () => {
    writeThreadsIndex(collabDir, {
      'sess-aaaaaaaa1': { thread_id: 'thread-A', archived_at: null, rendered_name: 't' }
    });
    writeMarker(collabDir, {
      broadcast: 'seed-b', threads: { 'thread-A': 'stable-marker' }
    });

    const api = makeChannelMockApi({ 'b': [[]] });
    api.rejectFor('thread-A', new DiscordApiError(500, 'Internal Server Error'));

    const p = createInboundPoller(collabDir, api, {
      broadcastChannelId: 'b',
      allowedSenders: ['u1'],
      threadsProvider: makeThreadsProvider(collabDir),
      logger: () => {}
    });
    await p.pollOnce();

    assert.equal(readMarker(collabDir).threads['thread-A'], 'stable-marker',
      'marker must not advance when the fetch throws — next tick retries from the same id');
  });

  // Regression guard — if the initial seed fetch throws, seededStreams must
  // NOT latch. Without the guard, next tick would fetch with afterId=null
  // and no explicit limit, causing Discord to return its default 50-message
  // window — every pre-existing mention replays as brand-new user_message.
  it('retries seeding when the first seed fetch throws and does not ingest history', async () => {
    writeThreadsIndex(collabDir, {
      'sess-aaaaaaaa1': { thread_id: 'thread-A', archived_at: null, rendered_name: 't' }
    });
    // Broadcast already seeded — isolates the thread-seed code path.
    writeMarker(collabDir, { broadcast: 'seed-b', threads: {} });

    let threadCallCount = 0;
    const api = {
      calls: [],
      async getMessagesAfter(channelId, afterId, limit) {
        this.calls.push({ channelId, afterId, limit });
        if (channelId === 'thread-A') {
          threadCallCount++;
          if (threadCallCount === 1) {
            throw new Error('simulated transient failure during seed');
          }
          return [{
            id: 'reseed-mA',
            author: { id: 'u1', bot: false },
            content: 'must not ingest on seed retry'
          }];
        }
        return [];
      }
    };

    const p = createInboundPoller(collabDir, api, {
      broadcastChannelId: 'b',
      allowedSenders: ['u1'],
      threadsProvider: makeThreadsProvider(collabDir),
      logger: () => {}
    });

    await p.pollOnce();
    assert.equal(readMarker(collabDir).threads['thread-A'], undefined,
      'seed failure must leave the thread marker absent — stream not yet seeded');

    await p.pollOnce();

    assert.equal(readMarker(collabDir).threads['thread-A'], 'reseed-mA',
      'successful seed retry must store the marker');
    const events = readBus(collabDir).filter((e) => e.type === 'user_message');
    assert.equal(events.length, 0,
      'retried seed must not ingest — otherwise a transient error replays history');
    const threadCalls = api.calls.filter((c) => c.channelId === 'thread-A');
    assert.equal(threadCalls.length, 2);
    // Both calls are seed-style — Discord default limit (no value passed)
    // is 50, so passing limit=1 is what pins "seed only the newest".
    assert.equal(threadCalls[0].limit, 1);
    assert.equal(threadCalls[0].afterId, null);
    assert.equal(threadCalls[1].limit, 1);
    assert.equal(threadCalls[1].afterId, null);
  });

  // Coverage gap — safeListActiveThreads wraps threadsProvider() in try/catch
  // so a corrupt index or buggy provider cannot starve the broadcast stream.
  it('isolates threadsProvider failures: broadcast drains when the provider throws', async () => {
    writeMarker(collabDir, { broadcast: 'seed-b', threads: {} });
    const api = makeChannelMockApi({
      'b': [[
        { id: 'mb-ok', author: { id: 'u1', bot: false },
          content: '@agent-sess-aaaaaaaa1 broadcast is fine' }
      ]]
    });

    const logs = [];
    const p = createInboundPoller(collabDir, api, {
      broadcastChannelId: 'b',
      allowedSenders: ['u1'],
      threadsProvider: () => { throw new Error('provider blew up'); },
      logger: (line) => logs.push(line)
    });
    await p.pollOnce();

    const events = readBus(collabDir).filter((e) => e.type === 'user_message');
    assert.equal(events.length, 1);
    assert.equal(events[0].to, 'sess-aaaaaaaa1',
      'broadcast must drain regardless of threadsProvider failure');
    assert.ok(
      logs.some((l) => l.includes('threadsProvider error')),
      'provider failure must be logged for operator visibility; got: ' + JSON.stringify(logs)
    );
  });

  // Plan §User-Facing Behavior / Error states: when Message Content Intent
  // is disabled in the Discord dev portal, msg.content === '' for every
  // non-bot-mention message. In thread context the routing no longer depends
  // on content (thread owner IS the route), so the event still appends with
  // a placeholder body. This is a v3.3 UX improvement over broadcast-only mode.
  it('routes a thread reply with empty content and sets body to "(empty)"', async () => {
    writeThreadsIndex(collabDir, {
      'sess-aaaaaaaa1': { thread_id: 'thread-A', archived_at: null, rendered_name: 't' }
    });
    writeMarker(collabDir, { broadcast: 'seed-b', threads: { 'thread-A': 'seed-A' } });

    const api = makeChannelMockApi({
      'b': [[]],
      'thread-A': [[{ id: 'mA-empty', author: { id: 'u1', bot: false }, content: '' }]]
    });

    const p = createInboundPoller(collabDir, api, {
      broadcastChannelId: 'b',
      allowedSenders: ['u1'],
      threadsProvider: makeThreadsProvider(collabDir)
    });
    await p.pollOnce();

    const events = readBus(collabDir).filter((e) => e.type === 'user_message');
    assert.equal(events.length, 1);
    assert.equal(events[0].to, 'sess-aaaaaaaa1');
    assert.equal(events[0].body, '(empty)',
      'MCI-disabled thread replies still route via thread context; body falls back to "(empty)"');
  });
});
