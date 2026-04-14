import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { spawnSync } from 'child_process';

const require = createRequire(import.meta.url);
const { ensureCollabDir } = require('../../lib/collab-dir');
const { atomicWriteJson } = require('../../lib/atomic-write');
const { withAgentsLock, registerAgent } = require('../../lib/agents');
const { append } = require('../../lib/bus-log');
const { createEvent } = require('../../lib/bus-schema');

const SERVER_PATH = path.resolve(
  path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')),
  '../../mcp/server.mjs'
);

// End-to-end handshake: spawn mcp/server.mjs and drive it via the real MCP
// client over stdio. test/mcp/tools.test.mjs bypasses setRequestHandler by
// calling handleToolCall directly — this test is the only coverage of the
// registration + JSON-RPC wire layer. Without it, a string-vs-Zod schema
// regression in setRequestHandler goes unnoticed.

describe('integration: MCP server handshake', () => {
  let tmpDir;
  let collabDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-handshake-'));
    collabDir = ensureCollabDir(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function connectClient(extraEnv) {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [SERVER_PATH],
      cwd: tmpDir,
      env: { ...process.env, ...(extraEnv || {}) }
    });
    const client = new Client({ name: 'handshake-test', version: '1.0.0' }, { capabilities: {} });
    await client.connect(transport);
    return { client, transport };
  }

  it('completes initialize + tools/list within the handshake window', async () => {
    // Seed a binding ticket so the background binder succeeds (the handshake
    // itself must NOT depend on binding — we just want tools/list to work).
    const ticketPath = path.join(collabDir, 'mcp-bindings', '0-0.json');
    atomicWriteJson(ticketPath, {
      session_id: 'sess-handshake',
      created_at: Date.now(),
      hook_pid: 0,
      claude_pid: 0
    });

    const start = Date.now();
    const { client, transport } = await connectClient();
    const elapsed = Date.now() - start;
    // Handshake must return well under the 5s binder poll window — if the
    // binder blocked connect, this would be ≥5000ms on a clean tmp dir.
    assert.ok(elapsed < 2000, 'handshake took ' + elapsed + 'ms (should be <2000)');

    const result = await client.listTools();
    assert.ok(Array.isArray(result.tools), 'tools/list should return an array');
    assert.equal(result.tools.length, 6, 'expected 6 tools');
    const names = result.tools.map(t => t.name).sort();
    assert.deepEqual(names, [
      'wrightward_ack',
      'wrightward_bus_status',
      'wrightward_list_inbox',
      'wrightward_send_handoff',
      'wrightward_send_note',
      'wrightward_watch_file'
    ]);

    // Phase 2: the experimental `claude/channel` capability must be advertised
    // so conforming MCP clients know the server can emit notifications/claude/channel.
    // Silent removal would leave notifications being sent but ignored by clients.
    const caps = client.getServerCapabilities();
    assert.ok(caps, 'server must advertise capabilities');
    assert.ok(caps.experimental, 'server must advertise experimental capabilities');
    assert.ok(caps.experimental['claude/channel'],
      'server must advertise experimental.claude/channel capability — clients need this to honor channel notifications');

    await client.close();
    await transport.close();
  });

  it('handshake succeeds even when no binding ticket is ever written', async () => {
    // Binder will enter unbound mode (5s poll timeout); handshake must not wait.
    const start = Date.now();
    const { client, transport } = await connectClient();
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 2000, 'handshake took ' + elapsed + 'ms (should be <2000)');

    const result = await client.listTools();
    assert.equal(result.tools.length, 6);

    await client.close();
    await transport.close();
  });

  it('exits 1 with no-collab-found stderr when spawned outside any .claude/collab ancestor', () => {
    // Use a dir directly under the fs root so walk-up terminates immediately.
    // A tmpdir wouldn't work on dev machines where a global ~/.claude/collab
    // sits on the walk-up path (resolveCollabDir would happily find it).
    const { root: fsRoot } = path.parse(tmpDir);
    const isolated = path.join(fsRoot, '__mcp_nocollab_' + process.pid);
    fs.mkdirSync(isolated, { recursive: true });
    try {
      const res = spawnSync(process.execPath, [SERVER_PATH], {
        cwd: isolated,
        encoding: 'utf8',
        timeout: 5000
      });
      assert.equal(res.status, 1, 'expected exit code 1, got ' + res.status + ' stderr=' + res.stderr);
      assert.match(res.stderr, /no \.claude\/collab found/);
    } finally {
      fs.rmSync(isolated, { recursive: true, force: true });
    }
  });

  it('exits 0 with shutdown stderr when BUS_ENABLED=false', () => {
    // Tmp dir already has .claude/collab from beforeEach; add wrightward.json with BUS_ENABLED=false.
    atomicWriteJson(path.join(tmpDir, '.claude', 'wrightward.json'), { BUS_ENABLED: false });

    const res = spawnSync(process.execPath, [SERVER_PATH], {
      cwd: tmpDir,
      encoding: 'utf8',
      timeout: 5000
    });
    assert.equal(res.status, 0, 'expected exit code 0, got ' + res.status + ' stderr=' + res.stderr);
    assert.match(res.stderr, /BUS_ENABLED=false, shutting down/);
  });

  it('emits notifications/claude/channel when an urgent event is appended to bus.jsonl', async () => {
    // End-to-end coverage of the Phase 2 doorbell wire-up:
    //   file-watcher (bus.jsonl) → binder.getSessionId() → ring() → server.notification
    // Unit tests cover each module in isolation; this test pins the composition.
    //
    // Binding: seed a ticket with claude_pid = this test's pid so the server's
    // ppid (which is our pid) matches on the first poll (tryClaimByPpid).
    const sessionId = 'sess-doorbell-e2e';
    const ticketPath = path.join(collabDir, 'mcp-bindings', `${process.pid}-0.json`);
    atomicWriteJson(ticketPath, {
      session_id: sessionId,
      created_at: Date.now(),
      hook_pid: 0,
      claude_pid: process.pid
    });
    registerAgent(collabDir, sessionId);
    registerAgent(collabDir, 'sess-doorbell-sender');

    const received = [];
    const { client, transport } = await connectClient();
    client.fallbackNotificationHandler = async (n) => {
      received.push(n);
    };

    // Give the server a beat to finish binding and start the watcher.
    await new Promise((r) => setTimeout(r, 250));

    // Append an urgent handoff event to bus.jsonl. The server's watcher should
    // pick this up within one poll interval (default 1000ms) + 50ms debounce.
    withAgentsLock(collabDir, (token) => {
      append(token, collabDir, createEvent('sess-doorbell-sender', sessionId, 'handoff', 'integration-test handoff'));
    });

    // Wait long enough to cover: poll interval (1s) + debounce (50ms) + ring
    // (lock, read, notify) + notification roundtrip. 2500ms is generous.
    const deadline = Date.now() + 2500;
    while (Date.now() < deadline && !received.some(n => n.method === 'notifications/claude/channel')) {
      await new Promise((r) => setTimeout(r, 100));
    }

    const channelNotifs = received.filter(n => n.method === 'notifications/claude/channel');
    assert.equal(channelNotifs.length, 1,
      'expected exactly one channel notification, got ' + channelNotifs.length +
      ' (all received: ' + JSON.stringify(received.map(n => n.method)) + ')');
    const params = channelNotifs[0].params;
    assert.equal(typeof params.content, 'string');
    assert.match(params.content, /1 new wrightward bus event/,
      'content should describe 1 new event, got: ' + params.content);
    assert.equal(params.meta.source, 'wrightward-bus');
    assert.equal(params.meta.pending_count, '1');

    await client.close();
    await transport.close();
  });
});
