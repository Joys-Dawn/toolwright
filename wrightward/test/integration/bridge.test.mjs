// Integration: spawn broker/bridge.mjs as a real child process against a
// local HTTP fixture server. Exercises the full outbound and inbound
// pipelines end-to-end (file-watcher → readBridgeFresh → dispatch → REST;
// inbound-poll → sanitize → bus append) without reaching discord.com.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import http from 'http';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { ensureCollabDir } = require('../../lib/collab-dir');
const { registerAgent, withAgentsLock } = require('../../lib/agents');
const { append, busPath } = require('../../lib/bus-log');
const { createEvent, SYNTHETIC_SENDER } = require('../../lib/bus-schema');
const { writeContext } = require('../../lib/context');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BRIDGE_ENTRY = path.resolve(__dirname, '../../broker/bridge.mjs');

const FORUM_CHANNEL_ID = 'forum-111';
const BROADCAST_CHANNEL_ID = 'broadcast-222';

function makeFixtureServer(handlers) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let parsed = null;
      if (body) {
        try { parsed = JSON.parse(body); } catch (_) { parsed = body; }
      }
      const url = new URL(req.url, 'http://x');
      const call = {
        method: req.method,
        path: url.pathname,
        search: url.search,
        query: Object.fromEntries(url.searchParams),
        body: parsed,
        headers: req.headers
      };
      calls.push(call);
      const handler = handlers && handlers[req.method + ' ' + url.pathname];
      let response;
      if (typeof handler === 'function') {
        response = handler(call, calls.length - 1);
      } else if (handler) {
        response = handler;
      } else {
        response = { status: 200, body: {} };
      }
      res.statusCode = response.status || 200;
      for (const [k, v] of Object.entries(response.headers || {})) {
        res.setHeader(k, v);
      }
      if (!res.getHeader('Content-Type')) {
        res.setHeader('Content-Type', 'application/json');
      }
      res.end(typeof response.body === 'string'
        ? response.body
        : JSON.stringify(response.body ?? {}));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({
        server,
        port: addr.port,
        baseUrl: 'http://127.0.0.1:' + addr.port + '/api/v10',
        calls,
        close: () => new Promise((r) => server.close(r))
      });
    });
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 5000);
  while (Date.now() < deadline) {
    try { if (predicate()) return; } catch (_) {}
    await sleep(50);
  }
  throw new Error('waitFor timeout');
}

function writeWrightwardConfig(cwd) {
  const claudeDir = path.join(cwd, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, 'wrightward.json'), JSON.stringify({
    discord: {
      ENABLED: true,
      FORUM_CHANNEL_ID,
      BROADCAST_CHANNEL_ID,
      ALLOWED_SENDERS: ['user-allowed-1'],
      POLL_INTERVAL_MS: 500
    }
  }));
}

