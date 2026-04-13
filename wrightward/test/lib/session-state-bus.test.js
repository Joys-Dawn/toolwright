'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { ensureCollabDir } = require('../../lib/collab-dir');
const { registerAgent, withAgentsLock } = require('../../lib/agents');
const { writeContext, readContext } = require('../../lib/context');
const { removeSessionState, scavengeExpiredSessions, scavengeExpiredFiles } = require('../../lib/session-state');
const { busPath } = require('../../lib/bus-log');
const { loadConfig } = require('../../lib/config');
const interestIndex = require('../../lib/interest-index');

function fe(prefix, filePath) {
  return { path: filePath, prefix, source: 'planned', declaredAt: Date.now(), lastTouched: Date.now(), reminded: false };
}

describe('session-state bus integration', () => {
  let tmpDir;
  let collabDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-bus-test-'));
    collabDir = ensureCollabDir(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('removeSessionState', () => {
    it('emits file_freed for each interested agent', () => {
      registerAgent(collabDir, 'sess-A');
      registerAgent(collabDir, 'sess-B');
      writeContext(collabDir, 'sess-A', {
        task: 'auth work',
        files: [fe('+', 'auth.ts')],
        status: 'in-progress'
      });

      // sess-B is interested in auth.ts
      withAgentsLock(collabDir, (token) => {
        interestIndex.upsert(token, collabDir, 'auth.ts', {
          sessionId: 'sess-B', busEventId: 'e1', declaredAt: Date.now(), expiresAt: null
        });
      });

      removeSessionState(collabDir, 'sess-A');

      const bp = busPath(collabDir);
      assert.ok(fs.existsSync(bp));
      const events = fs.readFileSync(bp, 'utf8').trim().split('\n').map(l => JSON.parse(l));
      const freed = events.find(e => e.type === 'file_freed' && e.to === 'sess-B');
      assert.ok(freed, 'Expected file_freed for sess-B');
      assert.equal(freed.meta.file, 'auth.ts');
    });

    it('cleans interest index entries for the session', () => {
      registerAgent(collabDir, 'sess-A');
      registerAgent(collabDir, 'sess-B');
      writeContext(collabDir, 'sess-A', { task: 'work', files: [], status: 'in-progress' });

      withAgentsLock(collabDir, (token) => {
        interestIndex.upsert(token, collabDir, 'shared.js', {
          sessionId: 'sess-A', busEventId: 'e1', declaredAt: Date.now(), expiresAt: null
        });
        interestIndex.upsert(token, collabDir, 'shared.js', {
          sessionId: 'sess-B', busEventId: 'e2', declaredAt: Date.now(), expiresAt: null
        });
      });

      removeSessionState(collabDir, 'sess-A');

      const idx = interestIndex.read(collabDir);
      // sess-A's entries should be gone
      if (idx['shared.js']) {
        assert.ok(!idx['shared.js'].some(e => e.sessionId === 'sess-A'));
      }
      // sess-B's entries should remain
      assert.ok(idx['shared.js']);
      assert.ok(idx['shared.js'].some(e => e.sessionId === 'sess-B'));
    });

    it('removes context, context-hash, and agent entry', () => {
      registerAgent(collabDir, 'sess-A');
      writeContext(collabDir, 'sess-A', { task: 'work', files: [], status: 'in-progress' });

      removeSessionState(collabDir, 'sess-A');

      assert.equal(readContext(collabDir, 'sess-A'), null);
      // Agent entry should be gone
      const { readAgents } = require('../../lib/agents');
      const agents = readAgents(collabDir);
      assert.ok(!agents['sess-A']);
    });

    it('does not crash if context is null', () => {
      registerAgent(collabDir, 'sess-A');
      // Don't write any context
      assert.doesNotThrow(() => removeSessionState(collabDir, 'sess-A'));
    });

    it('does not emit file_freed for self', () => {
      registerAgent(collabDir, 'sess-A');
      writeContext(collabDir, 'sess-A', {
        task: 'work',
        files: [fe('+', 'mine.ts')],
        status: 'in-progress'
      });

      // sess-A is also interested in its own file (shouldn't happen normally, but be safe)
      withAgentsLock(collabDir, (token) => {
        interestIndex.upsert(token, collabDir, 'mine.ts', {
          sessionId: 'sess-A', busEventId: 'e1', declaredAt: Date.now(), expiresAt: null
        });
      });

      removeSessionState(collabDir, 'sess-A');

      const bp = busPath(collabDir);
      const events = fs.existsSync(bp)
        ? fs.readFileSync(bp, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
        : [];
      const selfFreed = events.find(e => e.type === 'file_freed' && e.to === 'sess-A');
      assert.ok(!selfFreed, 'Should NOT emit file_freed to self');
    });

    it('skips files with deleted prefix', () => {
      registerAgent(collabDir, 'sess-A');
      registerAgent(collabDir, 'sess-B');
      writeContext(collabDir, 'sess-A', {
        task: 'work',
        files: [
          fe('+', 'active.ts'),
          { ...fe('-', 'deleted.ts'), prefix: '-' }
        ],
        status: 'in-progress'
      });

      withAgentsLock(collabDir, (token) => {
        interestIndex.upsert(token, collabDir, 'active.ts', {
          sessionId: 'sess-B', busEventId: 'e1', declaredAt: Date.now(), expiresAt: null
        });
        interestIndex.upsert(token, collabDir, 'deleted.ts', {
          sessionId: 'sess-B', busEventId: 'e2', declaredAt: Date.now(), expiresAt: null
        });
      });

      removeSessionState(collabDir, 'sess-A');

      const events = fs.readFileSync(busPath(collabDir), 'utf8').trim().split('\n').map(l => JSON.parse(l));
      const freedActive = events.find(e => e.type === 'file_freed' && e.meta.file === 'active.ts');
      const freedDeleted = events.find(e => e.type === 'file_freed' && e.meta.file === 'deleted.ts');
      assert.ok(freedActive, 'Should emit file_freed for active file');
      assert.ok(!freedDeleted, 'Should NOT emit file_freed for deleted file');
    });
  });

  describe('scavengeExpiredSessions', () => {
    it('emits file_freed for all expired sessions files', () => {
      registerAgent(collabDir, 'sess-expired');
      registerAgent(collabDir, 'sess-alive');
      registerAgent(collabDir, 'sess-watcher');
      writeContext(collabDir, 'sess-expired', {
        task: 'old work',
        files: [fe('+', 'target.js')],
        status: 'in-progress'
      });

      // Make sess-expired stale + seed watcher interest
      const { readAgents, writeAgents } = require('../../lib/agents');
      withAgentsLock(collabDir, (token) => {
        const agents = readAgents(collabDir);
        agents['sess-expired'].last_active = Date.now() - 999999;
        writeAgents(collabDir, agents);
        interestIndex.upsert(token, collabDir, 'target.js', {
          sessionId: 'sess-watcher', busEventId: 'e1', declaredAt: Date.now(), expiresAt: null
        });
      });

      const removed = scavengeExpiredSessions(collabDir, 60000, 'sess-alive');
      assert.ok(removed.includes('sess-expired'));

      const bp = busPath(collabDir);
      assert.ok(fs.existsSync(bp), 'bus.jsonl must exist after scavenge emitted file_freed');
      const events = fs.readFileSync(bp, 'utf8').trim().split('\n').map(l => JSON.parse(l));
      const freed = events.find(e => e.type === 'file_freed' && e.to === 'sess-watcher');
      assert.ok(freed, 'Expected file_freed for interested watcher');
    });

    it('cleans interest index per expired session', () => {
      registerAgent(collabDir, 'sess-expired');
      registerAgent(collabDir, 'sess-alive');

      const { readAgents, writeAgents } = require('../../lib/agents');
      withAgentsLock(collabDir, (token) => {
        interestIndex.upsert(token, collabDir, 'file.js', {
          sessionId: 'sess-expired', busEventId: 'e1', declaredAt: Date.now(), expiresAt: null
        });
        interestIndex.upsert(token, collabDir, 'file.js', {
          sessionId: 'sess-alive', busEventId: 'e2', declaredAt: Date.now(), expiresAt: null
        });

        const agents = readAgents(collabDir);
        agents['sess-expired'].last_active = Date.now() - 999999;
        writeAgents(collabDir, agents);
      });

      scavengeExpiredSessions(collabDir, 60000, 'sess-alive');

      const idx = interestIndex.read(collabDir);
      if (idx['file.js']) {
        assert.ok(!idx['file.js'].some(e => e.sessionId === 'sess-expired'));
        assert.ok(idx['file.js'].some(e => e.sessionId === 'sess-alive'));
      }
    });

    it('returns list of removed session IDs', () => {
      registerAgent(collabDir, 'sess-old');
      registerAgent(collabDir, 'sess-current');

      const { readAgents, writeAgents } = require('../../lib/agents');
      withAgentsLock(collabDir, (token) => {
        const agents = readAgents(collabDir);
        agents['sess-old'].last_active = Date.now() - 999999;
        writeAgents(collabDir, agents);
      });

      const removed = scavengeExpiredSessions(collabDir, 60000, 'sess-current');
      assert.ok(removed.includes('sess-old'));
      assert.ok(!removed.includes('sess-current'));
    });
  });

  describe('scavengeExpiredFiles return value', () => {
    it('returns removed file entries as { sessionId, file }', () => {
      registerAgent(collabDir, 'sess-1');
      const config = loadConfig('');
      const oldTime = Date.now() - config.AUTO_TRACKED_FILE_TIMEOUT_MS - 1000;
      writeContext(collabDir, 'sess-1', {
        task: 'work',
        files: [
          { path: 'old.js', prefix: '~', source: 'auto', declaredAt: oldTime, lastTouched: oldTime, reminded: false },
          { path: 'recent.js', prefix: '~', source: 'auto', declaredAt: Date.now(), lastTouched: Date.now(), reminded: false }
        ],
        status: 'in-progress'
      });

      const removed = scavengeExpiredFiles(collabDir, config);
      assert.equal(removed.length, 1);
      assert.equal(removed[0].sessionId, 'sess-1');
      assert.equal(removed[0].file, 'old.js');
    });

    it('returns empty array when no files expired', () => {
      registerAgent(collabDir, 'sess-1');
      const config = loadConfig('');
      writeContext(collabDir, 'sess-1', {
        task: 'work',
        files: [
          { path: 'fresh.js', prefix: '~', source: 'auto', declaredAt: Date.now(), lastTouched: Date.now(), reminded: false }
        ],
        status: 'in-progress'
      });

      const removed = scavengeExpiredFiles(collabDir, config);
      assert.equal(removed.length, 0);
    });
  });
});
