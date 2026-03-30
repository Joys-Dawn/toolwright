'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { atomicWriteJson } = require('./atomic-write');

const AGENTS_FILE = 'agents.json';
const LOCK_STALE_MS = 5000;
const LOCK_MAX_ATTEMPTS = 20;
const LOCK_RETRY_MS = 50;
const SLEEP_BUFFER = new SharedArrayBuffer(4);
const SLEEP_VIEW = new Int32Array(SLEEP_BUFFER);

function agentsPath(collabDir) {
  return path.join(collabDir, AGENTS_FILE);
}

function lockPath(collabDir) {
  return agentsPath(collabDir) + '.lock';
}

/**
 * Executes fn while holding an exclusive lockfile on agents.json.
 * Throws if the lock cannot be acquired after max attempts.
 */
function withAgentsLock(collabDir, fn) {
  const lock = lockPath(collabDir);

  for (let attempt = 0; attempt < LOCK_MAX_ATTEMPTS; attempt++) {
    try {
      const fd = fs.openSync(lock, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY);
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
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
        Atomics.wait(SLEEP_VIEW, 0, 0, LOCK_RETRY_MS + Math.floor(Math.random() * LOCK_RETRY_MS));
        continue;
      }
      // Give up — fail loudly so the caller knows the lock was not acquired
      throw new Error('Failed to acquire agents.json lock after max attempts');
    }

    try {
      return fn();
    } finally {
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

function registerAgent(collabDir, sessionId) {
  withAgentsLock(collabDir, () => {
    const agents = readAgents(collabDir);
    const now = Date.now();
    agents[sessionId] = {
      registered_at: now,
      last_active: now
    };
    writeAgents(collabDir, agents);
  });
}

function updateHeartbeat(collabDir, sessionId) {
  withAgentsLock(collabDir, () => {
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
  });
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

module.exports = { withAgentsLock, readAgents, writeAgents, registerAgent, updateHeartbeat, removeAgent, getActiveAgents };
