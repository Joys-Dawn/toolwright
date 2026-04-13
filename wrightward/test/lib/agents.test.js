'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { readAgents, registerAgent, updateHeartbeat, removeAgent, getActiveAgents, withAgentsLock, assertLockHeld } = require('../../lib/agents');
const { append } = require('../../lib/bus-log');
const { createEvent } = require('../../lib/bus-schema');

describe('agents', () => {
  let collabDir;

  beforeEach(() => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collab-test-'));
    collabDir = path.join(tmpDir, '.claude', 'collab');
    fs.mkdirSync(collabDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(path.dirname(collabDir), { recursive: true, force: true });
  });

  describe('readAgents', () => {
    it('returns empty object when file missing', () => {
      assert.deepEqual(readAgents(collabDir), {});
    });

    it('returns parsed agents when file exists', () => {
      const data = { 'sess-1': { registered_at: 100, last_active: 200 } };
      fs.writeFileSync(path.join(collabDir, 'agents.json'), JSON.stringify(data), 'utf8');
      assert.deepEqual(readAgents(collabDir), data);
    });
  });

  describe('registerAgent', () => {
    it('adds agent with timestamps', () => {
      registerAgent(collabDir, 'sess-1');
      const agents = readAgents(collabDir);
      assert.ok(agents['sess-1']);
      assert.ok(agents['sess-1'].registered_at > 0);
      assert.ok(agents['sess-1'].last_active > 0);
    });

    it('can register multiple agents', () => {
      registerAgent(collabDir, 'sess-1');
      registerAgent(collabDir, 'sess-2');
      const agents = readAgents(collabDir);
      assert.ok(agents['sess-1']);
      assert.ok(agents['sess-2']);
    });
  });

  describe('updateHeartbeat', () => {
    it('updates last_active for existing agent', () => {
      registerAgent(collabDir, 'sess-1');
      const before = readAgents(collabDir)['sess-1'].last_active;
      // Small delay to ensure timestamp changes
      const start = Date.now();
      while (Date.now() === start) {} // busy wait 1ms
      updateHeartbeat(collabDir, 'sess-1');
      const after = readAgents(collabDir)['sess-1'].last_active;
      assert.ok(after >= before);
    });

    it('auto-registers unknown agent on heartbeat', () => {
      updateHeartbeat(collabDir, 'new-sess');
      const agents = readAgents(collabDir);
      assert.ok(agents['new-sess']);
    });
  });

  describe('removeAgent', () => {
    it('removes agent from agents.json', () => {
      registerAgent(collabDir, 'sess-1');
      registerAgent(collabDir, 'sess-2');
      removeAgent(collabDir, 'sess-1');
      const agents = readAgents(collabDir);
      assert.equal(agents['sess-1'], undefined);
      assert.ok(agents['sess-2']);
    });
  });

  describe('getActiveAgents', () => {
    it('returns agents within maxAge', () => {
      registerAgent(collabDir, 'sess-1');
      const active = getActiveAgents(collabDir, 60000);
      assert.ok(active['sess-1']);
    });

    it('excludes stale agents', () => {
      const agents = {
        'sess-1': { registered_at: 100, last_active: Date.now() - 700000 } // 11+ min ago
      };
      fs.writeFileSync(path.join(collabDir, 'agents.json'), JSON.stringify(agents), 'utf8');
      const active = getActiveAgents(collabDir, 600000); // 10 min
      assert.equal(Object.keys(active).length, 0);
    });
  });

  describe('lockToken / assertLockHeld', () => {
    it('withAgentsLock passes a Symbol token to the callback', () => {
      let received;
      withAgentsLock(collabDir, (token) => { received = token; });
      assert.equal(typeof received, 'symbol');
    });

    it('assertLockHeld passes with the current token, fails otherwise', () => {
      withAgentsLock(collabDir, (token) => {
        assert.doesNotThrow(() => assertLockHeld(token, collabDir));
      });
    });

    it('assertLockHeld throws outside withAgentsLock even if a stale token is held', () => {
      let staleToken;
      withAgentsLock(collabDir, (token) => { staleToken = token; });
      // After withAgentsLock returns the token is unregistered — reuse must fail.
      assert.throws(() => assertLockHeld(staleToken, collabDir), /agents-lock token/);
    });

    it('assertLockHeld throws when token is missing or wrong type', () => {
      withAgentsLock(collabDir, () => {
        assert.throws(() => assertLockHeld(undefined, collabDir), /agents-lock token/);
        assert.throws(() => assertLockHeld('not-a-symbol', collabDir), /agents-lock token/);
      });
    });

    it('a token minted for one collabDir does not authorize another', () => {
      const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'collab-test-other-'));
      const other = path.join(tmp2, '.claude', 'collab');
      fs.mkdirSync(other, { recursive: true });
      try {
        withAgentsLock(collabDir, (token) => {
          assert.throws(() => assertLockHeld(token, other), /agents-lock token/);
        });
      } finally {
        fs.rmSync(tmp2, { recursive: true, force: true });
      }
    });

    it('token release survives callback throwing (finally runs)', () => {
      let savedToken;
      assert.throws(() => {
        withAgentsLock(collabDir, (token) => { savedToken = token; throw new Error('boom'); });
      }, /boom/);
      assert.throws(() => assertLockHeld(savedToken, collabDir), /agents-lock token/);
    });
  });

  describe('lockfile cleanup on partial-acquire failure', () => {
    it('unlinks the lockfile and does not block subsequent callers when writeSync throws', () => {
      const lockPath = path.join(collabDir, 'agents.json.lock');
      const realWriteSync = fs.writeSync;
      let calls = 0;
      // Throw exactly once on the next writeSync (the lock-write path). A
      // real EIO / ENOSPC would look the same from the caller's perspective.
      fs.writeSync = function patched(...args) {
        calls++;
        if (calls === 1) {
          const err = new Error('simulated EIO');
          err.code = 'EIO';
          throw err;
        }
        return realWriteSync.apply(this, args);
      };

      try {
        assert.throws(() => withAgentsLock(collabDir, () => {}), /simulated EIO/);
        assert.equal(fs.existsSync(lockPath), false, 'lockfile must not remain on disk after partial-acquire failure');
      } finally {
        fs.writeSync = realWriteSync;
      }

      // The next acquisition must proceed immediately — no 5s stale wait.
      const start = Date.now();
      withAgentsLock(collabDir, () => {});
      const elapsed = Date.now() - start;
      assert.ok(elapsed < 500, 'next withAgentsLock should be fast, took ' + elapsed + 'ms');
    });
  });

  describe('assertLockHeld integration (via bus-log.append)', () => {
    it('bus-log.append throws when called without a valid token', () => {
      const event = createEvent('sess-1', 'all', 'note', 'x');
      assert.throws(() => append(undefined, collabDir, event), /agents-lock token/);
    });

    it('bus-log.append succeeds when passed the token from withAgentsLock', () => {
      const event = createEvent('sess-1', 'all', 'note', 'x');
      assert.doesNotThrow(() => {
        withAgentsLock(collabDir, (token) => {
          append(token, collabDir, event);
        });
      });
    });
  });
});
