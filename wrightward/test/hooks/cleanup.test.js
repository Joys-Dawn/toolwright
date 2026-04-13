'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { ensureCollabDir } = require('../../lib/collab-dir');
const { registerAgent, readAgents } = require('../../lib/agents');
const { writeContext, readContext } = require('../../lib/context');
const { setContextHash, getContextHash } = require('../../lib/context-hash');
const { withAgentsLock } = require('../../lib/agents');
const { append, busPath } = require('../../lib/bus-log');
const { createEvent } = require('../../lib/bus-schema');
const interestIndex = require('../../lib/interest-index');
const { atomicWriteJson } = require('../../lib/atomic-write');

const HOOK = path.resolve(__dirname, '../../hooks/cleanup.js');

function runHook(input) {
  return execFileSync('node', [HOOK], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    timeout: 5000
  });
}

describe('cleanup hook', () => {
  let tmpDir;
  let collabDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collab-test-'));
    collabDir = ensureCollabDir(tmpDir);
    registerAgent(collabDir, 'sess-1');
    writeContext(collabDir, 'sess-1', { task: 'test', status: 'in-progress' });
    setContextHash(collabDir, 'sess-1', 'abc');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('removes context, context-hash, and agent entry', () => {
    runHook({ session_id: 'sess-1', cwd: tmpDir });

    assert.equal(readContext(collabDir, 'sess-1'), null);
    assert.equal(getContextHash(collabDir, 'sess-1'), null);
    assert.equal(readAgents(collabDir)['sess-1'], undefined);
  });

  it('does not affect other agents', () => {
    registerAgent(collabDir, 'sess-2');
    writeContext(collabDir, 'sess-2', { task: 'other', status: 'in-progress' });

    runHook({ session_id: 'sess-1', cwd: tmpDir });

    assert.ok(readAgents(collabDir)['sess-2']);
    assert.deepEqual(readContext(collabDir, 'sess-2'), { task: 'other', status: 'in-progress' });
  });

  it('exits cleanly when .claude/collab does not exist', () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collab-empty-'));
    try {
      runHook({ session_id: 'sess-1', cwd: emptyDir });
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  // Bus-specific tests
  it('appends session_ended event to bus.jsonl', () => {
    runHook({ session_id: 'sess-1', cwd: tmpDir });
    const busFile = busPath(collabDir);
    assert.ok(fs.existsSync(busFile));
    const lines = fs.readFileSync(busFile, 'utf8').trim().split('\n');
    // May have file_freed events first, session_ended at the end
    const sessionEnded = lines.map(l => JSON.parse(l)).find(e => e.type === 'session_ended');
    assert.ok(sessionEnded, 'Expected session_ended event');
    assert.equal(sessionEnded.from, 'sess-1');
    assert.equal(sessionEnded.to, 'all');
  });

  it('removes interest index entries for the session', () => {
    // Pre-populate interest index
    withAgentsLock(collabDir, (token) => {
      interestIndex.upsert(token, collabDir, 'src/auth.ts', {
        sessionId: 'sess-1', busEventId: 'e1', declaredAt: Date.now(), expiresAt: null
      });
      interestIndex.upsert(token, collabDir, 'src/auth.ts', {
        sessionId: 'sess-2', busEventId: 'e2', declaredAt: Date.now(), expiresAt: null
      });
    });

    runHook({ session_id: 'sess-1', cwd: tmpDir });

    const idx = interestIndex.read(collabDir);
    // sess-1 entries should be gone, sess-2 should remain
    const entries = idx['src/auth.ts'] || [];
    assert.ok(!entries.some(e => e.sessionId === 'sess-1'));
    assert.ok(entries.some(e => e.sessionId === 'sess-2'));
  });

  it('emits file_freed for interested agents when session held files', () => {
    // sess-1 holds auth.ts, sess-2 is interested in it
    writeContext(collabDir, 'sess-1', {
      task: 'test',
      files: [{ path: 'auth.ts', prefix: '~', source: 'planned', declaredAt: Date.now(), lastTouched: Date.now(), reminded: false }],
      status: 'in-progress'
    });
    registerAgent(collabDir, 'sess-2');
    withAgentsLock(collabDir, (token) => {
      interestIndex.upsert(token, collabDir, 'auth.ts', {
        sessionId: 'sess-2', busEventId: 'e1', declaredAt: Date.now(), expiresAt: null
      });
    });

    runHook({ session_id: 'sess-1', cwd: tmpDir });

    const busFile = busPath(collabDir);
    const events = fs.readFileSync(busFile, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    const fileFreed = events.find(e => e.type === 'file_freed' && e.meta.file === 'auth.ts');
    assert.ok(fileFreed, 'Expected file_freed event for auth.ts');
    assert.equal(fileFreed.to, 'sess-2');
  });

  it('deletes MCP binding ticket for the session', () => {
    // Pre-create a binding ticket
    const ticketPath = path.join(collabDir, 'mcp-bindings', '12345.json');
    atomicWriteJson(ticketPath, { session_id: 'sess-1', created_at: Date.now(), hook_pid: 1 });

    runHook({ session_id: 'sess-1', cwd: tmpDir });

    assert.ok(!fs.existsSync(ticketPath));
  });

  it('does not delete binding tickets for other sessions', () => {
    const ticketPath = path.join(collabDir, 'mcp-bindings', '99999.json');
    atomicWriteJson(ticketPath, { session_id: 'sess-other', created_at: Date.now(), hook_pid: 2 });

    runHook({ session_id: 'sess-1', cwd: tmpDir });

    assert.ok(fs.existsSync(ticketPath));
  });

  it('does not append session_ended when BUS_ENABLED is false', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.claude', 'wrightward.json'),
      JSON.stringify({ BUS_ENABLED: false })
    );
    runHook({ session_id: 'sess-1', cwd: tmpDir });

    const busFile = busPath(collabDir);
    if (fs.existsSync(busFile)) {
      const content = fs.readFileSync(busFile, 'utf8').trim();
      const events = content ? content.split('\n').map(l => JSON.parse(l)) : [];
      const sessionEnded = events.find(e => e.type === 'session_ended');
      assert.equal(sessionEnded, undefined, 'session_ended must not be appended when BUS_ENABLED=false');
    }
  });

  it('still deletes MCP binding ticket when BUS_ENABLED is false', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.claude', 'wrightward.json'),
      JSON.stringify({ BUS_ENABLED: false })
    );
    const ticketPath = path.join(collabDir, 'mcp-bindings', '55555.json');
    atomicWriteJson(ticketPath, { session_id: 'sess-1', created_at: Date.now(), hook_pid: 3 });

    runHook({ session_id: 'sess-1', cwd: tmpDir });

    assert.ok(!fs.existsSync(ticketPath), 'binding ticket cleanup must run unconditionally');
  });
});
