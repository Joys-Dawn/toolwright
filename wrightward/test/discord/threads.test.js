'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { createThreads, indexPath, threadName, readIndex } = require('../../discord/threads');
const { DiscordApiError, MAX_THREAD_NAME_LEN } = require('../../discord/api');
const { ensureCollabDir } = require('../../lib/collab-dir');

function makeMockApi() {
  const calls = {
    createForumThread: [],
    editChannel: [],
    archiveThread: [],
    deleteThread: []
  };
  let threadCounter = 100;
  const api = {
    async createForumThread(forumChannelId, name, content, opts) {
      calls.createForumThread.push({ forumChannelId, name, content, opts });
      return { id: 'thread-' + (++threadCounter), name };
    },
    async editChannel(channelId, patch) {
      calls.editChannel.push({ channelId, patch });
    },
    async archiveThread(threadId) {
      calls.archiveThread.push({ threadId });
    },
    async deleteThread(threadId) {
      calls.deleteThread.push({ threadId });
    }
  };
  api.calls = calls;
  return api;
}

describe('discord/threads', () => {
  describe('threadName', () => {
    it('formats task with short-ID suffix', () => {
      assert.equal(threadName('auth refactor', 'sess-abcdefgh12'), 'auth refactor (sess-abc)');
    });

    it('falls back to "session" when task is empty', () => {
      assert.equal(threadName('', 'sess-abcdef12'), 'session (sess-abc)');
    });

    it('omits shortId suffix when sessionId is empty', () => {
      assert.equal(threadName('work', ''), 'work');
    });

    it('truncates at 100 chars with … ellipsis', () => {
      const longTask = 'x'.repeat(200);
      const name = threadName(longTask, 'sess-12345678');
      assert.ok(name.length <= MAX_THREAD_NAME_LEN);
      assert.ok(name.endsWith(' (sess-123)'));
      assert.match(name, /…/);
    });

    it('never exceeds MAX_THREAD_NAME_LEN', () => {
      for (const len of [50, 88, 89, 100, 150, 500]) {
        const name = threadName('a'.repeat(len), 'sess-12345678');
        assert.ok(name.length <= MAX_THREAD_NAME_LEN,
          'len=' + len + ' produced ' + name.length + ' chars');
      }
    });
  });

  describe('createThreads factory', () => {
    let tmpDir, collabDir;
    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'threads-test-'));
      collabDir = ensureCollabDir(tmpDir);
    });
    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('throws when required args are missing', () => {
      assert.throws(() => createThreads(null, {}, 'forum'), /collabDir/);
      assert.throws(() => createThreads(collabDir, null, 'forum'), /api/);
      assert.throws(() => createThreads(collabDir, {}, null), /forumChannelId/);
    });

    describe('ensureThreadForSession', () => {
      it('creates a thread and stores the mapping', async () => {
        const api = makeMockApi();
        const threads = createThreads(collabDir, api, 'forum-1');

        const threadId = await threads.ensureThreadForSession('sess-abc12345', 'auth work');
        assert.ok(threadId);
        assert.equal(api.calls.createForumThread.length, 1);
        const createCall = api.calls.createForumThread[0];
        assert.equal(createCall.forumChannelId, 'forum-1');
        assert.equal(createCall.name, 'auth work (sess-abc)');

        // Verify persistence
        const idx = readIndex(collabDir);
        assert.ok(idx['sess-abc12345']);
        assert.equal(idx['sess-abc12345'].thread_id, threadId);
        assert.equal(idx['sess-abc12345'].archived_at, null);
      });

      it('returns existing thread_id without re-creating on re-call', async () => {
        const api = makeMockApi();
        const threads = createThreads(collabDir, api, 'forum-1');

        const t1 = await threads.ensureThreadForSession('sess-a', 'task');
        const t2 = await threads.ensureThreadForSession('sess-a', 'task');
        assert.equal(t1, t2);
        assert.equal(api.calls.createForumThread.length, 1, 'must not re-create');
      });

      it('re-creates thread if previous was archived', async () => {
        // If a session is reopened after its thread was archived, a new thread
        // should be created so the session has a live place to post.
        const api = makeMockApi();
        const threads = createThreads(collabDir, api, 'forum-1');

        await threads.ensureThreadForSession('sess-a', 'first');
        await threads.archiveThread('sess-a');
        const t2 = await threads.ensureThreadForSession('sess-a', 'again');
        assert.equal(api.calls.createForumThread.length, 2);
        assert.ok(t2);
      });

      it('persists atomically via atomicWriteJson', async () => {
        const api = makeMockApi();
        const threads = createThreads(collabDir, api, 'forum-1');
        await threads.ensureThreadForSession('sess-a', 'task');
        assert.ok(fs.existsSync(indexPath(collabDir)));
      });

      it('throws if createForumThread returns no id', async () => {
        const api = makeMockApi();
        api.createForumThread = async () => ({ /* no id */ });
        const threads = createThreads(collabDir, api, 'forum-1');
        await assert.rejects(() => threads.ensureThreadForSession('sess-a', 'x'), /no id/);
      });
    });

    describe('renameThread', () => {
      it('PATCHes the thread with a new name', async () => {
        const api = makeMockApi();
        const threads = createThreads(collabDir, api, 'forum-1');
        await threads.ensureThreadForSession('sess-a', 'old task');
        api.calls.editChannel = []; // reset

        const result = await threads.renameThread('sess-a', 'new task');
        assert.ok(result);
        assert.equal(api.calls.editChannel.length, 1);
        assert.match(api.calls.editChannel[0].patch.name, /new task \(sess-a\)/);
      });

      it('returns null when session has no thread', async () => {
        const api = makeMockApi();
        const threads = createThreads(collabDir, api, 'forum-1');
        const r = await threads.renameThread('unknown-session', 'whatever');
        assert.equal(r, null);
        assert.equal(api.calls.editChannel.length, 0);
      });

      it('returns null (no-op) when thread is archived', async () => {
        const api = makeMockApi();
        const threads = createThreads(collabDir, api, 'forum-1');
        await threads.ensureThreadForSession('sess-a', 'task');
        await threads.archiveThread('sess-a');

        const r = await threads.renameThread('sess-a', 'new');
        assert.equal(r, null);
      });

      it('propagates 429 errors from API (rate-limit lives in api.js, not threads.js)', async () => {
        const api = makeMockApi();
        api.editChannel = async () => { throw new DiscordApiError(429, 'rate limited'); };
        const threads = createThreads(collabDir, api, 'forum-1');
        await threads.ensureThreadForSession('sess-a', 'task');
        await assert.rejects(() => threads.renameThread('sess-a', 'new'),
          (err) => err instanceof DiscordApiError && err.status === 429);
      });

      it('skips the PATCH when the rendered name is unchanged', async () => {
        const api = makeMockApi();
        const threads = createThreads(collabDir, api, 'forum-1');
        await threads.ensureThreadForSession('sess-a', 'same task');
        api.calls.editChannel = []; // reset post-create state

        // Same task → same rendered name → no PATCH.
        const r1 = await threads.renameThread('sess-a', 'same task');
        assert.equal(api.calls.editChannel.length, 0);
        assert.ok(r1, 'returns the existing thread_id without firing PATCH');

        // A real rename does fire the PATCH and updates rendered_name.
        await threads.renameThread('sess-a', 'new task');
        assert.equal(api.calls.editChannel.length, 1);

        // Repeat of the new task → still no PATCH.
        await threads.renameThread('sess-a', 'new task');
        assert.equal(api.calls.editChannel.length, 1,
          'no additional PATCH for the same rendered name');
      });

      it('skips the PATCH when two distinct long task strings render to the same name', async () => {
        const api = makeMockApi();
        const threads = createThreads(collabDir, api, 'forum-1');
        // Long task that will truncate at the 100-char-minus-suffix limit.
        const longA = 'a'.repeat(200) + '-first-distinguishing-suffix';
        const longB = 'a'.repeat(200) + '-second-different-suffix-that-still-gets-lost-post-truncation';
        await threads.ensureThreadForSession('sess-x', longA);
        api.calls.editChannel = [];
        await threads.renameThread('sess-x', longB);
        // Both tasks truncate to a 100-char name with ' (sess-x)' suffix —
        // same rendered name → PATCH must not fire.
        assert.equal(api.calls.editChannel.length, 0);
      });
    });

    describe('archiveThread', () => {
      it('PATCHes with {archived: true} and records archived_at', async () => {
        const api = makeMockApi();
        const threads = createThreads(collabDir, api, 'forum-1');
        await threads.ensureThreadForSession('sess-a', 'task');

        const before = Date.now();
        await threads.archiveThread('sess-a');
        const after = Date.now();

        assert.equal(api.calls.archiveThread.length, 1);
        const idx = readIndex(collabDir);
        assert.ok(idx['sess-a'].archived_at >= before);
        assert.ok(idx['sess-a'].archived_at <= after);
      });

      it('returns null when session has no thread', async () => {
        const api = makeMockApi();
        const threads = createThreads(collabDir, api, 'forum-1');
        const r = await threads.archiveThread('unknown');
        assert.equal(r, null);
      });

      it('is idempotent on already-archived sessions', async () => {
        const api = makeMockApi();
        const threads = createThreads(collabDir, api, 'forum-1');
        await threads.ensureThreadForSession('sess-a', 'task');
        await threads.archiveThread('sess-a');
        api.calls.archiveThread = [];

        const r = await threads.archiveThread('sess-a');
        assert.ok(r, 'must return thread id even when already archived');
        assert.equal(api.calls.archiveThread.length, 0,
          'must not re-call Discord when already archived locally');
      });

      it('treats Discord 400 "already archived" as success', async () => {
        // Discord auto-archives inactive threads; our local state may not
        // reflect that. Archive attempt then succeeds as a no-op.
        const api = makeMockApi();
        api.archiveThread = async () => {
          throw new DiscordApiError(400, 'Thread is archived');
        };
        const threads = createThreads(collabDir, api, 'forum-1');
        await threads.ensureThreadForSession('sess-a', 'task');
        const r = await threads.archiveThread('sess-a');
        assert.ok(r);
        const idx = readIndex(collabDir);
        assert.ok(idx['sess-a'].archived_at);
      });

      it('treats Discord 404 (missing thread) as success', async () => {
        const api = makeMockApi();
        api.archiveThread = async () => { throw new DiscordApiError(404, 'Unknown Channel'); };
        const threads = createThreads(collabDir, api, 'forum-1');
        await threads.ensureThreadForSession('sess-a', 'task');
        const r = await threads.archiveThread('sess-a');
        assert.ok(r);
      });

      it('propagates other API errors', async () => {
        const api = makeMockApi();
        api.archiveThread = async () => { throw new DiscordApiError(500, 'server error'); };
        const threads = createThreads(collabDir, api, 'forum-1');
        await threads.ensureThreadForSession('sess-a', 'task');
        await assert.rejects(() => threads.archiveThread('sess-a'),
          (err) => err.status === 500);
      });
    });

    describe('pruneArchivedBefore', () => {
      it('deletes archived threads older than the cutoff and removes them from the index', async () => {
        const api = makeMockApi();
        const threads = createThreads(collabDir, api, 'forum-1');
        await threads.ensureThreadForSession('sess-old', 'long-finished');
        await threads.archiveThread('sess-old');

        // Pretend the archive happened in the past — bridge.archiveThread
        // stamps Date.now(); back-date by mutating the index directly.
        const idxPath = indexPath(collabDir);
        const idx = JSON.parse(fs.readFileSync(idxPath, 'utf8'));
        const originalThreadId = idx['sess-old'].thread_id;
        idx['sess-old'].archived_at = Date.now() - 30 * 24 * 60 * 60 * 1000; // 30 days ago
        fs.writeFileSync(idxPath, JSON.stringify(idx));

        const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000; // older than 7 days
        const result = await threads.pruneArchivedBefore(cutoff);

        assert.deepEqual(result.deleted, ['sess-old']);
        assert.deepEqual(result.failed, []);
        assert.deepEqual(result.skipped, []);
        assert.equal(api.calls.deleteThread.length, 1);
        assert.equal(api.calls.deleteThread[0].threadId, originalThreadId);
        // Index entry must be removed so we don't keep retrying a dead thread.
        assert.equal(readIndex(collabDir)['sess-old'], undefined);
      });

      it('skips entries that are not archived', async () => {
        // Live (un-archived) threads must never be deleted by prune — only
        // archived_at-stamped entries are candidates.
        const api = makeMockApi();
        const threads = createThreads(collabDir, api, 'forum-1');
        await threads.ensureThreadForSession('sess-live', 'in-progress');

        const result = await threads.pruneArchivedBefore(Date.now());
        assert.deepEqual(result.deleted, []);
        assert.deepEqual(result.skipped, ['sess-live']);
        assert.equal(api.calls.deleteThread.length, 0);
        assert.ok(readIndex(collabDir)['sess-live'], 'live entry must remain');
      });

      it('skips archived entries newer than the cutoff', async () => {
        const api = makeMockApi();
        const threads = createThreads(collabDir, api, 'forum-1');
        await threads.ensureThreadForSession('sess-recent', 'task');
        await threads.archiveThread('sess-recent');

        // Cutoff = 1 hour ago; entry archived just now → newer than cutoff → skip.
        const result = await threads.pruneArchivedBefore(Date.now() - 60 * 60 * 1000);
        assert.deepEqual(result.deleted, []);
        assert.deepEqual(result.skipped, ['sess-recent']);
        assert.equal(api.calls.deleteThread.length, 0);
      });

      it('treats Discord 404 (already deleted) as success and removes the index entry', async () => {
        // Discord may have purged the thread under us. Idempotent path: we
        // don't keep retrying a dead reference — drop it from the local map.
        const api = makeMockApi();
        api.deleteThread = async () => { throw new DiscordApiError(404, 'Unknown Channel'); };
        const threads = createThreads(collabDir, api, 'forum-1');
        await threads.ensureThreadForSession('sess-gone', 'task');
        await threads.archiveThread('sess-gone');
        const idxPath = indexPath(collabDir);
        const idx = JSON.parse(fs.readFileSync(idxPath, 'utf8'));
        idx['sess-gone'].archived_at = 1; // way before cutoff
        fs.writeFileSync(idxPath, JSON.stringify(idx));

        const result = await threads.pruneArchivedBefore(Date.now());
        assert.deepEqual(result.deleted, ['sess-gone']);
        assert.deepEqual(result.failed, []);
        assert.equal(readIndex(collabDir)['sess-gone'], undefined);
      });

      it('treats Discord 403 (lost permission) as success and removes the index entry', async () => {
        // If the bot was kicked or its role was downgraded, DELETE returns
        // 403 — we can't manage the thread anymore, so drop it locally.
        const api = makeMockApi();
        api.deleteThread = async () => { throw new DiscordApiError(403, 'Missing Access'); };
        const threads = createThreads(collabDir, api, 'forum-1');
        await threads.ensureThreadForSession('sess-noperm', 'task');
        await threads.archiveThread('sess-noperm');
        const idxPath = indexPath(collabDir);
        const idx = JSON.parse(fs.readFileSync(idxPath, 'utf8'));
        idx['sess-noperm'].archived_at = 1;
        fs.writeFileSync(idxPath, JSON.stringify(idx));

        const result = await threads.pruneArchivedBefore(Date.now());
        assert.deepEqual(result.deleted, ['sess-noperm']);
        assert.equal(readIndex(collabDir)['sess-noperm'], undefined);
      });

      it('records other API errors in failed[] without removing the entry', async () => {
        // 500/network/etc. are transient — keep the entry so a future prune
        // can retry. Anything we can't classify as "permanently gone" stays.
        const api = makeMockApi();
        api.deleteThread = async () => { throw new DiscordApiError(500, 'server error'); };
        const threads = createThreads(collabDir, api, 'forum-1');
        await threads.ensureThreadForSession('sess-flaky', 'task');
        await threads.archiveThread('sess-flaky');
        const idxPath = indexPath(collabDir);
        const idx = JSON.parse(fs.readFileSync(idxPath, 'utf8'));
        idx['sess-flaky'].archived_at = 1;
        fs.writeFileSync(idxPath, JSON.stringify(idx));

        const result = await threads.pruneArchivedBefore(Date.now());
        assert.deepEqual(result.deleted, []);
        assert.equal(result.failed.length, 1);
        assert.equal(result.failed[0].sid, 'sess-flaky');
        assert.match(result.failed[0].error, /server error/);
        // Entry remains so the next prune can retry.
        assert.ok(readIndex(collabDir)['sess-flaky']);
      });

      it('processes a mixed batch — deleted, skipped, failed reported separately', async () => {
        let callIdx = 0;
        const api = makeMockApi();
        api.deleteThread = async () => {
          // First archived candidate: succeeds. Second: 500.
          callIdx++;
          if (callIdx === 2) throw new DiscordApiError(500, 'transient');
          return null;
        };
        const threads = createThreads(collabDir, api, 'forum-1');
        await threads.ensureThreadForSession('sess-1', 't');
        await threads.ensureThreadForSession('sess-2', 't');
        await threads.ensureThreadForSession('sess-3', 't');
        await threads.archiveThread('sess-1');
        await threads.archiveThread('sess-2');
        // sess-3 stays live (un-archived) → must be skipped, not deleted.

        const idxPath = indexPath(collabDir);
        const idx = JSON.parse(fs.readFileSync(idxPath, 'utf8'));
        idx['sess-1'].archived_at = 1;
        idx['sess-2'].archived_at = 1;
        fs.writeFileSync(idxPath, JSON.stringify(idx));

        const result = await threads.pruneArchivedBefore(Date.now());
        assert.deepEqual(result.deleted, ['sess-1']);
        assert.equal(result.failed.length, 1);
        assert.equal(result.failed[0].sid, 'sess-2');
        assert.deepEqual(result.skipped, ['sess-3']);
      });

      it('returns empty arrays when the index is empty', async () => {
        const api = makeMockApi();
        const threads = createThreads(collabDir, api, 'forum-1');
        const result = await threads.pruneArchivedBefore(Date.now());
        assert.deepEqual(result, { deleted: [], failed: [], skipped: [] });
        assert.equal(api.calls.deleteThread.length, 0);
      });
    });

    describe('lookup helpers', () => {
      it('getThreadIdFor returns stored thread id', async () => {
        const api = makeMockApi();
        const threads = createThreads(collabDir, api, 'forum-1');
        const tid = await threads.ensureThreadForSession('sess-a', 'task');
        assert.equal(threads.getThreadIdFor('sess-a'), tid);
      });

      it('getThreadIdFor returns null for unknown session', async () => {
        const api = makeMockApi();
        const threads = createThreads(collabDir, api, 'forum-1');
        assert.equal(threads.getThreadIdFor('unknown'), null);
      });

      it('listSessions returns all keys from the index', async () => {
        const api = makeMockApi();
        const threads = createThreads(collabDir, api, 'forum-1');
        await threads.ensureThreadForSession('sess-a', 'task-a');
        await threads.ensureThreadForSession('sess-b', 'task-b');
        assert.deepEqual(threads.listSessions().sort(), ['sess-a', 'sess-b']);
      });
    });
  });
});
