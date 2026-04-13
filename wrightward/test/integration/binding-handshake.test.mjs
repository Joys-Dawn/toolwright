import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { ensureCollabDir } = require('../../lib/collab-dir');

const REGISTER_HOOK = path.resolve(
  path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')),
  '../../hooks/register.js'
);

// Full handshake: register.js writes a ticket with <claudePid>-<hookPid>.json,
// session-bind.mjs scans for tickets whose filename begins with <claudePid>-
// and binds to the newest unclaimed match. Most unit tests stub one side or
// the other — this test wires both halves end-to-end to catch filename /
// scanner contract drift.

describe('integration: MCP binding handshake', () => {
  let tmpDir;
  let collabDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'binding-'));
    collabDir = ensureCollabDir(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('register.js writes ticket that session-bind picks up', async () => {
    // Drive register.js with the JSON shape Claude Code sends on SessionStart.
    execFileSync('node', [REGISTER_HOOK], {
      input: JSON.stringify({ session_id: 'sess-handshake', cwd: tmpDir }),
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    const bindingsDir = path.join(collabDir, 'mcp-bindings');
    const tickets = fs.readdirSync(bindingsDir);
    assert.equal(tickets.length, 1, 'register.js should write exactly one ticket');

    const file = tickets[0];
    // Filename contract: <claudePid>-<hookPid>.json — session-bind's scanner
    // keys off the <claudePid>- prefix to match by its own process.ppid.
    assert.match(file, /^\d+-\d+\.json$/, 'ticket filename must be <claudePid>-<hookPid>.json');

    const data = JSON.parse(fs.readFileSync(path.join(bindingsDir, file), 'utf8'));
    assert.equal(data.session_id, 'sess-handshake');
    assert.ok(data.created_at > 0);
    assert.ok(typeof data.hook_pid === 'number');
    assert.ok(typeof data.claude_pid === 'number');
    assert.equal(data.claimed, undefined, 'ticket must be unclaimed at handoff');
  });

  it('session-bind binds to a register.js-written ticket via fallback scan', async () => {
    // register.js writes a ticket under the hook's own ppid (the test process).
    // session-bind runs in *this* process, so its process.ppid is the shell,
    // not register.js's ppid. The fallback scan should still pick it up
    // because the ticket is within the 10s freshness window and unclaimed.
    execFileSync('node', [REGISTER_HOOK], {
      input: JSON.stringify({ session_id: 'sess-bound', cwd: tmpDir }),
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    const { createSessionBinder } = await import('../../mcp/session-bind.mjs?t=' + Date.now());
    const binder = createSessionBinder(collabDir);
    await binder.bind();

    assert.equal(binder.getSessionId(), 'sess-bound');
    assert.equal(binder.isBound(), true);

    // Ticket should now be marked claimed by the binder's pid.
    const bindingsDir = path.join(collabDir, 'mcp-bindings');
    const ticketFile = fs.readdirSync(bindingsDir)[0];
    const claimed = JSON.parse(fs.readFileSync(path.join(bindingsDir, ticketFile), 'utf8'));
    assert.equal(claimed.claimed, true);
    assert.equal(claimed.mcp_pid, process.pid);

    binder.cleanup();
  });

  it('two register.js calls in the same shell produce distinct tickets', async () => {
    // Simulates the Windows case: two Claude sessions share an intermediate
    // shell, so process.ppid collides. The hook adds its own pid to the
    // filename to avoid overwriting.
    execFileSync('node', [REGISTER_HOOK], {
      input: JSON.stringify({ session_id: 'sess-A', cwd: tmpDir }),
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    execFileSync('node', [REGISTER_HOOK], {
      input: JSON.stringify({ session_id: 'sess-B', cwd: tmpDir }),
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    const bindingsDir = path.join(collabDir, 'mcp-bindings');
    const tickets = fs.readdirSync(bindingsDir);
    assert.equal(tickets.length, 2, 'distinct hook pids must produce distinct ticket files');

    const sessionIds = tickets
      .map(f => JSON.parse(fs.readFileSync(path.join(bindingsDir, f), 'utf8')).session_id)
      .sort();
    assert.deepEqual(sessionIds, ['sess-A', 'sess-B']);
  });
});
