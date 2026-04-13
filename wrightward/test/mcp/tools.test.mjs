import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { ensureCollabDir } = require('../../lib/collab-dir');
const { registerAgent, withAgentsLock } = require('../../lib/agents');
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
    it('returns 6 tools', () => {
      const tools = getToolDefinitions();
      assert.equal(tools.length, 6);
      const names = tools.map(t => t.name);
      assert.ok(names.includes('wrightward_list_inbox'));
      assert.ok(names.includes('wrightward_ack'));
      assert.ok(names.includes('wrightward_send_note'));
      assert.ok(names.includes('wrightward_send_handoff'));
      assert.ok(names.includes('wrightward_watch_file'));
      assert.ok(names.includes('wrightward_bus_status'));
    });
  });

  describe('handleToolCall guards', () => {
    it('returns error when sessionId is null', () => {
      const result = handleToolCall('wrightward_bus_status', {}, collabDir, null, config);
      const data = JSON.parse(result.content[0].text);
      assert.ok(data.error);
      assert.ok(data.error.includes('not bound'));
    });

    it('returns error when BUS_ENABLED is false', () => {
      const disabledConfig = { ...config, BUS_ENABLED: false };
      const result = handleToolCall('wrightward_bus_status', {}, collabDir, 'sess-1', disabledConfig);
      const data = JSON.parse(result.content[0].text);
      assert.ok(data.error);
      assert.ok(data.error.includes('disabled'));
    });

    it('returns error for unknown tool name', () => {
      const result = handleToolCall('wrightward_unknown', {}, collabDir, 'sess-1', config, tmpDir);
      const data = JSON.parse(result.content[0].text);
      assert.ok(data.error);
      assert.ok(data.error.includes('Unknown tool'));
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
    it('appends ack event with correct meta', () => {
      const result = handleToolCall('wrightward_ack', { id: 'event-123', decision: 'rejected' }, collabDir, 'sess-1', config, tmpDir);
      const data = JSON.parse(result.content[0].text);
      assert.ok(data.ok);
      assert.ok(data.id);

      const events = fs.readFileSync(busPath(collabDir), 'utf8').trim().split('\n').map(l => JSON.parse(l));
      const ack = events.find(e => e.type === 'ack');
      assert.ok(ack);
      assert.equal(ack.meta.ack_of, 'event-123');
      assert.equal(ack.meta.decision, 'rejected');
    });

    it('defaults decision to accepted', () => {
      handleToolCall('wrightward_ack', { id: 'event-456' }, collabDir, 'sess-1', config, tmpDir);
      const events = fs.readFileSync(busPath(collabDir), 'utf8').trim().split('\n').map(l => JSON.parse(l));
      const ack = events.find(e => e.type === 'ack');
      assert.equal(ack.meta.decision, 'accepted');
    });
  });

  describe('wrightward_send_note', () => {
    it('appends note event to bus', () => {
      const result = handleToolCall('wrightward_send_note', { body: 'hello world' }, collabDir, 'sess-1', config, tmpDir);
      const data = JSON.parse(result.content[0].text);
      assert.ok(data.id);

      const events = fs.readFileSync(busPath(collabDir), 'utf8').trim().split('\n').map(l => JSON.parse(l));
      const note = events.find(e => e.type === 'note');
      assert.ok(note);
      assert.equal(note.body, 'hello world');
    });

    it('defaults to to "all" when omitted', () => {
      handleToolCall('wrightward_send_note', { body: 'broadcast' }, collabDir, 'sess-1', config, tmpDir);
      const events = fs.readFileSync(busPath(collabDir), 'utf8').trim().split('\n').map(l => JSON.parse(l));
      assert.equal(events[0].to, 'all');
    });

    it('respects explicit to parameter', () => {
      handleToolCall('wrightward_send_note', { to: 'sess-2', body: 'direct' }, collabDir, 'sess-1', config, tmpDir);
      const events = fs.readFileSync(busPath(collabDir), 'utf8').trim().split('\n').map(l => JSON.parse(l));
      assert.equal(events[0].to, 'sess-2');
    });
  });

  describe('wrightward_send_handoff', () => {
    it('returns error when args.to is missing', () => {
      const result = handleToolCall('wrightward_send_handoff', { task_ref: 'T1', next_action: 'do it' }, collabDir, 'sess-1', config, tmpDir);
      const data = JSON.parse(result.content[0].text);
      assert.ok(data.error);
      assert.ok(data.error.includes('to'), 'error should mention "to": ' + data.error);
    });

    it('returns error when args.to is empty string', () => {
      const result = handleToolCall('wrightward_send_handoff', { to: '  ', task_ref: 'T1', next_action: 'do it' }, collabDir, 'sess-1', config, tmpDir);
      const data = JSON.parse(result.content[0].text);
      assert.ok(data.error);
    });

    it('releases files from context', () => {
      writeContext(collabDir, 'sess-1', {
        task: 'work',
        files: [
          { path: 'auth.ts', prefix: '+', source: 'planned', declaredAt: Date.now(), lastTouched: Date.now() },
          { path: 'db.ts', prefix: '+', source: 'planned', declaredAt: Date.now(), lastTouched: Date.now() }
        ],
        status: 'in-progress'
      });

      handleToolCall('wrightward_send_handoff', {
        to: 'sess-2', task_ref: 'T1', next_action: 'continue auth',
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
        to: 'sess-2', task_ref: 'T1', next_action: 'take over',
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
      const result = handleToolCall('wrightward_send_handoff', {
        to: 'sess-2', task_ref: 'T1', next_action: 'do it'
      }, collabDir, 'sess-1', config, tmpDir);
      const data = JSON.parse(result.content[0].text);
      assert.ok(data.id);

      const events = fs.readFileSync(busPath(collabDir), 'utf8').trim().split('\n').map(l => JSON.parse(l));
      const handoff = events.find(e => e.type === 'handoff');
      assert.ok(handoff);
      assert.ok(handoff.expires_at > Date.now());
      assert.equal(handoff.meta.task_ref, 'T1');
    });
  });

  describe('wrightward_watch_file', () => {
    it('appends interest event and updates index', () => {
      const result = handleToolCall('wrightward_watch_file', { file: 'db.ts' }, collabDir, 'sess-1', config, tmpDir);
      const data = JSON.parse(result.content[0].text);
      assert.ok(data.id);

      const events = fs.readFileSync(busPath(collabDir), 'utf8').trim().split('\n').map(l => JSON.parse(l));
      const interest = events.find(e => e.type === 'interest');
      assert.ok(interest);
      assert.equal(interest.meta.file, 'db.ts');

      const idx = interestIndex.read(collabDir);
      assert.ok(idx['db.ts']);
      assert.equal(idx['db.ts'][0].sessionId, 'sess-1');
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
      assert.ok(err && err.includes('unknown urgent types'));
    });
    it('list_inbox rejects non-array types', () => {
      assert.ok(callError('wrightward_list_inbox', { types: 'handoff' }));
    });

    it('ack rejects missing id', () => {
      assert.ok(callError('wrightward_ack', {}));
    });
    it('ack rejects unknown decision', () => {
      const err = callError('wrightward_ack', { id: 'evt-1', decision: 'maybe' });
      assert.ok(err && err.includes('decision'));
    });

    it('send_note rejects missing body', () => {
      assert.ok(callError('wrightward_send_note', {}));
    });

    it('send_handoff rejects missing task_ref', () => {
      const err = callError('wrightward_send_handoff', { to: 'sess-2', next_action: 'go' });
      assert.ok(err && err.includes('task_ref'));
    });

    it('watch_file rejects missing file', () => {
      assert.ok(callError('wrightward_watch_file', {}));
    });
  });

  describe('handoff TTL semantics', () => {
    it('honors BUS_HANDOFF_TTL_MS=0 as no expiry', () => {
      // When operators configure BUS_HANDOFF_TTL_MIN: 0 they want handoffs to
      // never auto-expire — same convention as writeInterest. The previous
      // `|| default` collapsed 0 to the 30-minute default.
      const cfg0 = { ...config, BUS_HANDOFF_TTL_MS: 0 };
      handleToolCall('wrightward_send_handoff', {
        to: 'sess-2', task_ref: 'T1', next_action: 'do it'
      }, collabDir, 'sess-1', cfg0, tmpDir);

      const events = fs.readFileSync(busPath(collabDir), 'utf8').trim().split('\n').map(l => JSON.parse(l));
      const handoff = events.find(e => e.type === 'handoff');
      assert.ok(handoff);
      assert.equal(handoff.expires_at, null, 'TTL=0 must produce expires_at=null, not a future timestamp');
    });
  });
});
