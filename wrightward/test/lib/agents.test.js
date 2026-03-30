'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { readAgents, registerAgent, updateHeartbeat, removeAgent, getActiveAgents } = require('../../lib/agents');

describe('agents', () => {
  let collabDir;

  beforeEach(() => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collab-test-'));
    collabDir = path.join(tmpDir, '.collab');
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
});
