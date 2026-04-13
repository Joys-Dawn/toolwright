import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { ensureCollabDir } = require('../../lib/collab-dir');
const { atomicWriteJson } = require('../../lib/atomic-write');
const { ticketPath: buildTicketPath } = require('../../lib/mcp-ticket');

// We can't import session-bind directly because it depends on process.ppid
// which we can't mock. Instead, test the core logic by simulating the ticket flow.

describe('session-bind', () => {
  let tmpDir;
  let collabDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bind-test-'));
    collabDir = ensureCollabDir(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reads ticket written by hook', async () => {
    // Simulate what register.js does: write a ticket keyed by claudePid
    const fakePpid = '12345';
    const ticketPath = path.join(collabDir, 'mcp-bindings', fakePpid + '.json');
    atomicWriteJson(ticketPath, {
      session_id: 'test-sess-abc',
      created_at: Date.now(),
      hook_pid: 999
    });

    // Read it back (simulating what session-bind does)
    const data = JSON.parse(fs.readFileSync(ticketPath, 'utf8'));
    assert.equal(data.session_id, 'test-sess-abc');
    assert.ok(data.created_at > 0);
  });

  it('claim updates ticket with mcp_pid', () => {
    const fakePpid = '12345';
    const ticketPath = path.join(collabDir, 'mcp-bindings', fakePpid + '.json');
    atomicWriteJson(ticketPath, {
      session_id: 'test-sess-abc',
      created_at: Date.now(),
      hook_pid: 999
    });

    // Simulate claiming
    atomicWriteJson(ticketPath, {
      session_id: 'test-sess-abc',
      created_at: Date.now(),
      claimed: true,
      mcp_pid: 5678
    });

    const data = JSON.parse(fs.readFileSync(ticketPath, 'utf8'));
    assert.equal(data.claimed, true);
    assert.equal(data.mcp_pid, 5678);
  });

  it('two tickets for different ppids do not collide', () => {
    const ticket1 = path.join(collabDir, 'mcp-bindings', '111.json');
    const ticket2 = path.join(collabDir, 'mcp-bindings', '222.json');

    atomicWriteJson(ticket1, { session_id: 'sess-A', created_at: Date.now(), hook_pid: 1 });
    atomicWriteJson(ticket2, { session_id: 'sess-B', created_at: Date.now(), hook_pid: 2 });

    const data1 = JSON.parse(fs.readFileSync(ticket1, 'utf8'));
    const data2 = JSON.parse(fs.readFileSync(ticket2, 'utf8'));
    assert.equal(data1.session_id, 'sess-A');
    assert.equal(data2.session_id, 'sess-B');
  });

  it('session resume overwrites ticket with new session_id', () => {
    const fakePpid = '12345';
    const ticketPath = path.join(collabDir, 'mcp-bindings', fakePpid + '.json');

    // First session
    atomicWriteJson(ticketPath, { session_id: 'sess-old', created_at: Date.now(), hook_pid: 1 });

    // Resume with new session
    atomicWriteJson(ticketPath, { session_id: 'sess-new', created_at: Date.now(), hook_pid: 2 });

    const data = JSON.parse(fs.readFileSync(ticketPath, 'utf8'));
    assert.equal(data.session_id, 'sess-new');
  });

  it('returns empty when no ticket exists', () => {
    const fakePpid = '99999';
    const ticketPath = path.join(collabDir, 'mcp-bindings', fakePpid + '.json');
    let sessionId = null;
    try {
      const data = JSON.parse(fs.readFileSync(ticketPath, 'utf8'));
      sessionId = data.session_id;
    } catch (_) {
      sessionId = null;
    }
    assert.equal(sessionId, null);
  });

  it('createSessionBinder binds when ticket pre-exists', async () => {
    // Write ticket before importing binder. Filename must match the
    // <claudePid>-<hookPid>.json format produced by register.js so the
    // primary tryClaimByPpid prefix matcher picks it up (rather than falling
    // through to the fallback scan).
    const ppid = process.ppid;
    const ticketPath = buildTicketPath(collabDir, ppid, 1);
    atomicWriteJson(ticketPath, {
      session_id: 'pre-existing-sess',
      created_at: Date.now(),
      hook_pid: 1
    });

    const { createSessionBinder } = await import('../../mcp/session-bind.mjs');
    const binder = createSessionBinder(collabDir);
    await binder.bind();
    assert.equal(binder.getSessionId(), 'pre-existing-sess');
    assert.equal(binder.isBound(), true);
    binder.cleanup();
  });

  it('createSessionBinder enters unbound mode when no ticket', async () => {
    const { createSessionBinder } = await import('../../mcp/session-bind.mjs?t=' + Date.now());
    const binder = createSessionBinder(collabDir);

    // This will poll for 5s and timeout
    await binder.bind();
    assert.equal(binder.getSessionId(), null);
    assert.equal(binder.isBound(), false);
    binder.cleanup();
  }, { timeout: 10000 });

  it('refreshBinding detects session resume (session_id change)', async () => {
    const ppid = process.ppid;
    const ticketPath = buildTicketPath(collabDir, ppid, 1);

    // Initial session
    atomicWriteJson(ticketPath, { session_id: 'sess-original', created_at: Date.now(), hook_pid: 1 });

    const { createSessionBinder } = await import('../../mcp/session-bind.mjs?t=' + Date.now());
    const binder = createSessionBinder(collabDir);
    await binder.bind();
    assert.equal(binder.getSessionId(), 'sess-original');

    // Session resumed — ticket overwritten
    atomicWriteJson(ticketPath, { session_id: 'sess-resumed', created_at: Date.now(), hook_pid: 2 });

    binder.refreshBinding();
    assert.equal(binder.getSessionId(), 'sess-resumed');

    binder.cleanup();
  });

  it('refreshBinding is no-op when session_id unchanged', async () => {
    const ppid = process.ppid;
    const ticketPath = buildTicketPath(collabDir, ppid, 1);
    atomicWriteJson(ticketPath, { session_id: 'sess-stable', created_at: Date.now(), hook_pid: 1 });

    const { createSessionBinder } = await import('../../mcp/session-bind.mjs?t=' + Date.now());
    const binder = createSessionBinder(collabDir);
    await binder.bind();

    // Refresh multiple times — should stay at same sessionId
    binder.refreshBinding();
    binder.refreshBinding();
    assert.equal(binder.getSessionId(), 'sess-stable');

    binder.cleanup();
  });

  it('refreshBinding drops binding when ticket disappears', async () => {
    const ppid = process.ppid;
    const ticketPath = buildTicketPath(collabDir, ppid, 1);
    atomicWriteJson(ticketPath, { session_id: 'sess-x', created_at: Date.now(), hook_pid: 1 });

    const { createSessionBinder } = await import('../../mcp/session-bind.mjs?t=' + Date.now());
    const binder = createSessionBinder(collabDir);
    await binder.bind();
    assert.equal(binder.getSessionId(), 'sess-x');

    // Ticket deleted (cleanup.js ran or the session died) — the binder must
    // stop reporting a stale session so tools return an honest "unbound" error.
    fs.unlinkSync(ticketPath);
    assert.doesNotThrow(() => binder.refreshBinding());
    assert.equal(binder.getSessionId(), null);
    assert.equal(binder.isBound(), false);

    binder.cleanup();
  });

  it('cleanup() does not throw when no retry timer is active', async () => {
    const ppid = process.ppid;
    const ticketPath = buildTicketPath(collabDir, ppid, 1);
    atomicWriteJson(ticketPath, { session_id: 'sess-bound', created_at: Date.now(), hook_pid: 1 });

    const { createSessionBinder } = await import('../../mcp/session-bind.mjs?t=' + Date.now());
    const binder = createSessionBinder(collabDir);
    await binder.bind();

    // Called after successful bind (no retry timer active)
    assert.doesNotThrow(() => binder.cleanup());
  });

  it('fallback scan binds to unclaimed recent ticket when ppid does not match', async () => {
    // Simulate Windows intermediate-shell case: ticket is under a DIFFERENT pid
    const fakeClaudePid = '999999';  // Not equal to process.ppid
    const ticketPath = path.join(collabDir, 'mcp-bindings', fakeClaudePid + '.json');
    atomicWriteJson(ticketPath, {
      session_id: 'sess-fallback',
      created_at: Date.now(),  // Recent (within 10s)
      hook_pid: 1
    });

    const { createSessionBinder } = await import('../../mcp/session-bind.mjs?t=' + Date.now());
    const binder = createSessionBinder(collabDir);
    await binder.bind();

    assert.equal(binder.getSessionId(), 'sess-fallback');
    binder.cleanup();
  }, { timeout: 10000 });

  it('fallback scan ignores old tickets (>10s)', async () => {
    const fakeClaudePid = '999998';
    const ticketPath = path.join(collabDir, 'mcp-bindings', fakeClaudePid + '.json');
    atomicWriteJson(ticketPath, {
      session_id: 'sess-stale',
      created_at: Date.now() - 20000,  // 20s old — too old
      hook_pid: 1
    });

    const { createSessionBinder } = await import('../../mcp/session-bind.mjs?t=' + Date.now());
    const binder = createSessionBinder(collabDir);
    await binder.bind();

    assert.equal(binder.getSessionId(), null, 'Should not bind to stale ticket');
    binder.cleanup();
  }, { timeout: 10000 });

  it('fallback scan refuses to bind when >1 candidate ticket exists', async () => {
    // Two unclaimed tickets for non-matching ppids within the 10s freshness
    // window: requireUnique must refuse to guess which one belongs to this
    // MCP server rather than silently misroute to the wrong session.
    const ticket1 = path.join(collabDir, 'mcp-bindings', '999901.json');
    const ticket2 = path.join(collabDir, 'mcp-bindings', '999902.json');
    atomicWriteJson(ticket1, { session_id: 'sess-A', created_at: Date.now(), hook_pid: 1 });
    atomicWriteJson(ticket2, { session_id: 'sess-B', created_at: Date.now(), hook_pid: 2 });

    const { createSessionBinder } = await import('../../mcp/session-bind.mjs?t=' + Date.now());
    const binder = createSessionBinder(collabDir);
    await binder.bind();

    assert.equal(binder.getSessionId(), null, 'Must stay unbound when candidates are ambiguous');
    assert.equal(binder.isBound(), false);
    binder.cleanup();
  }, { timeout: 10000 });
});
