import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { ensureCollabDir } = require('../../lib/collab-dir');
const { registerAgent, readAgents, withAgentsLock } = require('../../lib/agents');
const { handleFor } = require('../../lib/handles');
const { writeContext } = require('../../lib/context');
const { append, readBookmark, busPath } = require('../../lib/bus-log');
const { createEvent } = require('../../lib/bus-schema');
const interestIndex = require('../../lib/interest-index');
const { loadConfig } = require('../../lib/config');

// Import the ESM tools module
const { getToolDefinitions, handleToolCall } = await import('../../mcp/tools.mjs');

describe('mcp/tools', () => {
  let tmpDir;
  let collabDir;
  let config;

  function handleOf(sid) {
    return handleFor(sid, readAgents(collabDir)[sid]);
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-tools-'));
    collabDir = ensureCollabDir(tmpDir);
    config = loadConfig(tmpDir);
    registerAgent(collabDir, 'sess-1');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('getToolDefinitions', () => {
    it('returns the expected tool set including wrightward_whoami', () => {
      const tools = getToolDefinitions();
      const names = tools.map(t => t.name).sort();
      assert.deepEqual(names, [
        'wrightward_ack',
        'wrightward_bus_status',
        'wrightward_list_inbox',
        'wrightward_send_handoff',
        'wrightward_send_message',
        'wrightward_send_note',
        'wrightward_watch_file',
        'wrightward_whoami',
      ]);
    });
  });

  describe('handleToolCall guards', () => {
    it('returns error when sessionId is null', () => {
      const result = handleToolCall('wrightward_bus_status', {}, collabDir, null, config);
      const data = JSON.parse(result.content[0].text);
      assert.ok(data.error);
      assert.match(data.error, /not bound/);
      assert.match(data.hint, /Try again in a few seconds/);
    });

    it('returns error when BUS_ENABLED is false', () => {
      const disabledConfig = { ...config, BUS_ENABLED: false };
      const result = handleToolCall('wrightward_bus_status', {}, collabDir, 'sess-1', disabledConfig);
      const data = JSON.parse(result.content[0].text);
      assert.ok(data.error);
      assert.match(data.error, /disabled/);
      assert.match(data.hint, /BUS_ENABLED=true/);
    });

    it('returns error for unknown tool name', () => {
      const result = handleToolCall('wrightward_unknown', {}, collabDir, 'sess-1', config, tmpDir);
      const data = JSON.parse(result.content[0].text);
      assert.ok(data.error);
      assert.match(data.error, /Unknown tool/);
    });
  });

  describe('wrightward_list_inbox', () => {
    it('returns pending urgent events', () => {
      withAgentsLock(collabDir, (token) => {
        append(token, collabDir, createEvent('sess-2', 'sess-1', 'handoff', 'take this'));
      });

      const result = handleToolCall('wrightward_list_inbox', {}, collabDir, 'sess-1', config, tmpDir);
      const data = JSON.parse(result.content[0].text);
      assert.equal(data.events.length, 1);
      assert.equal(data.events[0].type, 'handoff');
      assert.equal(data.events[0].body, 'take this');
    });

    it('respects limit parameter', () => {
      withAgentsLock(collabDir, (token) => {
        append(token, collabDir, createEvent('sess-2', 'sess-1', 'handoff', 'first'));
        append(token, collabDir, createEvent('sess-2', 'sess-1', 'handoff', 'second'));
        append(token, collabDir, createEvent('sess-2', 'sess-1', 'handoff', 'third'));
      });

      const result = handleToolCall('wrightward_list_inbox', { limit: 2 }, collabDir, 'sess-1', config, tmpDir);
      const data = JSON.parse(result.content[0].text);
      assert.equal(data.events.length, 2);
    });

    it('respects types filter', () => {
      withAgentsLock(collabDir, (token) => {
        append(token, collabDir, createEvent('sess-2', 'sess-1', 'handoff', 'handoff event'));
        append(token, collabDir, createEvent('sess-2', 'sess-1', 'file_freed', 'freed', { file: 'a.ts' }));
      });

      const result = handleToolCall('wrightward_list_inbox', { types: ['file_freed'] }, collabDir, 'sess-1', config, tmpDir);
      const data = JSON.parse(result.content[0].text);
      assert.equal(data.events.length, 1);
      assert.equal(data.events[0].type, 'file_freed');
    });

    it('mark_delivered=true advances bookmark', () => {
      withAgentsLock(collabDir, (token) => {
        append(token, collabDir, createEvent('sess-2', 'sess-1', 'handoff', 'msg'));
      });

      handleToolCall('wrightward_list_inbox', { mark_delivered: true }, collabDir, 'sess-1', config, tmpDir);
      const bm = readBookmark(collabDir, 'sess-1');
      assert.ok(bm.lastDeliveredOffset > 0);
    });

    it('mark_delivered=false does NOT advance lastDeliveredOffset', () => {
      withAgentsLock(collabDir, (token) => {
        append(token, collabDir, createEvent('sess-2', 'sess-1', 'handoff', 'msg'));
      });

      handleToolCall('wrightward_list_inbox', { mark_delivered: false }, collabDir, 'sess-1', config, tmpDir);
      const bm = readBookmark(collabDir, 'sess-1');
      assert.equal(bm.lastDeliveredOffset, 0);
      // But lastScannedOffset should advance
      assert.ok(bm.lastScannedOffset > 0);
    });

    it('strips _offset from returned events', () => {
      withAgentsLock(collabDir, (token) => {
        append(token, collabDir, createEvent('sess-2', 'sess-1', 'handoff', 'msg'));
      });

      const result = handleToolCall('wrightward_list_inbox', {}, collabDir, 'sess-1', config, tmpDir);
      const data = JSON.parse(result.content[0].text);
      assert.equal(data.events[0]._offset, undefined);
    });
  });

  describe('wrightward_ack', () => {
    function seedHandoff(taskRef) {
      let handoffId;
      withAgentsLock(collabDir, (token) => {
        const e = createEvent('sess-sender', 'sess-1', 'handoff', 'take over', {
          task_ref: taskRef || 'work'
        });
        append(token, collabDir, e);
        handoffId = e.id;
      });
      return handoffId;
    }

    it('routes the ack event at the original handoff sender', () => {
      const handoffId = seedHandoff('auth refactor');
      const result = handleToolCall('wrightward_ack', { id: handoffId, decision: 'rejected' }, collabDir, 'sess-1', config, tmpDir);
      const data = JSON.parse(result.content[0].text);
      assert.ok(data.ok);
      assert.ok(data.id);
      assert.match(data.hint, /Sender notified/);

      const events = fs.readFileSync(busPath(collabDir), 'utf8').trim().split('\n').map(l => JSON.parse(l));
      const ack = events.find(e => e.type === 'ack');
      assert.ok(ack);
      // Critical: acks must go to the original sender, not 'all'.
      assert.equal(ack.to, 'sess-sender');
      assert.equal(ack.meta.ack_of, handoffId);
      assert.equal(ack.meta.decision, 'rejected');
      // task_ref is copied into the ack body so the sender's thread reads cleanly.
      assert.match(ack.body, /auth refactor/);
    });

    it('defaults decision to accepted', () => {
      const handoffId = seedHandoff();
      handleToolCall('wrightward_ack', { id: handoffId }, collabDir, 'sess-1', config, tmpDir);
      const events = fs.readFileSync(busPath(collabDir), 'utf8').trim().split('\n').map(l => JSON.parse(l));
      const ack = events.find(e => e.type === 'ack');
      assert.equal(ack.meta.decision, 'accepted');
    });

    it('returns error when ackOf refers to an unknown event', () => {
      const result = handleToolCall('wrightward_ack', { id: 'unknown-event-id' }, collabDir, 'sess-1', config, tmpDir);
      const data = JSON.parse(result.content[0].text);
      assert.ok(data.error, 'expected error for unknown ackOf');
      assert.match(data.error, /unknown or expired/);
      assert.match(data.hint, /wrightward_list_inbox/);
      // Must NOT append an ack event when routing fails — don't leave an
      // un-routable ack sitting in the bus.
      const busText = fs.existsSync(busPath(collabDir)) ? fs.readFileSync(busPath(collabDir), 'utf8') : '';
      assert.ok(!busText.includes('"type":"ack"'), 'no ack event should be written on lookup failure');
    });
  });

  describe('wrightward_send_note', () => {
    it('appends note event to bus', () => {
      const result = handleToolCall('wrightward_send_note', { body: 'hello world' }, collabDir, 'sess-1', config, tmpDir);
      const data = JSON.parse(result.content[0].text);
      assert.ok(data.id);
      // kind=note default → quiet-log hint
      assert.match(data.hint, /Logged quietly/);

      const events = fs.readFileSync(busPath(collabDir), 'utf8').trim().split('\n').map(l => JSON.parse(l));
      const note = events.find(e => e.type === 'note');
      assert.ok(note);
      assert.equal(note.body, 'hello world');
    });

    it('hint switches to broadcast-wording for kind=finding', () => {
      const result = handleToolCall('wrightward_send_note', { body: 'bug', kind: 'finding' }, collabDir, 'sess-1', config, tmpDir);
      const data = JSON.parse(result.content[0].text);
      assert.match(data.hint, /Broadcast/);
    });

    it('hint switches to broadcast-wording for kind=decision', () => {
      const result = handleToolCall('wrightward_send_note', { body: 'pick X', kind: 'decision' }, collabDir, 'sess-1', config, tmpDir);
      const data = JSON.parse(result.content[0].text);
      assert.match(data.hint, /Broadcast/);
    });

    it('defaults to to "all" when omitted', () => {
      handleToolCall('wrightward_send_note', { body: 'broadcast' }, collabDir, 'sess-1', config, tmpDir);
      const events = fs.readFileSync(busPath(collabDir), 'utf8').trim().split('\n').map(l => JSON.parse(l));
      assert.equal(events[0].to, 'all');
    });

    it('respects explicit to parameter (target must be a live agent)', () => {
      registerAgent(collabDir, 'sess-2');
      handleToolCall('wrightward_send_note', { to: handleOf('sess-2'), body: 'direct' }, collabDir, 'sess-1', config, tmpDir);
      const events = fs.readFileSync(busPath(collabDir), 'utf8').trim().split('\n').map(l => JSON.parse(l));
      assert.equal(events[0].to, 'sess-2');
    });

    it('rejects to=<unknown-session> with structured audience error', () => {
      // Coverage for the ghost-UUID guard: unknown targets must fail at the
      // tool boundary, not silently persist to bus.jsonl for a bridge to
      // materialize a phantom thread around later.
      const result = handleToolCall('wrightward_send_note',
        { to: 'sess-ghost', body: 'to a ghost' }, collabDir, 'sess-1', config, tmpDir);
      const data = JSON.parse(result.content[0].text);
      assert.ok(data.error);
      assert.match(data.error, /not a live agent/);
    });

    it('defaults kind to "note" when omitted (backwards compat)', () => {
      handleToolCall('wrightward_send_note', { body: 'quiet log' }, collabDir, 'sess-1', config, tmpDir);
      const events = fs.readFileSync(busPath(collabDir), 'utf8').trim().split('\n').map(l => JSON.parse(l));
      assert.equal(events[0].type, 'note');
    });

    it('writes a finding event when kind="finding"', () => {
      handleToolCall('wrightward_send_note', { body: 'bug in X', kind: 'finding' }, collabDir, 'sess-1', config, tmpDir);
      const events = fs.readFileSync(busPath(collabDir), 'utf8').trim().split('\n').map(l => JSON.parse(l));
      assert.equal(events[0].type, 'finding');
      assert.equal(events[0].body, 'bug in X');
    });

    it('writes a decision event when kind="decision"', () => {
      handleToolCall('wrightward_send_note', { body: 'JWT not cookies', kind: 'decision' }, collabDir, 'sess-1', config, tmpDir);
      const events = fs.readFileSync(busPath(collabDir), 'utf8').trim().split('\n').map(l => JSON.parse(l));
      assert.equal(events[0].type, 'decision');
    });

    it('rejects unknown kind values', () => {
      const result = handleToolCall('wrightward_send_note', { body: 'x', kind: 'rumor' }, collabDir, 'sess-1', config, tmpDir);
      const data = JSON.parse(result.content[0].text);
      assert.ok(data.error);
      assert.match(data.error, /kind must be one of/);
    });
  });

  describe('wrightward_send_handoff', () => {
    it('returns error when args.to is missing', () => {
      const result = handleToolCall('wrightward_send_handoff', { task_ref: 'T1', next_action: 'do it' }, collabDir, 'sess-1', config, tmpDir);
      const data = JSON.parse(result.content[0].text);
      assert.ok(data.error);
      assert.match(data.error, /\bto\b/, 'error should mention "to": ' + data.error);
    });

    it('returns error when args.to is empty string', () => {
      const result = handleToolCall('wrightward_send_handoff', { to: '  ', task_ref: 'T1', next_action: 'do it' }, collabDir, 'sess-1', config, tmpDir);
      const data = JSON.parse(result.content[0].text);
      assert.ok(data.error);
    });

    it('releases files from context', () => {
      registerAgent(collabDir, 'sess-2');
      writeContext(collabDir, 'sess-1', {
        task: 'work',
        files: [
          { path: 'auth.ts', prefix: '+', source: 'planned', declaredAt: Date.now(), lastTouched: Date.now() },
          { path: 'db.ts', prefix: '+', source: 'planned', declaredAt: Date.now(), lastTouched: Date.now() }
        ],
        status: 'in-progress'
      });

      handleToolCall('wrightward_send_handoff', {
        to: handleOf('sess-2'), task_ref: 'T1', next_action: 'continue auth',
        files_unlocked: ['auth.ts']
      }, collabDir, 'sess-1', config, tmpDir);

      const { readContext } = require('../../lib/context');
      const ctx = readContext(collabDir, 'sess-1');
      assert.equal(ctx.files.length, 1);
      assert.equal(ctx.files[0].path, 'db.ts');
    });

    it('emits file_freed for interested agents but NOT the recipient', () => {
      registerAgent(collabDir, 'sess-2');
      registerAgent(collabDir, 'sess-3');
      writeContext(collabDir, 'sess-1', {
        task: 'work',
        files: [{ path: 'auth.ts', prefix: '+', source: 'planned', declaredAt: Date.now(), lastTouched: Date.now() }],
        status: 'in-progress'
      });

      // Both sess-2 and sess-3 are interested in auth.ts
      withAgentsLock(collabDir, (token) => {
        interestIndex.upsert(token, collabDir, 'auth.ts', {
          sessionId: 'sess-2', busEventId: 'e1', declaredAt: Date.now(), expiresAt: null
        });
        interestIndex.upsert(token, collabDir, 'auth.ts', {
          sessionId: 'sess-3', busEventId: 'e2', declaredAt: Date.now(), expiresAt: null
        });
      });

      handleToolCall('wrightward_send_handoff', {
        to: handleOf('sess-2'), task_ref: 'T1', next_action: 'take over',
        files_unlocked: ['auth.ts']
      }, collabDir, 'sess-1', config, tmpDir);

      const events = fs.readFileSync(busPath(collabDir), 'utf8').trim().split('\n').map(l => JSON.parse(l));
      // Should have file_freed for sess-3 but NOT sess-2
      const freedForC = events.find(e => e.type === 'file_freed' && e.to === 'sess-3');
      const freedForB = events.find(e => e.type === 'file_freed' && e.to === 'sess-2');
      const handoff = events.find(e => e.type === 'handoff');
      assert.ok(freedForC, 'Expected file_freed for sess-3');
      assert.ok(!freedForB, 'Should NOT have file_freed for recipient sess-2');
      assert.ok(handoff, 'Expected handoff event');
      assert.equal(handoff.to, 'sess-2');
    });

    it('appends handoff event with TTL', () => {
      registerAgent(collabDir, 'sess-2');
      const result = handleToolCall('wrightward_send_handoff', {
        to: handleOf('sess-2'), task_ref: 'T1', next_action: 'do it'
      }, collabDir, 'sess-1', config, tmpDir);
      const data = JSON.parse(result.content[0].text);
      assert.ok(data.id);
      assert.match(data.hint, /Recipient sees this on their next tool call/);
      assert.match(data.hint, /ack will arrive in your inbox/);

      const events = fs.readFileSync(busPath(collabDir), 'utf8').trim().split('\n').map(l => JSON.parse(l));
      const handoff = events.find(e => e.type === 'handoff');
      assert.ok(handoff);
      assert.ok(handoff.expires_at > Date.now());
      assert.equal(handoff.meta.task_ref, 'T1');
    });

    it('rejects broadcast audience (to="all" / "user") — handoff needs a specific recipient', () => {
      // A handoff hands WORK to one peer — it's not a broadcast concept.
      // resolveAudience happily returns a broadcast target for 'all'/'user';
      // handleSendHandoff must then refuse rather than writing a degenerate
      // handoff with to='all' (which would sit in every agent's inbox
      // claiming they owe an ack).
      for (const target of ['all', 'user']) {
        const result = handleToolCall('wrightward_send_handoff', {
          to: target, task_ref: 'T1', next_action: 'do it'
        }, collabDir, 'sess-1', config, tmpDir);
        const data = JSON.parse(result.content[0].text);
        assert.ok(data.error, target + ' must be rejected, got: ' + JSON.stringify(data));
        assert.match(data.error, /specific agent/i,
          'error must explain handoff needs a specific recipient');
      }
    });

    it('resolves to=<handle> (not just sessionId) for handoff targeting', () => {
      // Handle-form addressing parity with send_message: passing a peer's
      // handle must resolve to their UUID and land in event.to.
      registerAgent(collabDir, 'sess-peer');
      const { readAgents } = require('../../lib/agents');
      const { handleFor } = require('../../lib/handles');
      const peerHandle = handleFor('sess-peer', readAgents(collabDir)['sess-peer']);

      handleToolCall('wrightward_send_handoff', {
        to: peerHandle, task_ref: 'T1', next_action: 'by handle'
      }, collabDir, 'sess-1', config, tmpDir);
      const events = fs.readFileSync(busPath(collabDir), 'utf8').trim().split('\n').map(l => JSON.parse(l));
      const handoff = events.find(e => e.type === 'handoff');
      assert.ok(handoff);
      assert.equal(handoff.to, 'sess-peer',
        'event.to must be the full sessionId, handle resolution happens at the tool boundary');
    });
  });

  describe('wrightward_watch_file', () => {
    it('appends interest event and updates index', () => {
      const result = handleToolCall('wrightward_watch_file', { file: 'db.ts' }, collabDir, 'sess-1', config, tmpDir);
      const data = JSON.parse(result.content[0].text);
      assert.ok(data.id);
      assert.match(data.hint, /notified when the file frees up/);

      const events = fs.readFileSync(busPath(collabDir), 'utf8').trim().split('\n').map(l => JSON.parse(l));
      const interest = events.find(e => e.type === 'interest');
      assert.ok(interest);
      assert.equal(interest.meta.file, 'db.ts');

      const idx = interestIndex.read(collabDir);
      assert.ok(idx['db.ts']);
      assert.equal(idx['db.ts'][0].sessionId, 'sess-1');
    });
  });

  describe('wrightward_send_message', () => {
    function readEvents() {
      return fs.readFileSync(busPath(collabDir), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    }

    it('appends agent_message to bus with audience="user"', () => {
      const result = handleToolCall('wrightward_send_message',
        { body: 'hi user', audience: 'user' }, collabDir, 'sess-1', config, tmpDir);
      const data = JSON.parse(result.content[0].text);
      assert.ok(data.id);
      assert.match(data.hint, /Posted to Discord/);

      const evt = readEvents().find(e => e.type === 'agent_message');
      assert.ok(evt);
      assert.equal(evt.from, 'sess-1');
      assert.equal(evt.to, 'user');
      assert.equal(evt.body, 'hi user');
    });

    it('appends agent_message with audience="all"', () => {
      const result = handleToolCall('wrightward_send_message',
        { body: 'broadcast', audience: 'all' }, collabDir, 'sess-1', config, tmpDir);
      const data = JSON.parse(result.content[0].text);
      assert.match(data.hint, /Broadcast to Discord \+ every active agent/);
      const evt = readEvents().find(e => e.type === 'agent_message');
      assert.equal(evt.to, 'all');
    });

    it('rejects audience=<unknown-session> with structured audience error', () => {
      // The ghost-UUID fix's test at the send_message boundary: unknown
      // targets get a structured error listing live handles, not a silent
      // write to bus.jsonl.
      const result = handleToolCall('wrightward_send_message',
        { body: 'phantom', audience: 'ghost-session-id' }, collabDir, 'sess-1', config, tmpDir);
      const data = JSON.parse(result.content[0].text);
      assert.ok(data.error);
      assert.match(data.error, /not a live agent/);
      assert.match(data.hint, /Live agents:|No live agents/);
      assert.ok(Array.isArray(data.live_handles));
      // Failed send must not persist an event — either bus.jsonl doesn't
      // exist at all, or if it exists from a prior test append, it holds
      // no agent_message events.
      const bus = busPath(collabDir);
      if (fs.existsSync(bus)) {
        assert.equal(readEvents().filter(e => e.type === 'agent_message').length, 0,
          'failed send must not persist an event');
      }
    });

    it('resolves audience by handle (bob-42) when the peer is registered', () => {
      // End-to-end test of the handle-addressing path: agent sends to
      // `<handle>`, resolveAudience maps it to the peer UUID before
      // createEvent; matchesSession routes by UUID as before.
      const targetSid = 'sess-peer-xyz';
      registerAgent(collabDir, targetSid);
      const { handleFor } = require('../../lib/handles');
      const roster = require('../../lib/agents').readAgents(collabDir);
      const peerHandle = handleFor(targetSid, roster[targetSid]);

      handleToolCall('wrightward_send_message',
        { body: 'by handle', audience: peerHandle }, collabDir, 'sess-1', config, tmpDir);
      const evt = readEvents().find(e => e.type === 'agent_message');
      assert.ok(evt);
      assert.equal(evt.to, targetSid, 'event.to must be the UUID, not the handle');
    });

    it('audience="all" lands in another agent\'s urgent inbox', () => {
      // The whole point of audience:"all" is that other agents see it via
      // Path 1 (inbox listing). agent_message must therefore be URGENT, and
      // matchesSession must accept "all" — pin both with one round-trip test.
      registerAgent(collabDir, 'sess-2');
      handleToolCall('wrightward_send_message',
        { body: 'team status', audience: 'all' }, collabDir, 'sess-1', config, tmpDir);
      const result = handleToolCall('wrightward_list_inbox', {}, collabDir, 'sess-2', config, tmpDir);
      const data = JSON.parse(result.content[0].text);
      const found = data.events.find(e => e.type === 'agent_message');
      assert.ok(found, 'sess-2 should see agent_message broadcast in inbox');
      assert.equal(found.body, 'team status');
    });

    it('audience="user" does NOT appear in any other agent\'s inbox', () => {
      // Reserved "user" audience must be invisible to bus consumers — only
      // the Discord bridge mirrors it, and that's verified in mirror-policy
      // tests, not here.
      registerAgent(collabDir, 'sess-2');
      handleToolCall('wrightward_send_message',
        { body: 'private reply', audience: 'user' }, collabDir, 'sess-1', config, tmpDir);
      const result = handleToolCall('wrightward_list_inbox', {}, collabDir, 'sess-2', config, tmpDir);
      const data = JSON.parse(result.content[0].text);
      assert.equal(data.events.filter(e => e.type === 'agent_message').length, 0);
    });

    it('audience=<handle> lands in that session\'s inbox only', () => {
      registerAgent(collabDir, 'sess-2');
      registerAgent(collabDir, 'sess-3');
      handleToolCall('wrightward_send_message',
        { body: 'just for you', audience: handleOf('sess-2') }, collabDir, 'sess-1', config, tmpDir);

      const r2 = handleToolCall('wrightward_list_inbox', {}, collabDir, 'sess-2', config, tmpDir);
      assert.equal(JSON.parse(r2.content[0].text).events.filter(e => e.type === 'agent_message').length, 1);

      const r3 = handleToolCall('wrightward_list_inbox', {}, collabDir, 'sess-3', config, tmpDir);
      assert.equal(JSON.parse(r3.content[0].text).events.filter(e => e.type === 'agent_message').length, 0);
    });

    it('sender does not see their own agent_message in their inbox', () => {
      // matchesSession excludes events whose `from` equals the asker — pin
      // that here so a future audience-routing rewrite doesn't accidentally
      // create an inbox echo loop.
      handleToolCall('wrightward_send_message',
        { body: 'self', audience: 'all' }, collabDir, 'sess-1', config, tmpDir);
      const result = handleToolCall('wrightward_list_inbox', {}, collabDir, 'sess-1', config, tmpDir);
      const data = JSON.parse(result.content[0].text);
      assert.equal(data.events.filter(e => e.type === 'agent_message').length, 0);
    });
  });

  describe('wrightward_whoami', () => {
    it('returns the bound session\'s handle and registered_at', () => {
      const result = handleToolCall('wrightward_whoami', {}, collabDir, 'sess-1', config, tmpDir);
      const data = JSON.parse(result.content[0].text);
      assert.equal(data.sessionId, 'sess-1');
      // Handle shape: `<name>-<number>` per HANDLE_PATTERN.
      assert.match(data.handle, /^[a-z]+-\d{1,4}$/);
      assert.equal(typeof data.registered_at, 'number');
      assert.match(data.hint, /@agent-/);
    });

    it('handle is deterministic: whoami twice on the same session returns the same handle', () => {
      // This is the property that prevents agent identity drift across
      // context compaction / resume — the agent can re-discover its handle
      // without relying on memory. Regression would silently break peer
      // addressing coherence.
      const r1 = JSON.parse(handleToolCall('wrightward_whoami', {}, collabDir, 'sess-1', config, tmpDir).content[0].text);
      const r2 = JSON.parse(handleToolCall('wrightward_whoami', {}, collabDir, 'sess-1', config, tmpDir).content[0].text);
      assert.equal(r1.handle, r2.handle);
    });

    it('still returns a handle for an unregistered session (derived from UUID)', () => {
      // Defensive path: even if the roster somehow lost the row, whoami
      // must return a deterministic handle derived from the UUID so the
      // agent never sees a broken self-identity response.
      const result = handleToolCall('wrightward_whoami', {}, collabDir, 'never-registered', config, tmpDir);
      const data = JSON.parse(result.content[0].text);
      assert.equal(data.sessionId, 'never-registered');
      assert.match(data.handle, /^[a-z]+-\d{1,4}$/);
      assert.equal(data.registered_at, null);
    });
  });

  describe('wrightward_bus_status', () => {
    it('returns status with bound session', () => {
      const result = handleToolCall('wrightward_bus_status', {}, collabDir, 'sess-1', config, tmpDir);
      const data = JSON.parse(result.content[0].text);
      assert.equal(data.bound_session_id, 'sess-1');
      assert.equal(typeof data.pending_urgent, 'number');
      assert.equal(typeof data.retention_entries, 'number');
    });

    it('reports pending urgent events', () => {
      withAgentsLock(collabDir, (token) => {
        append(token, collabDir, createEvent('sess-2', 'sess-1', 'handoff', 'msg'));
      });

      const result = handleToolCall('wrightward_bus_status', {}, collabDir, 'sess-1', config, tmpDir);
      const data = JSON.parse(result.content[0].text);
      assert.equal(data.pending_urgent, 1);
      assert.equal(data.retention_entries, 1);
    });

    describe('bridge sub-object', () => {
      it('exposes bridge status with running=false and null circuit_breaker when no bridge has run', () => {
        const result = handleToolCall('wrightward_bus_status', {}, collabDir, 'sess-1', config, tmpDir);
        const data = JSON.parse(result.content[0].text);
        assert.ok(data.bridge, 'bridge sub-object must be present');
        assert.equal(data.bridge.running, false);
        assert.equal(data.bridge.owned_by_this_session, false);
        assert.equal(data.bridge.owner_session_id, null);
        assert.equal(data.bridge.owner_pid, null);
        assert.equal(data.bridge.child_pid, null);
        assert.equal(data.bridge.last_error, null);
        assert.equal(data.bridge.circuit_breaker, null);
      });

      it('reports owner_pid/owner_session_id/child_pid when a lockfile exists', () => {
        const bridgeSubdir = path.join(collabDir, 'bridge');
        fs.mkdirSync(bridgeSubdir, { recursive: true });
        fs.writeFileSync(path.join(bridgeSubdir, 'bridge.lock'), JSON.stringify({
          owner_pid: process.pid,
          owner_session_id: 'sess-owner',
          started_at: Date.now(),
          bridge_child_pid: null
        }));
        const result = handleToolCall('wrightward_bus_status', {}, collabDir, 'sess-1', config, tmpDir);
        const data = JSON.parse(result.content[0].text);
        assert.equal(data.bridge.owner_session_id, 'sess-owner');
        assert.equal(data.bridge.owner_pid, process.pid);
        assert.equal(data.bridge.owned_by_this_session, true);
      });

      it('surfaces the circuit breaker when trip state is present', () => {
        const bridgeSubdir = path.join(collabDir, 'bridge');
        fs.mkdirSync(bridgeSubdir, { recursive: true });
        fs.writeFileSync(path.join(bridgeSubdir, 'circuit-breaker.json'), JSON.stringify({
          disabled_until_ts: Date.now() + 60_000,
          last_error: 'HTTP 401',
          consecutive_failures: 2
        }));
        const result = handleToolCall('wrightward_bus_status', {}, collabDir, 'sess-1', config, tmpDir);
        const data = JSON.parse(result.content[0].text);
        assert.ok(data.bridge.circuit_breaker, 'circuit_breaker must be reported');
        assert.equal(data.bridge.circuit_breaker.consecutive_failures, 2);
        assert.equal(data.bridge.circuit_breaker.last_error, 'HTTP 401');
        assert.ok(data.bridge.circuit_breaker.disabled_until_ts > Date.now());
        assert.equal(data.bridge.last_error, 'HTTP 401');
      });
    });
  });

  describe('input validation', () => {
    function callError(tool, args) {
      const result = handleToolCall(tool, args, collabDir, 'sess-1', config, tmpDir);
      const data = JSON.parse(result.content[0].text);
      return data.error;
    }

    it('list_inbox rejects negative limit', () => {
      assert.ok(callError('wrightward_list_inbox', { limit: -1 }));
    });
    it('list_inbox rejects non-numeric limit', () => {
      assert.ok(callError('wrightward_list_inbox', { limit: 'lots' }));
    });
    it('list_inbox rejects unknown type filter', () => {
      const err = callError('wrightward_list_inbox', { types: ['gossip'] });
      assert.ok(err, 'expected an error');
      assert.match(err, /unknown urgent types/);
    });
    it('list_inbox rejects non-array types', () => {
      assert.ok(callError('wrightward_list_inbox', { types: 'handoff' }));
    });

    it('ack rejects missing id', () => {
      assert.ok(callError('wrightward_ack', {}));
    });
    it('ack rejects unknown decision', () => {
      const err = callError('wrightward_ack', { id: 'evt-1', decision: 'maybe' });
      assert.ok(err, 'expected an error');
      assert.match(err, /decision/);
    });

    it('send_note rejects missing body', () => {
      assert.ok(callError('wrightward_send_note', {}));
    });

    it('send_handoff rejects missing task_ref', () => {
      const err = callError('wrightward_send_handoff', { to: 'sess-2', next_action: 'go' });
      assert.ok(err, 'expected an error');
      assert.match(err, /task_ref/);
    });

    it('watch_file rejects missing file', () => {
      assert.ok(callError('wrightward_watch_file', {}));
    });

    it('send_message rejects missing body', () => {
      const err = callError('wrightward_send_message', { audience: 'user' });
      assert.ok(err);
      assert.match(err, /body/);
    });

    it('send_message rejects empty body', () => {
      const err = callError('wrightward_send_message', { body: '', audience: 'user' });
      assert.ok(err);
      assert.match(err, /body/);
    });

    it('send_message rejects missing audience', () => {
      const err = callError('wrightward_send_message', { body: 'hi' });
      assert.ok(err);
      assert.match(err, /audience/);
    });

    it('send_message rejects empty audience', () => {
      const err = callError('wrightward_send_message', { body: 'hi', audience: '' });
      assert.ok(err);
      assert.match(err, /audience/);
    });
  });

  describe('handoff TTL semantics', () => {
    it('honors BUS_HANDOFF_TTL_MS=0 as no expiry', () => {
      // When operators configure BUS_HANDOFF_TTL_MIN: 0 they want handoffs to
      // never auto-expire — same convention as writeInterest. The previous
      // `|| default` collapsed 0 to the 30-minute default.
      const cfg0 = { ...config, BUS_HANDOFF_TTL_MS: 0 };
      registerAgent(collabDir, 'sess-2');
      handleToolCall('wrightward_send_handoff', {
        to: handleOf('sess-2'), task_ref: 'T1', next_action: 'do it'
      }, collabDir, 'sess-1', cfg0, tmpDir);

      const events = fs.readFileSync(busPath(collabDir), 'utf8').trim().split('\n').map(l => JSON.parse(l));
      const handoff = events.find(e => e.type === 'handoff');
      assert.ok(handoff);
      assert.equal(handoff.expires_at, null, 'TTL=0 must produce expires_at=null, not a future timestamp');
    });
  });
});
