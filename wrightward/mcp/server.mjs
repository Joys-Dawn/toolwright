#!/usr/bin/env node
/**
 * wrightward MCP server — spawned by Claude Code per session via plugin.json.
 *
 * Phase 1: tools only (no channel capability).
 * Phase 2 will add experimental: { 'claude/channel': {} } for push notifications.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createRequire } from 'module';
import { createSessionBinder } from './session-bind.mjs';
import { getToolDefinitions, handleToolCall } from './tools.mjs';

const require = createRequire(import.meta.url);
const { resolveCollabDir } = require('../lib/collab-dir');
const { loadConfig } = require('../lib/config');

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
    { name: 'wrightward-bus', version: '3.0.0' },
    {
      capabilities: { tools: {} },
      instructions: 'wrightward bus: peer-to-peer messaging between Claude Code sessions. Use wrightward_list_inbox to check for messages, wrightward_send_handoff to hand off work, wrightward_watch_file to watch a file, wrightward_ack to acknowledge events.'
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

  // Graceful shutdown
  process.on('SIGTERM', () => {
    process.stderr.write('[wrightward-mcp] SIGTERM received, shutting down\n');
    binder.cleanup();
    process.exit(0);
  });
}

main().catch(err => {
  process.stderr.write('[wrightward-mcp] fatal: ' + (err.stack || err.message || err) + '\n');
  process.exit(1);
});
