'use strict';

const fs = require('fs');
const path = require('path');
const { atomicWriteJson } = require('./atomic-write');
const { sleepSync } = require('./sleep-sync');

const AGENTS_FILE = 'agents.json';
const LOCK_STALE_MS = 5000;
const LOCK_MAX_ATTEMPTS = 20;
const LOCK_RETRY_MS = 50;

// Token registry. Each withAgentsLock acquisition mints a fresh Symbol and
// records the resolved collabDir it authorizes. assertLockHeld(token, collabDir)
// compares them — tokens are unforgeable (Symbols are unique) so any lock-held
// function that accepts a token parameter is structurally impossible to call
// without first receiving one from withAgentsLock.
const ACTIVE_TOKENS = new Map();

function lockKey(collabDir) {
  return path.resolve(collabDir);
}

/**
 * Throws if `token` was not minted by a currently-active withAgentsLock
 * holding the lock for `collabDir`. Cheap Map lookup; always on.
 */
function assertLockHeld(token, collabDir) {
  if (typeof token !== 'symbol' || ACTIVE_TOKENS.get(token) !== lockKey(collabDir)) {
    throw new Error('agents-lock token missing or does not match collabDir: ' + collabDir);
  }
}

function agentsPath(collabDir) {
  return path.join(collabDir, AGENTS_FILE);
}

function lockPath(collabDir) {
  return agentsPath(collabDir) + '.lock';
}

/**
 * Executes fn while holding an exclusive lockfile on agents.json. Mints a
 * fresh Symbol token bound to this lock acquisition and passes it to fn as
 * the single argument. fn must forward that token to any bus-log / bus-query
 * / bus-delivery / interest-index function that runs inside the lock —
 * those functions call assertLockHeld(token, collabDir), which throws if
 * the token was not minted by the currently-active acquisition.
 *
 * Throws if the lock cannot be acquired after max attempts.
 */
function withAgentsLock(collabDir, fn) {
  const lock = lockPath(collabDir);
  const key = lockKey(collabDir);

  for (let attempt = 0; attempt < LOCK_MAX_ATTEMPTS; attempt++) {
    try {
      const fd = fs.openSync(lock, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY);
      // openSync already created the lockfile. If writeSync or closeSync
      // throws (EIO, disk full, EBADF), we must unlink it — otherwise it
      // sits on disk blocking every other caller for the full 5s stale
      // window while they spin through 20×50ms retries.
      try {
        fs.writeSync(fd, String(process.pid));
        fs.closeSync(fd);
      } catch (inner) {
        try { fs.unlinkSync(lock); } catch (_) {}
        throw inner;
      }
    } catch (e) {
      if (e.code !== 'EEXIST') {
        throw e;
      }
      // Lock exists — check if stale
      try {
        const stat = fs.statSync(lock);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          const stalePath = lock + '.stale-' + process.pid + '-' + Date.now();
          fs.renameSync(lock, stalePath);
          fs.unlinkSync(stalePath);
          continue; // retry immediately after clearing stale lock
        }
      } catch (_) {}

      if (attempt < LOCK_MAX_ATTEMPTS - 1) {
        sleepSync(LOCK_RETRY_MS + Math.floor(Math.random() * LOCK_RETRY_MS));
        continue;
      }
      // Give up — fail loudly so the caller knows the lock was not acquired
      throw new Error('Failed to acquire agents.json lock after max attempts');
    }

    const token = Symbol('agents-lock');
    ACTIVE_TOKENS.set(token, key);
    try {
      return fn(token);
    } finally {
      ACTIVE_TOKENS.delete(token);
      try { fs.unlinkSync(lock); } catch (_) {}
    }
  }
}

function readAgents(collabDir) {
  try {
    return JSON.parse(fs.readFileSync(agentsPath(collabDir), 'utf8'));
  } catch (e) {
    return {};
  }
}

function writeAgents(collabDir, agents) {
  atomicWriteJson(agentsPath(collabDir), agents);
}

/**
 * Writes a registration row for this session. Caller must hold withAgentsLock.
 * Preserves registered_at if the row already exists.
 */
function registerAgentInLock(collabDir, sessionId) {
  const agents = readAgents(collabDir);
  const now = Date.now();
  const existing = agents[sessionId] || {};
  agents[sessionId] = {
    ...existing,
    registered_at: existing.registered_at || now,
    last_active: now
  };
  writeAgents(collabDir, agents);
}

function registerAgent(collabDir, sessionId) {
  withAgentsLock(collabDir, () => {
    registerAgentInLock(collabDir, sessionId);
  });
}

function updateHeartbeatInLock(collabDir, sessionId) {
  const agents = readAgents(collabDir);
  if (agents[sessionId]) {
    agents[sessionId].last_active = Date.now();
  } else {
    agents[sessionId] = {
      registered_at: Date.now(),
      last_active: Date.now()
    };
  }
  writeAgents(collabDir, agents);
}

function updateHeartbeat(collabDir, sessionId) {
  withAgentsLock(collabDir, () => updateHeartbeatInLock(collabDir, sessionId));
}

function removeAgent(collabDir, sessionId) {
  withAgentsLock(collabDir, () => {
    const agents = readAgents(collabDir);
    delete agents[sessionId];
    writeAgents(collabDir, agents);
  });
}

function getActiveAgents(collabDir, maxAgeMs) {
  const agents = readAgents(collabDir);
  const cutoff = Date.now() - maxAgeMs;
  const active = {};
  for (const [id, data] of Object.entries(agents)) {
    if (data.last_active >= cutoff) {
      active[id] = data;
    }
  }
  return active;
}

module.exports = { withAgentsLock, assertLockHeld, readAgents, writeAgents, registerAgent, registerAgentInLock, updateHeartbeat, updateHeartbeatInLock, removeAgent, getActiveAgents };
