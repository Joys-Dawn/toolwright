'use strict';

const path = require('path');
const fs = require('fs');
const { atomicWriteJson } = require('../lib/atomic-write');
const { DiscordApiError, MAX_THREAD_NAME_LEN } = require('./api');
const { SHORT_ID_LEN } = require('../lib/constants');

const INDEX_FILE = 'bus-index/discord-threads.json';

function indexPath(collabDir) {
  return path.join(collabDir, INDEX_FILE);
}

function readIndex(collabDir) {
  try {
    return JSON.parse(fs.readFileSync(indexPath(collabDir), 'utf8'));
  } catch (_) {
    return {};
  }
}

function writeIndex(collabDir, idx) {
  atomicWriteJson(indexPath(collabDir), idx);
}

/**
 * Builds a Discord-compatible thread name: `<task> (<shortId>)`.
 * Truncated at MAX_THREAD_NAME_LEN (100 chars) with an ellipsis marker.
 * Always includes the shortId suffix so users can distinguish sessions whose
 * tasks happen to collide.
 */
function threadName(task, sessionId) {
  const shortId = (sessionId || '').substring(0, SHORT_ID_LEN);
  const suffix = shortId ? ' (' + shortId + ')' : '';
  const maxTaskLen = MAX_THREAD_NAME_LEN - suffix.length;
  let t = (typeof task === 'string' ? task : '').trim() || 'session';
  if (t.length > maxTaskLen) {
    t = t.substring(0, Math.max(0, maxTaskLen - 1)) + '…';
  }
  return t + suffix;
}

/**
 * Thread lifecycle manager bound to a collab dir + API client + forum channel.
 * Maintains `.claude/collab/bus-index/discord-threads.json` as the mapping of
 * session IDs to thread IDs. Rate-limit handling is entirely inside the API
 * client — these methods just surface success/failure to the caller.
 *
 * Callers are expected to respect serialization where it matters (e.g., the
 * bridge serializes thread-create through a single queue to avoid burst
 * 429s on forum-channel thread-create quota).
 */
function createThreads(collabDir, api, forumChannelId) {
  if (!collabDir) throw new Error('collabDir required');
  if (!api) throw new Error('api required');
  if (!forumChannelId) throw new Error('forumChannelId required');

  async function ensureThreadForSession(sessionId, task) {
    const idx = readIndex(collabDir);
    const existing = idx[sessionId];
    if (existing && existing.thread_id && !existing.archived_at) {
      return existing.thread_id;
    }

    const name = threadName(task, sessionId);
    const initialBody = '[wrightward] session ' + sessionId.substring(0, SHORT_ID_LEN) + ' started';
    const thread = await api.createForumThread(forumChannelId, name, initialBody);
    const threadId = thread && thread.id ? thread.id : null;
    if (!threadId) {
      throw new Error('createForumThread returned no id');
    }

    idx[sessionId] = { thread_id: threadId, archived_at: null, rendered_name: name };
    writeIndex(collabDir, idx);
    return threadId;
  }

  async function renameThread(sessionId, newTask) {
    const idx = readIndex(collabDir);
    const entry = idx[sessionId];
    if (!entry || !entry.thread_id) return null;
    if (entry.archived_at) return null;
    const name = threadName(newTask, sessionId);
    // Dedup against the last rendered name. Discord's channel PATCH bucket
    // is 2 per 10 minutes per channel — a no-op PATCH burns quota and can
    // 429-block the next real rename for up to 10 minutes. Two different
    // raw task strings can render to the same threadName after truncation
    // + shortId suffix, so comparing the rendered form (not the task) is
    // what actually prevents wasted calls.
    if (entry.rendered_name === name) return entry.thread_id;
    await api.editChannel(entry.thread_id, { name });
    entry.rendered_name = name;
    writeIndex(collabDir, idx);
    return entry.thread_id;
  }

  async function archiveThreadForSession(sessionId) {
    const idx = readIndex(collabDir);
    const entry = idx[sessionId];
    if (!entry || !entry.thread_id) return null;
    if (entry.archived_at) return entry.thread_id;

    try {
      await api.archiveThread(entry.thread_id);
    } catch (err) {
      // Idempotent: Discord may have auto-archived due to inactivity. Treat
      // 400 "already archived" and 404 "missing channel" as already-done.
      const body = err && err.body ? String(err.body) : '';
      const treatAsDone =
        err instanceof DiscordApiError &&
        (err.status === 404 || (err.status === 400 && /archiv/i.test(body)));
      if (!treatAsDone) throw err;
    }

    entry.archived_at = Date.now();
    writeIndex(collabDir, idx);
    return entry.thread_id;
  }

  function getThreadIdFor(sessionId) {
    const idx = readIndex(collabDir);
    return (idx[sessionId] && idx[sessionId].thread_id) || null;
  }

  function listSessions() {
    return Object.keys(readIndex(collabDir));
  }

  return {
    ensureThreadForSession,
    renameThread,
    archiveThread: archiveThreadForSession,
    getThreadIdFor,
    listSessions
  };
}

module.exports = { createThreads, indexPath, threadName, readIndex };
