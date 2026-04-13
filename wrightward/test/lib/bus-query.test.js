'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { ensureCollabDir } = require('../../lib/collab-dir');
const { withAgentsLock, registerAgent, registerAgentInLock } = require('../../lib/agents');
const { createEvent } = require('../../lib/bus-schema');
const { append, appendBatch, busPath } = require('../../lib/bus-log');
const { listInbox, findInterested, writeInterest, writeAck, buildFileFreedEvents } = require('../../lib/bus-query');
const { writeContext } = require('../../lib/context');
const interestIndex = require('../../lib/interest-index');

describe('bus-query', () => {
  let tmpDir;
  let collabDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bus-query-test-'));
    collabDir = ensureCollabDir(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('listInbox', () => {
    it('returns only urgent events for this session', () => {
      withAgentsLock(collabDir, (token) => {
        append(token, collabDir, createEvent('sess-2', 'sess-1', 'handoff', 'take over'));
        append(token, collabDir, createEvent('sess-2', 'sess-1', 'note', 'hello'));
        append(token, collabDir, createEvent('sess-2', 'sess-3', 'handoff', 'not for you'));
        append(token, collabDir, createEvent('sess-2', 'all', 'blocker', 'stuck'));

        const result = listInbox(token, collabDir, 'sess-1', 0);
        assert.equal(result.events.length, 2);
        assert.equal(result.events[0].type, 'handoff');
        assert.equal(result.events[1].type, 'blocker');
      });
    });

    it('excludes expired events', () => {
      withAgentsLock(collabDir, (token) => {
        const expired = createEvent('sess-2', 'sess-1', 'handoff', 'old', {}, 'info', Date.now() - 1000);
        append(token, collabDir, expired);
        const fresh = createEvent('sess-2', 'sess-1', 'handoff', 'new');
        append(token, collabDir, fresh);

        const result = listInbox(token, collabDir, 'sess-1', 0);
        assert.equal(result.events.length, 1);
        assert.equal(result.events[0].body, 'new');
      });
    });

    it('excludes events from self', () => {
      withAgentsLock(collabDir, (token) => {
        append(token, collabDir, createEvent('sess-1', 'all', 'handoff', 'my own'));
        const result = listInbox(token, collabDir, 'sess-1', 0);
        assert.equal(result.events.length, 0);
      });
    });

    it('deduplicates file_freed within 5s', () => {
      withAgentsLock(collabDir, (token) => {
        const e1 = createEvent('sess-2', 'sess-1', 'file_freed', 'freed', { file: 'auth.ts' });
        e1.ts = Date.now();
        const e2 = createEvent('sess-3', 'sess-1', 'file_freed', 'freed again', { file: 'auth.ts' });
        e2.ts = e1.ts + 2000;
        append(token, collabDir, e1);
        append(token, collabDir, e2);

        const result = listInbox(token, collabDir, 'sess-1', 0);
        assert.equal(result.events.length, 1);
        assert.equal(result.events[0].body, 'freed');
      });
    });

    it('does NOT deduplicate file_freed for different files', () => {
      withAgentsLock(collabDir, (token) => {
        append(token, collabDir, createEvent('sess-2', 'sess-1', 'file_freed', 'freed', { file: 'a.ts' }));
        append(token, collabDir, createEvent('sess-2', 'sess-1', 'file_freed', 'freed', { file: 'b.ts' }));

        const result = listInbox(token, collabDir, 'sess-1', 0);
        assert.equal(result.events.length, 2);
      });
    });

    it('does NOT deduplicate file_freed outside 5s window', () => {
      withAgentsLock(collabDir, (token) => {
        const e1 = createEvent('sess-2', 'sess-1', 'file_freed', 'first', { file: 'auth.ts' });
        e1.ts = Date.now() - 10000;
        const e2 = createEvent('sess-2', 'sess-1', 'file_freed', 'second', { file: 'auth.ts' });
        e2.ts = Date.now();
        append(token, collabDir, e1);
        append(token, collabDir, e2);

        const result = listInbox(token, collabDir, 'sess-1', 0);
        assert.equal(result.events.length, 2);
      });
    });

    it('advances endOffset even when no urgent events', () => {
      withAgentsLock(collabDir, (token) => {
        append(token, collabDir, createEvent('sess-2', 'sess-1', 'note', 'not urgent'));
        const result = listInbox(token, collabDir, 'sess-1', 0);
        assert.equal(result.events.length, 0);
        assert.ok(result.endOffset > 0);
      });
    });
  });

  describe('findInterested', () => {
    it('returns entries for live sessions with valid TTL', () => {
      registerAgent(collabDir, 'sess-1');
      withAgentsLock(collabDir, (token) => {
        interestIndex.upsert(token, collabDir, 'auth.ts', {
          sessionId: 'sess-1', busEventId: 'e1', declaredAt: Date.now(), expiresAt: Date.now() + 60000
        });

        const result = findInterested(token, collabDir, 'auth.ts');
        assert.equal(result.length, 1);
        assert.equal(result[0].sessionId, 'sess-1');
      });
    });

    it('excludes dead sessions', () => {
      withAgentsLock(collabDir, (token) => {
        interestIndex.upsert(token, collabDir, 'auth.ts', {
          sessionId: 'sess-1', busEventId: 'e1', declaredAt: Date.now(), expiresAt: Date.now() + 60000
        });
        const result = findInterested(token, collabDir, 'auth.ts');
        assert.equal(result.length, 0);
      });
    });

    it('excludes expired TTL', () => {
      registerAgent(collabDir, 'sess-1');
      withAgentsLock(collabDir, (token) => {
        interestIndex.upsert(token, collabDir, 'auth.ts', {
          sessionId: 'sess-1', busEventId: 'e1', declaredAt: Date.now() - 120000, expiresAt: Date.now() - 1000
        });
        const result = findInterested(token, collabDir, 'auth.ts');
        assert.equal(result.length, 0);
      });
    });

    it('includes entries with null expiresAt (no TTL)', () => {
      registerAgent(collabDir, 'sess-1');
      withAgentsLock(collabDir, (token) => {
        interestIndex.upsert(token, collabDir, 'auth.ts', {
          sessionId: 'sess-1', busEventId: 'e1', declaredAt: Date.now(), expiresAt: null
        });
        const result = findInterested(token, collabDir, 'auth.ts');
        assert.equal(result.length, 1);
      });
    });

    it('self-heals on corrupted index', () => {
      registerAgent(collabDir, 'sess-1');
      withAgentsLock(collabDir, (token) => {
        const e = createEvent('sess-1', 'all', 'interest', 'watching', { file: 'x.js' });
        append(token, collabDir, e);
      });
      fs.writeFileSync(interestIndex.indexPath(collabDir), 'CORRUPT', 'utf8');

      withAgentsLock(collabDir, (token) => {
        const result = findInterested(token, collabDir, 'x.js');
        assert.ok(Array.isArray(result));
      });
    });
  });

  describe('writeInterest', () => {
    it('records interest in bus log and index when file is claimed', () => {
      registerAgent(collabDir, 'sess-2');
      writeContext(collabDir, 'sess-2', {
        task: 'work',
        files: [{ path: 'auth.ts', prefix: '~', source: 'planned', declaredAt: Date.now(), lastTouched: Date.now() }],
        status: 'in-progress'
      });

      withAgentsLock(collabDir, (token) => {
        const id = writeInterest(token, collabDir, 'sess-1', 'auth.ts', 60000);
        assert.ok(typeof id === 'string' && id.length > 0);
      });

      const lines = fs.readFileSync(busPath(collabDir), 'utf8').trim().split('\n');
      assert.equal(lines.length, 1);
      const event = JSON.parse(lines[0]);
      assert.equal(event.type, 'interest');
      assert.equal(event.meta.file, 'auth.ts');

      const idx = interestIndex.read(collabDir);
      assert.equal(idx['auth.ts'].length, 1);
      assert.equal(idx['auth.ts'][0].sessionId, 'sess-1');
    });

    it('emits immediate file_freed when file is not claimed by any active session (TOCTOU)', () => {
      registerAgent(collabDir, 'sess-2');
      writeContext(collabDir, 'sess-2', {
        task: 'work',
        files: [{ path: 'other.ts', prefix: '~', source: 'planned', declaredAt: Date.now(), lastTouched: Date.now() }],
        status: 'in-progress'
      });

      withAgentsLock(collabDir, (token) => {
        writeInterest(token, collabDir, 'sess-1', 'auth.ts', 60000);
      });

      const lines = fs.readFileSync(busPath(collabDir), 'utf8').trim().split('\n');
      assert.equal(lines.length, 2);
      const freed = JSON.parse(lines[1]);
      assert.equal(freed.type, 'file_freed');
      assert.equal(freed.meta.file, 'auth.ts');
      assert.equal(freed.to, 'sess-1');
    });

    it('does NOT emit file_freed when file is still claimed (fresh read confirms)', () => {
      registerAgent(collabDir, 'sess-2');
      writeContext(collabDir, 'sess-2', {
        task: 'work',
        files: [{ path: 'auth.ts', prefix: '~', source: 'planned', declaredAt: Date.now(), lastTouched: Date.now() }],
        status: 'in-progress'
      });

      withAgentsLock(collabDir, (token) => {
        writeInterest(token, collabDir, 'sess-1', 'auth.ts', 60000);
      });

      const lines = fs.readFileSync(busPath(collabDir), 'utf8').trim().split('\n');
      assert.equal(lines.length, 1);
    });
  });

  describe('writeAck', () => {
    it('appends ack event with correct meta', () => {
      withAgentsLock(collabDir, (token) => {
        const id = writeAck(token, collabDir, 'sess-1', 'event-123', 'accepted');
        assert.ok(typeof id === 'string');
      });

      const content = fs.readFileSync(busPath(collabDir), 'utf8').trim();
      const event = JSON.parse(content);
      assert.equal(event.type, 'ack');
      assert.equal(event.meta.ack_of, 'event-123');
      assert.equal(event.meta.decision, 'accepted');
    });
  });

  describe('buildFileFreedEvents', () => {
    function seedInterest(token, sessionId, file) {
      registerAgentInLock(collabDir, sessionId);
      interestIndex.upsert(token, collabDir, file, {
        sessionId, busEventId: 'evt-' + sessionId + '-' + file, declaredAt: Date.now(), expiresAt: null
      });
    }

    it('returns [] for empty files array', () => {
      withAgentsLock(collabDir, (token) => {
        const events = buildFileFreedEvents(token, collabDir, {
          releasedBy: 'sess-1', files: [], reason: 'scavenge'
        });
        assert.deepEqual(events, []);
      });
    });

    it('skips files present in stillClaimed', () => {
      withAgentsLock(collabDir, (token) => {
        seedInterest(token, 'sess-2', 'a.js');
        seedInterest(token, 'sess-2', 'b.js');

        const events = buildFileFreedEvents(token, collabDir, {
          releasedBy: 'sess-1',
          files: ['a.js', 'b.js'],
          reason: 'scavenge',
          stillClaimed: new Set(['a.js'])
        });
        assert.equal(events.length, 1);
        assert.equal(events[0].meta.file, 'b.js');
      });
    });

    it('accepts excludeRecipients as a Set', () => {
      withAgentsLock(collabDir, (token) => {
        seedInterest(token, 'sess-2', 'x.js');
        seedInterest(token, 'sess-3', 'x.js');

        const events = buildFileFreedEvents(token, collabDir, {
          releasedBy: 'sess-1',
          files: ['x.js'],
          reason: 'handoff',
          excludeRecipients: new Set(['sess-2'])
        });
        assert.equal(events.length, 1);
        assert.equal(events[0].to, 'sess-3');
      });
    });

    it('accepts excludeRecipients as an Array', () => {
      withAgentsLock(collabDir, (token) => {
        seedInterest(token, 'sess-2', 'x.js');
        seedInterest(token, 'sess-3', 'x.js');

        const events = buildFileFreedEvents(token, collabDir, {
          releasedBy: 'sess-1',
          files: ['x.js'],
          reason: 'handoff',
          excludeRecipients: ['sess-2']
        });
        assert.equal(events.length, 1);
        assert.equal(events[0].to, 'sess-3');
      });
    });

    it('never emits a file_freed event back to the releaser', () => {
      withAgentsLock(collabDir, (token) => {
        seedInterest(token, 'sess-1', 'self.js');
        seedInterest(token, 'sess-2', 'self.js');

        const events = buildFileFreedEvents(token, collabDir, {
          releasedBy: 'sess-1', files: ['self.js'], reason: 'session_cleanup'
        });
        assert.equal(events.length, 1);
        assert.equal(events[0].to, 'sess-2');
      });
    });

    it('fans out one event per (file × interested agent)', () => {
      withAgentsLock(collabDir, (token) => {
        seedInterest(token, 'sess-2', 'f1.js');
        seedInterest(token, 'sess-3', 'f1.js');
        seedInterest(token, 'sess-2', 'f2.js');

        const events = buildFileFreedEvents(token, collabDir, {
          releasedBy: 'sess-1', files: ['f1.js', 'f2.js'], reason: 'scavenge'
        });
        assert.equal(events.length, 3);
        const pairs = events.map(e => e.meta.file + '→' + e.to).sort();
        assert.deepEqual(pairs, ['f1.js→sess-2', 'f1.js→sess-3', 'f2.js→sess-2']);
      });
    });
  });
});
