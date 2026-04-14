import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { ensureCollabDir } = require('../../lib/collab-dir');
const { registerAgent, withAgentsLock } = require('../../lib/agents');
const { append } = require('../../lib/bus-log');
const { createEvent } = require('../../lib/bus-schema');

const { ring, buildSummary } = await import('../../mcp/channel-doorbell.mjs');

function fakeServer() {
  const calls = [];
  return {
    calls,
    async notification(frame) {
      calls.push(frame);
    }
  };
}

function throwingServer(err) {
  return {
    async notification() {
      throw err;
    }
  };
}

function bookmarkFile(collabDir, sessionId) {
  return path.join(collabDir, 'bus-delivered', sessionId + '.json');
}

function bookmarkBytesOrNull(collabDir, sessionId) {
  try {
    return fs.readFileSync(bookmarkFile(collabDir, sessionId));
  } catch (_) {
    return null;
  }
}

describe('mcp/channel-doorbell', () => {
  let tmpDir;
  let collabDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doorbell-'));
    collabDir = ensureCollabDir(tmpDir);
    registerAgent(collabDir, 'sess-1');
    registerAgent(collabDir, 'sess-2');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('buildSummary', () => {
    it('uses singular wording for exactly one event', () => {
      const text = buildSummary(1);
      assert.ok(text.includes('1 new wrightward bus event.'));
      assert.ok(!text.includes('events'));
    });

    it('uses plural wording for two or more events', () => {
      const text = buildSummary(3);
      assert.ok(text.includes('3 new wrightward bus events'));
    });
  });

  describe('ring', () => {
    it('returns unbound and does not notify when sessionId is null', async () => {
      const server = fakeServer();
      const result = await ring(server, collabDir, null);
      assert.equal(result.pinged, false);
      assert.equal(result.reason, 'unbound');
      assert.equal(server.calls.length, 0);
    });

    it('returns unbound and does not notify when sessionId is empty string', async () => {
      const server = fakeServer();
      const result = await ring(server, collabDir, '');
      assert.equal(result.pinged, false);
      assert.equal(result.reason, 'unbound');
      assert.equal(server.calls.length, 0);
    });

    it('does not notify when inbox is empty', async () => {
      const server = fakeServer();
      const result = await ring(server, collabDir, 'sess-1');
      assert.equal(result.pinged, false);
      assert.equal(result.reason, 'empty');
      assert.equal(server.calls.length, 0);
    });

    it('does not notify when only non-urgent events are present', async () => {
      withAgentsLock(collabDir, (token) => {
        append(token, collabDir, createEvent('sess-2', 'sess-1', 'note', 'not urgent'));
        append(token, collabDir, createEvent('sess-2', 'sess-1', 'finding', 'ambient fyi'));
      });
      const server = fakeServer();
      const result = await ring(server, collabDir, 'sess-1');
      assert.equal(result.pinged, false);
      assert.equal(result.reason, 'empty');
      assert.equal(server.calls.length, 0);
    });

    it('does not notify when urgent events target a different session', async () => {
      withAgentsLock(collabDir, (token) => {
        append(token, collabDir, createEvent('sess-1', 'sess-2', 'handoff', 'for sess-2'));
      });
      const server = fakeServer();
      const result = await ring(server, collabDir, 'sess-1');
      assert.equal(result.pinged, false);
      assert.equal(result.reason, 'empty');
      assert.equal(server.calls.length, 0);
    });

    it('emits exactly one summary notification when one urgent event pending', async () => {
      withAgentsLock(collabDir, (token) => {
        append(token, collabDir, createEvent('sess-2', 'sess-1', 'handoff', 'take over'));
      });
      const server = fakeServer();
      const result = await ring(server, collabDir, 'sess-1');
      assert.equal(result.pinged, true);
      assert.equal(result.pendingCount, 1);
      assert.equal(server.calls.length, 1);
      const frame = server.calls[0];
      assert.equal(frame.method, 'notifications/claude/channel');
      assert.ok(frame.params.content.includes('1 new wrightward bus event.'));
      assert.equal(frame.params.meta.source, 'wrightward-bus');
      assert.equal(frame.params.meta.pending_count, '1');
    });

    it('emits one summary with plural content for multiple urgent events', async () => {
      withAgentsLock(collabDir, (token) => {
        append(token, collabDir, createEvent('sess-2', 'sess-1', 'handoff', 'task A'));
        append(token, collabDir, createEvent('sess-2', 'sess-1', 'file_freed', 'src/auth.ts', { file: 'src/auth.ts' }));
        append(token, collabDir, createEvent('sess-2', 'sess-1', 'blocker', 'perf issue'));
      });
      const server = fakeServer();
      const result = await ring(server, collabDir, 'sess-1');
      assert.equal(result.pinged, true);
      assert.equal(result.pendingCount, 3);
      assert.equal(server.calls.length, 1);
      const frame = server.calls[0];
      assert.ok(frame.params.content.includes('3 new wrightward bus events'));
      assert.equal(frame.params.meta.pending_count, '3');
    });

    it('meta.pending_count is always a string (MCP Channel contract)', async () => {
      withAgentsLock(collabDir, (token) => {
        append(token, collabDir, createEvent('sess-2', 'sess-1', 'handoff', 'x'));
      });
      const server = fakeServer();
      await ring(server, collabDir, 'sess-1');
      const meta = server.calls[0].params.meta;
      for (const v of Object.values(meta)) {
        assert.equal(typeof v, 'string', 'every meta value must be a string');
      }
    });

    it('logs to stderr and resolves normally when server.notification throws', async () => {
      withAgentsLock(collabDir, (token) => {
        append(token, collabDir, createEvent('sess-2', 'sess-1', 'handoff', 'x'));
      });
      const server = throwingServer(new Error('pipe closed'));
      const result = await ring(server, collabDir, 'sess-1');
      assert.equal(result.pinged, false);
      assert.equal(result.reason, 'notification-error');
      assert.ok(result.error.includes('pipe closed'));
    });

    it('returns read-error and does not notify when the lock cannot be acquired', async () => {
      // withAgentsLock throws on any non-EEXIST error from fs.openSync of the
      // lock file. Pointing collabDir at a missing directory forces ENOENT on
      // the first attempt and the lock loop re-throws it. This exercises the
      // try/catch around the lock-held read in ring().
      const server = fakeServer();
      const bogusDir = path.join(tmpDir, 'does-not-exist');
      const result = await ring(server, bogusDir, 'sess-1');
      assert.equal(result.pinged, false);
      assert.equal(result.reason, 'read-error');
      assert.ok(typeof result.error === 'string' && result.error.length > 0, 'error field should be a populated string');
      assert.equal(server.calls.length, 0, 'no notification should be sent on read error');
    });

    it('LOAD-BEARING: bookmark bytes are byte-identical before and after ring()', async () => {
      withAgentsLock(collabDir, (token) => {
        append(token, collabDir, createEvent('sess-2', 'sess-1', 'handoff', 'a'));
        append(token, collabDir, createEvent('sess-2', 'sess-1', 'blocker', 'b'));
      });

      const before = bookmarkBytesOrNull(collabDir, 'sess-1');
      const server = fakeServer();
      const result = await ring(server, collabDir, 'sess-1');
      assert.equal(result.pinged, true, 'precondition: ring() actually fired');
      const after = bookmarkBytesOrNull(collabDir, 'sess-1');

      if (before === null && after === null) {
        // Both absent — valid: ring() created no bookmark file.
        return;
      }
      assert.notEqual(before, null, 'precondition baseline must exist or both be null');
      assert.notEqual(after, null, 'ring() must not delete bookmark either');
      assert.ok(before.equals(after), 'bookmark bytes changed — Path 2 must never write bookmark state');
    });

    it('LOAD-BEARING: bookmark file does not appear after ring() when none existed before', async () => {
      withAgentsLock(collabDir, (token) => {
        append(token, collabDir, createEvent('sess-2', 'sess-1', 'handoff', 'a'));
      });
      assert.equal(bookmarkBytesOrNull(collabDir, 'sess-1'), null, 'precondition: no bookmark');
      const server = fakeServer();
      await ring(server, collabDir, 'sess-1');
      assert.equal(bookmarkBytesOrNull(collabDir, 'sess-1'), null, 'ring() must not create a bookmark');
    });

    it('LOAD-BEARING: unbound sessionId does not acquire the lock', async () => {
      // If ring() calls withAgentsLock with a null sessionId, subsequent
      // lock-held readers would see unbound state unexpectedly. The early
      // return for !sessionId protects against this.
      const server = fakeServer();
      const lockFile = path.join(collabDir, 'agents.json.lock');
      const lockExistedBefore = fs.existsSync(lockFile);
      await ring(server, collabDir, null);
      const lockExistsAfter = fs.existsSync(lockFile);
      // The lock file must not be left behind by ring(null).
      assert.equal(lockExistsAfter, lockExistedBefore, 'unbound ring() must not acquire/leak lock');
    });
  });
});