function spawnBridge(cwd, baseUrl, diag) {
  const child = spawn(process.execPath, [BRIDGE_ENTRY, cwd], {
    cwd,
    env: {
      ...process.env,
      DISCORD_BOT_TOKEN: 'fake-bot-token',
      DISCORD_API_BASE_URL: baseUrl
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  if (diag) {
    child.stderr.on('data', (d) => diag.stderr.push(d.toString()));
    child.stdout.on('data', (d) => diag.stdout.push(d.toString()));
    child.on('exit', (code, signal) => diag.exits.push({ code, signal, t: Date.now() }));
  }
  return child;
}

function readBus(collabDir) {
  const bp = busPath(collabDir);
  if (!fs.existsSync(bp)) return [];
  return fs.readFileSync(bp, 'utf8').trim().split('\n').filter(Boolean)
    .map((l) => JSON.parse(l));
}

describe('integration: bridge daemon', () => {
  let tmpDir, collabDir, fixture, child;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-int-'));
    collabDir = ensureCollabDir(tmpDir);
    writeWrightwardConfig(tmpDir);
  });

  afterEach(async () => {
    if (child && !child.killed) {
      child.kill('SIGTERM');
      // Allow up to 2s for graceful exit.
      await Promise.race([
        new Promise((r) => child.once('exit', r)),
        sleep(2000)
      ]);
      if (!child.killed) { try { child.kill('SIGKILL'); } catch (_) {} }
    }
    child = null;
    if (fixture) await fixture.close();
    fixture = null;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  });

  it('seeds bookmark to tail on first start and does not mirror historical events', async () => {
    // Prepopulate 10 historical bus events.
    registerAgent(collabDir, 'sess-aaaaaaaa');
    for (let i = 0; i < 10; i++) {
      withAgentsLock(collabDir, (token) => {
        append(token, collabDir, createEvent('sess-aaaaaaaa', 'all', 'session_started',
          'historical-' + i));
      });
    }

    fixture = await makeFixtureServer({
      [`GET /api/v10/channels/${BROADCAST_CHANNEL_ID}/messages`]: { status: 200, body: [] },
      [`POST /api/v10/channels/${FORUM_CHANNEL_ID}/threads`]: (call) => ({
        status: 200, body: { id: 'thread-' + Date.now(), name: call.body && call.body.name }
      }),
      [`POST /api/v10/channels/${BROADCAST_CHANNEL_ID}/messages`]: {
        status: 200, body: { id: 'msg-1' }
      }
    });

    child = spawnBridge(tmpDir, fixture.baseUrl);

    // Give the bridge time to seed its bookmark to EOF and for the initial
    // tick to no-op on historical events.
    await sleep(1500);

    const postsBefore = fixture.calls.filter((c) => c.method === 'POST').length;
    assert.equal(postsBefore, 0, 'no POSTs should fire for historical events');

    // Now append ONE new session_started; policy → post_broadcast. Expect
    // exactly one POST to the broadcast channel.
    registerAgent(collabDir, 'sess-bbbbbbbb');
    withAgentsLock(collabDir, (token) => {
      append(token, collabDir, createEvent('sess-bbbbbbbb', 'all', 'session_started',
        'new-session'));
    });

    await waitFor(() => fixture.calls.some((c) =>
      c.method === 'POST' &&
      c.path === '/api/v10/channels/' + BROADCAST_CHANNEL_ID + '/messages'), 5000);

    const broadcastPosts = fixture.calls.filter((c) =>
      c.method === 'POST' &&
      c.path === '/api/v10/channels/' + BROADCAST_CHANNEL_ID + '/messages');
    assert.equal(broadcastPosts.length, 1);
    assert.match(broadcastPosts[0].body.content, /new-session/);
  });

  it('sets the DiscordBot User-Agent and Bot auth header on every request', async () => {
    fixture = await makeFixtureServer({
      [`GET /api/v10/channels/${BROADCAST_CHANNEL_ID}/messages`]: { status: 200, body: [] }
    });
    const diag = { stderr: [], stdout: [], exits: [] };
    child = spawnBridge(tmpDir, fixture.baseUrl, diag);
    try {
      await waitFor(() => fixture.calls.some((c) => c.method === 'GET'), 5000);
    } catch (err) {
      let bridgeLog = '(no log file)';
      try {
        bridgeLog = fs.readFileSync(path.join(collabDir, 'bridge', 'bridge.log'), 'utf8');
      } catch (_) {}
      throw new Error('bridge never hit fixture. exits:' + JSON.stringify(diag.exits) +
        '\nstderr:\n' + diag.stderr.join('') +
        '\nstdout:\n' + diag.stdout.join('') +
        '\nbridge.log:\n' + bridgeLog);
    }
    const first = fixture.calls[0];
    assert.equal(first.headers.authorization, 'Bot fake-bot-token');
    assert.match(first.headers['user-agent'], /^DiscordBot /);
  });

  it('routes an inbound @agent-<shortId> mention into bus.jsonl as a user_message', async () => {
    registerAgent(collabDir, 'sess-ccccc111');
    // First-run seeding swallows the first GET response (to avoid replaying
    // pre-existing broadcast history). Serve an empty seed response, then
    // the real @agent message on the next poll, then empty forever.
    let getCallCount = 0;
    fixture = await makeFixtureServer({
      [`GET /api/v10/channels/${BROADCAST_CHANNEL_ID}/messages`]: () => {
        getCallCount++;
        if (getCallCount === 1) return { status: 200, body: [] }; // seed
        if (getCallCount === 2) {
          return { status: 200, body: [
            { id: 'msg-inbound-1', author: { id: 'user-allowed-1', bot: false },
              content: '@agent-sess-ccc please check the logs' }
          ] };
        }
        return { status: 200, body: [] };
      },
      [`POST /api/v10/channels/${FORUM_CHANNEL_ID}/threads`]: (call) => ({
        status: 200, body: { id: 'thread-new', name: call.body && call.body.name }
      }),
      [`POST /api/v10/channels/${BROADCAST_CHANNEL_ID}/messages`]: {
        status: 200, body: { id: 'sent-1' }
      }
    });

    child = spawnBridge(tmpDir, fixture.baseUrl);

    await waitFor(() => readBus(collabDir).some((e) => e.type === 'user_message'), 5000);
    const events = readBus(collabDir).filter((e) => e.type === 'user_message');
    assert.equal(events.length, 1);
    assert.equal(events[0].to, 'sess-ccccc111');
    assert.match(events[0].body, /please check the logs/);
    assert.equal(events[0].meta.source, 'discord');
    assert.equal(events[0].meta.discord_user_id, 'user-allowed-1');
    assert.equal(events[0].from, SYNTHETIC_SENDER);
  });

  it('loop-guard: events with meta.source=discord are NOT mirrored back', async () => {
    registerAgent(collabDir, 'sess-ddddd222');
    fixture = await makeFixtureServer({
      [`GET /api/v10/channels/${BROADCAST_CHANNEL_ID}/messages`]: { status: 200, body: [] }
    });
    child = spawnBridge(tmpDir, fixture.baseUrl);

    // Wait for the bridge to connect at least once so we know it is running.
    await waitFor(() => fixture.calls.some((c) => c.method === 'GET'), 5000);

    // Append a user_message that's already from Discord — the loop-guard
    // in bridge.mjs must refuse to mirror it back.
    withAgentsLock(collabDir, (token) => {
      append(token, collabDir, createEvent(SYNTHETIC_SENDER, 'sess-ddddd222', 'user_message',
        'from discord side', { source: 'discord', discord_user_id: 'u1' }));
    });

    // Give the bridge a full poll cycle + some margin to confirm nothing
    // was posted.
    await sleep(1500);

    const posts = fixture.calls.filter((c) =>
      c.method === 'POST' && c.path.endsWith('/messages'));
    assert.equal(posts.length, 0, 'discord-sourced event must not be echoed back');
  });

  it('routes a handoff to the recipient thread only (not broadcast) and archives on session_ended', async () => {
    registerAgent(collabDir, 'sess-sender01');
    registerAgent(collabDir, 'sess-recip002');
    writeContext(collabDir, 'sess-sender01', { task: 'sender task', files: [], functions: [], status: 'in-progress' });
    writeContext(collabDir, 'sess-recip002', { task: 'recipient task', files: [], functions: [], status: 'in-progress' });

    const threadIdBySession = {};
    let archivePatches = 0;
    fixture = await makeFixtureServer({
      [`GET /api/v10/channels/${BROADCAST_CHANNEL_ID}/messages`]: { status: 200, body: [] },
      [`POST /api/v10/channels/${FORUM_CHANNEL_ID}/threads`]: (call) => {
        // Derive a distinct thread ID per invocation so we can verify the
        // handoff post targets the recipient's thread, not the sender's.
        const name = (call.body && call.body.name) || '';
        const id = 'thread-' + Object.keys(threadIdBySession).length;
        threadIdBySession[name] = id;
        return { status: 200, body: { id, name } };
      },
      [`POST /api/v10/channels/${BROADCAST_CHANNEL_ID}/messages`]: {
        status: 200, body: { id: 'msg-broadcast' }
      }
    });
    // A wildcard handler for thread posts — record them by path.
    const savedHandler = fixture.server.listeners('request')[0];
    // Instead of stitching a wildcard into makeFixtureServer, rely on the
    // default 200 {} response for POSTs to thread IDs and the calls array
    // which captures every request.

    child = spawnBridge(tmpDir, fixture.baseUrl);
    // Wait for the bridge to be fully up (first inbound poll hits the fixture).
    await waitFor(() => fixture.calls.some((c) => c.method === 'GET'), 5000);

    // Trigger two session_starts so both threads are pre-created via the
    // broker's session_started handling in dispatch/runOutboundTick.
    withAgentsLock(collabDir, (token) => {
      append(token, collabDir, createEvent('sess-sender01', 'all', 'session_started', 'sender online'));
    });
    withAgentsLock(collabDir, (token) => {
      append(token, collabDir, createEvent('sess-recip002', 'all', 'session_started', 'recipient online'));
    });

    // Wait for both threads to be created.
    await waitFor(() => Object.keys(threadIdBySession).length >= 2, 5000);
    const senderThreadId = Object.values(threadIdBySession)[0];
    const recipThreadId = Object.values(threadIdBySession)[1];
    assert.notEqual(senderThreadId, recipThreadId);

    // Now emit a handoff from sender → recipient. It should post into the
    // recipient's thread, not the sender's.
    withAgentsLock(collabDir, (token) => {
      append(token, collabDir, createEvent('sess-sender01', 'sess-recip002', 'handoff',
        'please finish the migration'));
    });
    await waitFor(() => fixture.calls.some((c) =>
      c.method === 'POST' &&
      c.path === `/api/v10/channels/${recipThreadId}/messages` &&
      /please finish the migration/.test(JSON.stringify(c.body))), 5000);
    // Sender's thread must NOT have received the handoff payload.
    const senderPosts = fixture.calls.filter((c) =>
      c.method === 'POST' &&
      c.path === `/api/v10/channels/${senderThreadId}/messages` &&
      /please finish the migration/.test(JSON.stringify(c.body)));
    assert.equal(senderPosts.length, 0, 'handoff must not echo into sender thread');

    // session_ended on the recipient should trigger a PATCH with archived:true.
    withAgentsLock(collabDir, (token) => {
      append(token, collabDir, createEvent('sess-recip002', 'all', 'session_ended',
        'recipient offline'));
    });
    await waitFor(() => {
      archivePatches = fixture.calls.filter((c) =>
        c.method === 'PATCH' &&
        c.path === `/api/v10/channels/${recipThreadId}` &&
        c.body && c.body.archived === true).length;
      return archivePatches >= 1;
    }, 5000);
    assert.ok(archivePatches >= 1, 'session_ended must archive the recipient thread');
    // Ensure no cross-archival.
    const senderArchives = fixture.calls.filter((c) =>
      c.method === 'PATCH' &&
      c.path === `/api/v10/channels/${senderThreadId}` &&
      c.body && c.body.archived === true);
    assert.equal(senderArchives.length, 0);
  });

  it('persists the outbound bookmark across a bridge restart (no re-mirroring)', async () => {
    registerAgent(collabDir, 'sess-eeeee333');
    writeContext(collabDir, 'sess-eeeee333', { task: 'start', files: [], functions: [], status: 'in-progress' });

    fixture = await makeFixtureServer({
      [`GET /api/v10/channels/${BROADCAST_CHANNEL_ID}/messages`]: { status: 200, body: [] },
      [`POST /api/v10/channels/${FORUM_CHANNEL_ID}/threads`]: (call) => ({
        status: 200, body: { id: 'thread-e', name: call.body && call.body.name }
      }),
      [`POST /api/v10/channels/${BROADCAST_CHANNEL_ID}/messages`]: {
        status: 200, body: { id: 'sent-e' }
      }
    });

    child = spawnBridge(tmpDir, fixture.baseUrl);
    // Wait until the bridge's initial tick has seeded the bookmark.
    await sleep(1500);

    withAgentsLock(collabDir, (token) => {
      append(token, collabDir, createEvent('sess-eeeee333', 'all', 'session_started',
        'first-run-session'));
    });
    await waitFor(() => fixture.calls.some((c) =>
      c.method === 'POST' &&
      c.path === '/api/v10/channels/' + BROADCAST_CHANNEL_ID + '/messages'), 5000);

    const broadcastPostsRun1 = fixture.calls.filter((c) =>
      c.method === 'POST' &&
      c.path === '/api/v10/channels/' + BROADCAST_CHANNEL_ID + '/messages').length;
    assert.equal(broadcastPostsRun1, 1);

    // Tear down bridge, keep fixture + bus as-is.
    child.kill('SIGTERM');
    await Promise.race([
      new Promise((r) => child.once('exit', r)),
      sleep(2000)
    ]);
    child = null;

    // Restart bridge — bookmark should resume past the already-posted event.
    child = spawnBridge(tmpDir, fixture.baseUrl);
    await sleep(1500);

    const broadcastPostsRun2 = fixture.calls.filter((c) =>
      c.method === 'POST' &&
      c.path === '/api/v10/channels/' + BROADCAST_CHANNEL_ID + '/messages').length;
    assert.equal(broadcastPostsRun2, 1,
      'restart must not re-mirror the event delivered in the prior run');
  });

  it('401 from Discord trips the 1-hour circuit breaker and exits with SELF_RECORDED code', async () => {
    // Covers the auth-failure bail-out: a bad bot token causes Discord to
    // return 401 on every outbound call, and the bridge must (a) write its
    // own 1h circuit-breaker entry so the parent MCP skips respawn, and
    // (b) exit with SELF_RECORDED_FAILURE_EXIT_CODE (=2) so the parent's
    // child.on('exit') handler does NOT clobber the 1h window with a
    // shorter backoff bucket.
    registerAgent(collabDir, 'sess-aaaaaaaa');

    fixture = await makeFixtureServer({
      [`GET /api/v10/channels/${BROADCAST_CHANNEL_ID}/messages`]: { status: 200, body: [] },
      // Any outbound POST returns 401 — mirrors a rotated/invalid bot token.
      [`POST /api/v10/channels/${BROADCAST_CHANNEL_ID}/messages`]: {
        status: 401, body: { code: 0, message: '401: Unauthorized' }
      },
      [`POST /api/v10/channels/${FORUM_CHANNEL_ID}/threads`]: {
        status: 401, body: { code: 0, message: '401: Unauthorized' }
      }
    });

    const diag = { stderr: [], stdout: [], exits: [] };
    child = spawnBridge(tmpDir, fixture.baseUrl, diag);
    await sleep(1500); // let seeding + watcher attach complete

    // Append a session_started targeted at "all" — dispatches to broadcast.
    withAgentsLock(collabDir, (token) => {
      append(token, collabDir, createEvent('sess-aaaaaaaa', 'all', 'session_started',
        'auth-fail-probe'));
    });

    // Bridge should exit shortly after the 401 with code 2.
    await waitFor(() => diag.exits.length > 0, 5000);
    const exitEvent = diag.exits[0];
    assert.equal(exitEvent.code, 2,
      'bridge must exit with SELF_RECORDED_FAILURE_EXIT_CODE (2) on 401');

    // Circuit breaker file must contain the 1h ceiling.
    const cbPath = path.join(collabDir, 'bridge', 'circuit-breaker.json');
    assert.ok(fs.existsSync(cbPath), 'circuit-breaker.json must be written');
    const cb = JSON.parse(fs.readFileSync(cbPath, 'utf8'));
    const fiftyMinFromNow = Date.now() + 50 * 60 * 1000;
    assert.ok(cb.disabled_until_ts > fiftyMinFromNow,
      'disabled_until_ts must be at least 50 min in the future (1h ceiling ± clock drift)');
    child = null; // already exited; afterEach skips kill
  });

  // Thread-reply round-trip: user replies in a forum thread and the message
  // appends as `user_message` targeting the thread owner, with meta carrying
  // the thread id. Thread-context routing does NOT require an @mention.
  it('routes a reply inside an agent forum thread back to that agent via bus.jsonl', async () => {
    registerAgent(collabDir, 'sess-ccccc111');
    writeContext(collabDir, 'sess-ccccc111', {
      task: 'thread reply test', files: [], functions: [], status: 'in-progress'
    });

    const THREAD_ID = 'thread-reply-route';
    let threadGetCalls = 0;
    fixture = await makeFixtureServer({
      [`GET /api/v10/channels/${BROADCAST_CHANNEL_ID}/messages`]: { status: 200, body: [] },
      [`POST /api/v10/channels/${FORUM_CHANNEL_ID}/threads`]: () => ({
        status: 200, body: { id: THREAD_ID, name: 'thread reply test (sess-ccc)' }
      }),
      [`POST /api/v10/channels/${BROADCAST_CHANNEL_ID}/messages`]: {
        status: 200, body: { id: 'bcast-1' }
      },
      [`POST /api/v10/channels/${THREAD_ID}/messages`]: {
        status: 200, body: { id: 'mirrored-into-thread' }
      },
      // First GET is the per-thread seed — empty, so the poller marks the
      // stream seeded and on the next tick fetches real messages. Second GET
      // returns the user's reply. Subsequent GETs are empty to keep the test
      // deterministic — we only care about the single ingestion event.
      [`GET /api/v10/channels/${THREAD_ID}/messages`]: () => {
        threadGetCalls++;
        if (threadGetCalls === 1) return { status: 200, body: [] };
        if (threadGetCalls === 2) {
          return {
            status: 200, body: [
              { id: 'reply-msg-1', author: { id: 'user-allowed-1', bot: false },
                content: 'help me debug the login flow' }
            ]
          };
        }
        return { status: 200, body: [] };
      }
    });

    child = spawnBridge(tmpDir, fixture.baseUrl);

    // Drive thread creation via session_started (same handler that creates
    // forum threads in the real bridge lifecycle).
    await waitFor(() => fixture.calls.some((c) => c.method === 'GET'), 5000);
    withAgentsLock(collabDir, (token) => {
      append(token, collabDir, createEvent('sess-ccccc111', 'all', 'session_started',
        'session online'));
    });

    // Wait until the bridge has both created the thread AND ingested the
    // user reply back into bus.jsonl.
    await waitFor(() => {
      const events = readBus(collabDir).filter((e) => e.type === 'user_message');
      return events.length >= 1;
    }, 8000);

    const events = readBus(collabDir).filter((e) => e.type === 'user_message');
    assert.equal(events.length, 1);
    assert.equal(events[0].to, 'sess-ccccc111',
      'thread-context routing delivers to the thread owner without an @mention');
    assert.match(events[0].body, /help me debug the login flow/);
    assert.equal(events[0].meta.source, 'discord');
    assert.equal(events[0].meta.discord_thread_id, THREAD_ID);
    assert.equal(events[0].meta.discord_channel_id, THREAD_ID);
    assert.equal(events[0].from, SYNTHETIC_SENDER);
  });
});
