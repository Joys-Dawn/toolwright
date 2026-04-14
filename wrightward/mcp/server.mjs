#!/usr/bin/env node
/**
 * wrightward MCP server — spawned by Claude Code per session via plugin.json.
 *
 * Phase 2: tools + experimental claude/channel for between-turn doorbell
 * notifications. The bundled file watcher fires the channel doorbell when
 * bus.jsonl changes; see mcp/file-watcher.mjs and mcp/channel-doorbell.mjs.
 * The doorbell writes no state — Path 1 (hooks) remains the sole deliverer
 * of event content, so dropped notifications degrade gracefully.
 */

import path from 'path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createRequire } from 'module';
import { createSessionBinder } from './session-bind.mjs';
import { getToolDefinitions, handleToolCall } from './tools.mjs';
import { createWatcher } from './file-watcher.mjs';
import { ring } from './channel-doorbell.mjs';
import { createBridgeOrchestrator } from '../broker/bridge-orchestrator.mjs';

const require = createRequire(import.meta.url);
const { resolveCollabDir } = require('../lib/collab-dir');
const { loadConfig } = require('../lib/config');
const { resolveBotToken } = require('../lib/discord-token');

async function main() {
  // Resolve project root by walking up from cwd
  const resolved = resolveCollabDir(process.cwd());
  if (!resolved) {
    process.stderr.write('[wrightward-mcp] no .claude/collab found — MCP server has no project context\n');
    process.exit(1);
  }
  const { root, collabDir } = resolved;
  const config = loadConfig(root);

  // plugin.json declares the MCP server unconditionally, so Claude spawns it
  // every session. When BUS_ENABLED=false, register.js skips ticket writes,
  // which would strand this server in unbound mode and return errors for every
  // wrightward_* tool call. Exit cleanly instead.
  if (!config.BUS_ENABLED) {
    process.stderr.write('[wrightward-mcp] BUS_ENABLED=false, shutting down\n');
    process.exit(0);
  }

  // Create MCP server
  const server = new Server(
    { name: 'wrightward-bus', version: '3.3.0' },
    {
      capabilities: {
        tools: {},
        experimental: { 'claude/channel': {} }
      },
      instructions:
        'wrightward-bus: peer-to-peer messaging between Claude Code sessions in the same repo.\n' +
        'Urgent events arrive in two ways: (1) as a <channel source="wrightward-bus" pending_count="N"> wake-up ping between turns, and (2) as additionalContext injected on your next tool call. Both are signals to call wrightward_list_inbox and surface the pending events.\n' +
        'Tools: wrightward_list_inbox (list and mark-delivered urgent events), wrightward_ack (acknowledge a handoff decision), wrightward_send_note (non-urgent info for another session), wrightward_send_handoff (give work to another session, optionally releasing files), wrightward_watch_file (register interest — you will be notified when the file frees up), wrightward_bus_status (diagnostic).\n' +
        'Never edit files under .claude/collab/ — they are managed by this plugin; the guard hook will block such edits unconditionally.'
    }
  );

  const binder = createSessionBinder(collabDir);

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: getToolDefinitions() };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    // Re-read binding ticket on every tool call (resume detection)
    binder.refreshBinding();

    return handleToolCall(name, args || {}, collabDir, binder.getSessionId(), config, root);
  });

  // Connect transport FIRST so MCP handshake completes within the client's
  // deadline (typically ≤5s). Binding can take up to POLL_TIMEOUT_MS (5s) to
  // find a SessionStart ticket; awaiting it before connect would stall the
  // handshake. Tools called before bind completes return a clean
  // "not bound to a session" error (tools.mjs handleToolCall guards sessionId).
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('[wrightward-mcp] server running on stdio\n');

  // Kick off session binding in the background. Any failure degrades to
  // unbound mode; tool calls return an error until a ticket is claimed or
  // the retry timer gives up (session-bind.RETRY_MAX_ATTEMPTS).
  binder.bind().catch(err => {
    process.stderr.write('[wrightward-mcp] bind failed: ' + (err.stack || err.message || err) + '\n');
  });

  // Phase 2 channel doorbell: watch bus.jsonl between turns and wake the
  // idle session when urgent events are pending. Path 2 writes no state —
  // Path 1 (hooks) remains the sole deliverer of event content. If binder
  // hasn't bound yet, the callback no-ops; session resume is handled by
  // re-reading the binder on every fire.
  const watcher = createWatcher(path.join(collabDir, 'bus.jsonl'), () => {
    const sid = binder.getSessionId();
    if (!sid) return;
    ring(server, collabDir, sid).catch(() => {}); // errors already logged inside ring()
  });
  watcher.start();
  process.stderr.write('[wrightward-mcp] channel doorbell watcher started\n');

  // Phase 3 Discord bridge: spawn the bridge child if discord is ENABLED and
  // the bot token is available. Respects the persistent circuit breaker and
  // the single-owner lockfile. If another MCP already owns the bridge, we
  // simply observe. Heartbeat retakes an orphaned lock within ~5s.
  const bridgeOrchestrator = createBridgeOrchestrator(collabDir, () => ({
    sessionId: binder.getSessionId(),
    cwd: root,
    discordEnabled: Boolean(config.discord && config.discord.ENABLED),
    busEnabled: config.BUS_ENABLED,
    botToken: resolveBotToken()
  }));
  bridgeOrchestrator.start();

  // Graceful shutdown
  process.on('SIGTERM', () => {
    process.stderr.write('[wrightward-mcp] SIGTERM received, shutting down\n');
    try { bridgeOrchestrator.shutdown(); } catch (_) {}
    watcher.close();
    binder.cleanup();
    process.exit(0);
  });
}

main().catch(err => {
  process.stderr.write('[wrightward-mcp] fatal: ' + (err.stack || err.message || err) + '\n');
  process.exit(1);
});
