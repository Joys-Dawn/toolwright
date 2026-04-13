'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { ensureCollabDir } = require('../../lib/collab-dir');
const { withAgentsLock } = require('../../lib/agents');
const { createEvent } = require('../../lib/bus-schema');
const { append, busPath } = require('../../lib/bus-log');
const interestIndex = require('../../lib/interest-index');

describe('interest-index', () => {
  let tmpDir;
  let collabDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'idx-test-'));
    collabDir = ensureCollabDir(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('read', () => {
    it('returns {} for missing file', () => {
      const idx = interestIndex.read(collabDir);
      assert.deepEqual(idx, {});
    });

    it('throws on corrupt file so callers can trigger rebuild', () => {
      fs.mkdirSync(path.dirname(interestIndex.indexPath(collabDir)), { recursive: true });
      fs.writeFileSync(interestIndex.indexPath(collabDir), 'not-json', 'utf8');
      assert.throws(() => interestIndex.read(collabDir));
    });
  });

  describe('upsert', () => {
    it('adds entry to new file key', () => {
      withAgentsLock(collabDir, (token) => {
        interestIndex.upsert(token, collabDir, 'src/auth.ts', {
          sessionId: 'sess-1', busEventId: 'ev-1', declaredAt: 1000, expiresAt: 2000
        });
      });
      const idx = interestIndex.read(collabDir);
      assert.equal(idx['src/auth.ts'].length, 1);
      assert.equal(idx['src/auth.ts'][0].sessionId, 'sess-1');
    });

    it('adds second entry to same file', () => {
      withAgentsLock(collabDir, (token) => {
        interestIndex.upsert(token, collabDir, 'src/auth.ts', {
          sessionId: 'sess-1', busEventId: 'ev-1', declaredAt: 1000, expiresAt: 2000
        });
        interestIndex.upsert(token, collabDir, 'src/auth.ts', {
          sessionId: 'sess-2', busEventId: 'ev-2', declaredAt: 1100, expiresAt: 2100
        });
      });
      const idx = interestIndex.read(collabDir);
      assert.equal(idx['src/auth.ts'].length, 2);
    });

    it('deduplicates by (sessionId, file) — updates in place', () => {
      withAgentsLock(collabDir, (token) => {
        interestIndex.upsert(token, collabDir, 'src/auth.ts', {
          sessionId: 'sess-1', busEventId: 'ev-1', declaredAt: 1000, expiresAt: 2000
        });
        interestIndex.upsert(token, collabDir, 'src/auth.ts', {
          sessionId: 'sess-1', busEventId: 'ev-2', declaredAt: 3000, expiresAt: 4000
        });
      });
      const idx = interestIndex.read(collabDir);
      assert.equal(idx['src/auth.ts'].length, 1);
      assert.equal(idx['src/auth.ts'][0].busEventId, 'ev-2');
      assert.equal(idx['src/auth.ts'][0].declaredAt, 3000);
    });
  });

  describe('removeBySession', () => {
    it('removes all entries for session', () => {
      withAgentsLock(collabDir, (token) => {
        interestIndex.upsert(token, collabDir, 'a.js', { sessionId: 'sess-1', busEventId: 'e1', declaredAt: 1, expiresAt: 2 });
        interestIndex.upsert(token, collabDir, 'b.js', { sessionId: 'sess-1', busEventId: 'e2', declaredAt: 1, expiresAt: 2 });
        interestIndex.upsert(token, collabDir, 'a.js', { sessionId: 'sess-2', busEventId: 'e3', declaredAt: 1, expiresAt: 2 });

        interestIndex.removeBySession(token, collabDir, 'sess-1');
      });
      const idx = interestIndex.read(collabDir);
      assert.equal(idx['a.js'].length, 1);
      assert.equal(idx['a.js'][0].sessionId, 'sess-2');
      assert.equal(idx['b.js'], undefined);
    });

    it('removes empty file keys', () => {
      withAgentsLock(collabDir, (token) => {
        interestIndex.upsert(token, collabDir, 'only.js', { sessionId: 'sess-1', busEventId: 'e1', declaredAt: 1, expiresAt: 2 });
        interestIndex.removeBySession(token, collabDir, 'sess-1');
      });
      const idx = interestIndex.read(collabDir);
      assert.equal(idx['only.js'], undefined);
    });

    it('leaves other sessions intact', () => {
      withAgentsLock(collabDir, (token) => {
        interestIndex.upsert(token, collabDir, 'shared.js', { sessionId: 'sess-1', busEventId: 'e1', declaredAt: 1, expiresAt: 2 });
        interestIndex.upsert(token, collabDir, 'shared.js', { sessionId: 'sess-2', busEventId: 'e2', declaredAt: 1, expiresAt: 2 });
        interestIndex.removeBySession(token, collabDir, 'sess-1');
      });
      const idx = interestIndex.read(collabDir);
      assert.equal(idx['shared.js'].length, 1);
      assert.equal(idx['shared.js'][0].sessionId, 'sess-2');
    });

    it('no-op on missing index file', () => {
      withAgentsLock(collabDir, (token) => {
        assert.doesNotThrow(() => interestIndex.removeBySession(token, collabDir, 'sess-1'));
      });
    });
  });

  describe('rebuild', () => {
    it('rebuilds from bus.jsonl with interest events', () => {
      withAgentsLock(collabDir, (token) => {
        const e1 = createEvent('sess-1', 'all', 'interest', 'watching', { file: 'src/auth.ts' });
        e1.expires_at = Date.now() + 60000;
        append(token, collabDir, e1);

        const e2 = createEvent('sess-2', 'all', 'interest', 'watching', { file: 'src/jwt.ts' });
        append(token, collabDir, e2);

        append(token, collabDir, createEvent('sess-1', 'all', 'note', 'hello'));

        interestIndex.rebuild(token, collabDir);
      });

      const idx = interestIndex.read(collabDir);
      assert.equal(idx['src/auth.ts'].length, 1);
      assert.equal(idx['src/auth.ts'][0].sessionId, 'sess-1');
      assert.equal(idx['src/jwt.ts'].length, 1);
      assert.equal(idx['src/jwt.ts'][0].sessionId, 'sess-2');
      assert.equal(Object.keys(idx).length, 2);
    });

    it('recovers from corrupted index', () => {
      withAgentsLock(collabDir, (token) => {
        const e = createEvent('sess-1', 'all', 'interest', 'watching', { file: 'x.js' });
        append(token, collabDir, e);
      });

      fs.mkdirSync(path.dirname(interestIndex.indexPath(collabDir)), { recursive: true });
      fs.writeFileSync(interestIndex.indexPath(collabDir), 'CORRUPT', 'utf8');

      withAgentsLock(collabDir, (token) => {
        interestIndex.rebuild(token, collabDir);
      });
      const idx = interestIndex.read(collabDir);
      assert.equal(idx['x.js'].length, 1);
    });
  });
});
