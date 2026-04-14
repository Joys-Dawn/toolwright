/**
 * MCP tool definitions and handlers for wrightward bus.
 * 6 tools: list_inbox, ack, send_note, send_handoff, watch_file, bus_status
 */

import { createRequire } from 'module';
import {
  readLock,
  readCircuitBreaker,
  isProcessAlive
} from '../broker/lifecycle.mjs';
const require = createRequire(import.meta.url);

const { withAgentsLock } = require('../lib/agents');
const { readBookmark, append, appendBatch } = require('../lib/bus-log');
const { listInbox, writeInterest, writeAck, buildFileFreedEvents } = require('../lib/bus-query');
const { createEvent, URGENT_TYPES } = require('../lib/bus-schema');
const { readContext, writeContext } = require('../lib/context');
const { getAllClaimedFiles } = require('../lib/session-state');
const { projectRelative } = require('../lib/path-normalize');
const busMeta = require('../lib/bus-meta');
const { readInboxFresh, advanceBookmark } = require('../lib/bus-delivery');

// Path canonicalization now lives in lib/path-normalize.projectRelative so
// MCP tools, guard.js, and any future caller all converge on the same key.

function validateListInboxArgs(args) {
  if (args.limit !== undefined) {
    if (typeof args.limit !== 'number' || !Number.isFinite(args.limit) || args.limit < 0) {
      throw new Error('limit must be a non-negative finite number');
    }
    args.limit = Math.floor(args.limit);
  }
  if (args.types !== undefined) {
    if (!Array.isArray(args.types) || args.types.some(t => typeof t !== 'string')) {
      throw new Error('types must be an array of strings');
    }
    const bad = args.types.filter(t => !URGENT_TYPES.has(t));
    if (bad.length > 0) {
      throw new Error('unknown urgent types: ' + bad.join(',') + ' (allowed: ' + [...URGENT_TYPES].join(',') + ')');
    }
  }
  if (args.mark_delivered !== undefined && typeof args.mark_delivered !== 'boolean') {
    throw new Error('mark_delivered must be boolean');
  }
}

function validateAckArgs(args) {
  if (typeof args.id !== 'string' || args.id.length === 0) {
    throw new Error('id must be a non-empty string');
  }
  if (args.decision !== undefined && !['accepted', 'rejected', 'dismissed'].includes(args.decision)) {
    throw new Error('decision must be one of: accepted, rejected, dismissed');
  }
}

function validateSendNoteArgs(args) {
  if (typeof args.body !== 'string' || args.body.length === 0) {
    throw new Error('body must be a non-empty string');
  }
  if (args.to !== undefined && typeof args.to !== 'string') {
    throw new Error('to must be a string');
  }
  if (args.files !== undefined && (!Array.isArray(args.files) || args.files.some(f => typeof f !== 'string'))) {
    throw new Error('files must be an array of strings');
  }
}

function validateSendHandoffArgs(args) {
  if (typeof args.to !== 'string' || args.to.trim().length === 0) {
    throw new Error('to must be a non-empty string (target session ID)');
  }
  if (typeof args.task_ref !== 'string' || args.task_ref.length === 0) {
    throw new Error('task_ref must be a non-empty string');
  }
  if (typeof args.next_action !== 'string' || args.next_action.length === 0) {
    throw new Error('next_action must be a non-empty string');
  }
  if (args.files_unlocked !== undefined && (!Array.isArray(args.files_unlocked) || args.files_unlocked.some(f => typeof f !== 'string'))) {
    throw new Error('files_unlocked must be an array of strings');
  }
}

function validateWatchFileArgs(args) {
  if (typeof args.file !== 'string' || args.file.length === 0) {
    throw new Error('file must be a non-empty string');
  }
}

function validateSendMessageArgs(args) {
  if (typeof args.body !== 'string' || args.body.length === 0) {
    throw new Error('body must be a non-empty string');
  }
  if (typeof args.audience !== 'string' || args.audience.length === 0) {
    throw new Error('audience must be a non-empty string ("user", "all", or a sessionId)');
  }
}

const TOOL_DEFINITIONS = [
  {
    name: 'wrightward_list_inbox',
    description: 'List urgent bus events targeted at this session. Advances delivery bookmark by default. Only returns urgent event types (handoff, file_freed, user_message, blocker, delivery_failed).',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max events to return' },
        types: { type: 'array', items: { type: 'string' }, description: 'Filter within urgent event types only. Valid values: "handoff", "file_freed", "user_message", "blocker", "delivery_failed". Non-urgent types are never returned.' },
        mark_delivered: { type: 'boolean', description: 'Advance bookmark (default true)' }
      }
    }
  },
  {
    name: 'wrightward_ack',
    description: 'Acknowledge a bus event (e.g., handoff). Records a semantic ack.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Event ID to acknowledge' },
        decision: { type: 'string', enum: ['accepted', 'rejected', 'dismissed'], description: 'Ack decision' }
      },
      required: ['id']
    }
  },
  {
    name: 'wrightward_send_note',
    description: 'Send a note to other agents on the bus.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Target: session ID, "all", or "role:<name>"' },
        body: { type: 'string', description: 'Message body' },
        files: { type: 'array', items: { type: 'string' }, description: 'Related file paths' }
      },
      required: ['body']
    }
  },
  {
    name: 'wrightward_send_handoff',
    description: 'Hand off work to another agent. Releases specified files and sends a handoff event.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Target session ID' },
        task_ref: { type: 'string', description: 'Task reference' },
        files_unlocked: { type: 'array', items: { type: 'string' }, description: 'Files to release' },
        next_action: { type: 'string', description: 'Suggested next action for recipient' }
      },
      required: ['to', 'task_ref', 'next_action']
    }
  },
  {
    name: 'wrightward_watch_file',
    description: 'Register interest in a file. You will be notified when it becomes available.',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'File path to watch (relative)' }
      },
      required: ['file']
    }
  },
  {
    name: 'wrightward_bus_status',
    description: 'Get bus diagnostic information.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'wrightward_send_message',
    description: 'Send a message via Discord. Use this to reply to the user when they have spoken to you in a Discord channel/thread (rather than the CLI). The Discord bridge must be running. Audience controls who else receives it: "user" replies to Discord only; "all" also broadcasts to every other active wrightward agent\'s inbox; a sessionId posts into that specific agent\'s Discord thread AND notifies them via the bus.',
    inputSchema: {
      type: 'object',
      properties: {
        body: { type: 'string', description: 'Message text. Truncated to 1800 chars in Discord.' },
        audience: { type: 'string', description: '"user" (Discord-only reply), "all" (Discord broadcast + every active agent\'s inbox), or a target sessionId (that agent\'s thread + inbox)' }
      },
      required: ['body', 'audience']
    }
  }
];

export function getToolDefinitions() {
  return TOOL_DEFINITIONS;
}

export function handleToolCall(toolName, args, collabDir, sessionId, config, projectRoot) {
  if (!sessionId) {
    return { content: [{ type: 'text', text: JSON.stringify({ error: 'MCP server not bound to a session' }) }] };
  }
  if (!config.BUS_ENABLED) {
    return { content: [{ type: 'text', text: JSON.stringify({ error: 'Bus is disabled' }) }] };
  }

  try {
    switch (toolName) {
      case 'wrightward_list_inbox':
        return handleListInbox(args, collabDir, sessionId, config);
      case 'wrightward_ack':
        return handleAck(args, collabDir, sessionId);
      case 'wrightward_send_note':
        return handleSendNote(args, collabDir, sessionId, config, projectRoot);
      case 'wrightward_send_handoff':
        return handleSendHandoff(args, collabDir, sessionId, config, projectRoot);
      case 'wrightward_watch_file':
        return handleWatchFile(args, collabDir, sessionId, config, projectRoot);
      case 'wrightward_bus_status':
        return handleBusStatus(collabDir, sessionId);
      case 'wrightward_send_message':
        return handleSendMessage(args, collabDir, sessionId);
      default:
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'Unknown tool: ' + toolName }) }] };
    }
  } catch (err) {
    return { content: [{ type: 'text', text: JSON.stringify({ error: err.message }) }] };
  }
}

function handleListInbox(args, collabDir, sessionId, config) {
  validateListInboxArgs(args);
  let result;
  withAgentsLock(collabDir, (token) => {
    const { events, endOffset, bookmark, meta, isStale } = readInboxFresh(token, collabDir, sessionId);

    let afterTypeFilter = events;
    const hasTypeFilter = !!args.types;
    if (hasTypeFilter) {
      const typeSet = new Set(args.types);
      afterTypeFilter = afterTypeFilter.filter(e => typeSet.has(e.type));
    }
    let filtered = afterTypeFilter;
    if (args.limit !== undefined) {
      filtered = filtered.slice(0, args.limit);
    }

    const markDelivered = args.mark_delivered !== false;
    const delivered = markDelivered && filtered.length > 0
      ? filtered[filtered.length - 1]
      : null;

    // Two truncation cases with different bookmark semantics:
    // - limit shrank a type-matching slice: remaining matches are AFTER delivered
    //   (events are ordered by offset); lastScannedOffset = delivered._offset is
    //   correct — next scan starts just past delivered and picks up the tail.
    // - types filter dropped events: those events can appear BEFORE delivered, so
    //   advancing lastScannedOffset past them would permanently skip them. Pin
    //   lastScannedOffset at bookmark.lastScannedOffset — readInboxFresh now
    //   applies ts+id dedup whenever fromOffset <= lastDeliveredOffset, so
    //   already-delivered events won't be re-surfaced.
    const typesDroppedEvents = hasTypeFilter && afterTypeFilter.length < events.length;
    const truncatedByLimit = !!delivered && filtered.length < afterTypeFilter.length;
    let truncated;
    let endOffsetForBookmark;
    if (typesDroppedEvents) {
      // Holding lastScannedOffset lets filtered-out events re-surface. The
      // `truncated` flag would override to delivered._offset and defeat that,
      // so drop it in this case and route through the `: endOffset` branch
      // with endOffset pinned to the prior lastScannedOffset.
      truncated = false;
      endOffsetForBookmark = bookmark.lastScannedOffset || 0;
    } else {
      truncated = truncatedByLimit;
      endOffsetForBookmark = endOffset;
    }
    advanceBookmark(token, collabDir, sessionId, {
      delivered,
      endOffset: endOffsetForBookmark,
      bookmark, meta, isStale, truncated
    });

    result = { events: filtered.map(e => { const { _offset, ...rest } = e; return rest; }) };
  });
  return { content: [{ type: 'text', text: JSON.stringify(result) }] };
}

function handleAck(args, collabDir, sessionId) {
  validateAckArgs(args);
  let id;
  withAgentsLock(collabDir, (token) => {
    id = writeAck(token, collabDir, sessionId, args.id, args.decision || 'accepted');
  });
  return { content: [{ type: 'text', text: JSON.stringify({ ok: true, id }) }] };
}

function handleSendNote(args, collabDir, sessionId, _config, projectRoot) {
  validateSendNoteArgs(args);
  // Normalize note files so meta.files uses the same cwd-relative, POSIX form
  // as context entries and interest-index keys. Drop out-of-project entries.
  const rawFiles = Array.isArray(args.files) ? args.files : [];
  const files = [];
  for (const f of rawFiles) {
    const rel = projectRelative(projectRoot, f);
    if (rel) files.push(rel);
  }

  let id;
  withAgentsLock(collabDir, (token) => {
    const event = createEvent(sessionId, args.to || 'all', 'note', args.body, { files });
    append(token, collabDir, event);
    id = event.id;
  });
  return { content: [{ type: 'text', text: JSON.stringify({ id }) }] };
}

function handleSendMessage(args, collabDir, sessionId) {
  validateSendMessageArgs(args);
  // `audience` is passed straight to event.to. Reserved values "user" and
  // "all" (constants.BROADCAST_TARGETS) route to the Discord broadcast channel
  // via mirror-policy; any other string is treated as a sessionId and routed
  // to that thread + inbox. Self-targeting (audience === own sessionId) is
  // allowed: matchesSession suppresses inbox echo, and the bridge will post
  // into the session's own thread, which is harmless.
  let id;
  withAgentsLock(collabDir, (token) => {
    const event = createEvent(sessionId, args.audience, 'agent_message', args.body);
    append(token, collabDir, event);
    id = event.id;
  });
  return { content: [{ type: 'text', text: JSON.stringify({ id }) }] };
}

function handleSendHandoff(args, collabDir, sessionId, config, projectRoot) {
  validateSendHandoffArgs(args);

  // Normalize + relativize agent-supplied paths so they match context/index keys.
  // Drop any paths outside the project root (relative lookup would succeed but
  // point nowhere useful).
  const rawFiles = args.files_unlocked || [];
  const requested = [];
  for (const f of rawFiles) {
    const rel = projectRelative(projectRoot, f);
    if (rel) requested.push(rel);
  }

  let id;
  withAgentsLock(collabDir, (token) => {
    // Restrict to files this session actually claims. Emitting file_freed for
    // files never held by the sender would mislead watchers about availability.
    const ctx = readContext(collabDir, sessionId);
    const claimedSet = new Set(
      (ctx && Array.isArray(ctx.files) ? ctx.files : [])
        .filter(f => f && f.prefix !== '-')
        .map(f => f.path)
    );
    const filesToUnlock = requested.filter(f => claimedSet.has(f));

    if (filesToUnlock.length > 0 && ctx && Array.isArray(ctx.files)) {
      const unlockSet = new Set(filesToUnlock);
      ctx.files = ctx.files.filter(f => !unlockSet.has(f.path));
      writeContext(collabDir, sessionId, ctx);
    }

    // Emit file_freed for interested agents EXCEPT the handoff recipient.
    // ctx.files has already been rewritten (unlocked files removed), so
    // getAllClaimedFiles sees only OTHER sessions' claims — buildFileFreedEvents
    // will suppress emission for files any other session still holds.
    const stillClaimed = getAllClaimedFiles(collabDir);
    const fileFreedEvents = buildFileFreedEvents(token, collabDir, {
      releasedBy: sessionId,
      files: filesToUnlock,
      reason: 'handoff',
      excludeRecipients: [args.to],
      stillClaimed
    });
    if (fileFreedEvents.length > 0) {
      appendBatch(token, collabDir, fileFreedEvents);
    }

    // Mirror writeInterest's TTL semantics: explicit 0 means "no expiry" and
    // must be honored, only `undefined` falls back to the 30-minute default.
    // The previous `|| 30 * 60 * 1000` collapsed both cases, silently re-arming
    // an expiry on operators who had configured BUS_HANDOFF_TTL_MIN: 0.
    const ttlMs = typeof config.BUS_HANDOFF_TTL_MS === 'number'
      ? config.BUS_HANDOFF_TTL_MS
      : 30 * 60 * 1000;
    const expiresAt = ttlMs > 0 ? Date.now() + ttlMs : null;
    const event = createEvent(sessionId, args.to, 'handoff', args.next_action, {
      task_ref: args.task_ref,
      files_unlocked: filesToUnlock,
      next_action: args.next_action,
      ttl_ms: ttlMs
    }, 'info', expiresAt);
    append(token, collabDir, event);
    id = event.id;
  });
  return { content: [{ type: 'text', text: JSON.stringify({ id }) }] };
}

function handleWatchFile(args, collabDir, sessionId, config, projectRoot) {
  validateWatchFileArgs(args);
  const relPath = projectRelative(projectRoot, args.file);
  if (!relPath) {
    return { content: [{ type: 'text', text: JSON.stringify({ error: 'file must be a path inside the project root' }) }] };
  }
  let id;
  withAgentsLock(collabDir, (token) => {
    id = writeInterest(token, collabDir, sessionId, relPath, config.BUS_INTEREST_TTL_MS);
  });
  return { content: [{ type: 'text', text: JSON.stringify({ id }) }] };
}

function handleBusStatus(collabDir, sessionId) {
  let status;
  withAgentsLock(collabDir, (token) => {
    const meta = busMeta.readMeta(collabDir);
    const bookmark = readBookmark(collabDir, sessionId);
    const { events } = listInbox(token, collabDir, sessionId, bookmark.lastScannedOffset);

    status = {
      pending_urgent: events.length,
      last_ts: meta.lastTs,
      retention_entries: meta.eventCount,
      bound_session_id: sessionId,
      bridge: readBridgeStatus(collabDir)
    };
  });
  return { content: [{ type: 'text', text: JSON.stringify(status) }] };
}

/**
 * Summarizes the bridge daemon's state for diagnostic output. Consumed by
 * `wrightward_bus_status`. All fields are safe to stringify; when no bridge
 * has ever run the shape is still well-formed (`running: false`, null fields).
 */
function readBridgeStatus(collabDir) {
  const lock = readLock(collabDir);
  const cb = readCircuitBreaker(collabDir);
  const hasCircuit = cb.consecutive_failures > 0 || cb.disabled_until_ts > 0;
  const childAlive = !!(lock && lock.bridge_child_pid && isProcessAlive(lock.bridge_child_pid));
  return {
    running: childAlive,
    owned_by_this_session: !!(lock && lock.owner_pid === process.pid),
    owner_session_id: lock ? lock.owner_session_id : null,
    owner_pid: lock ? lock.owner_pid : null,
    child_pid: lock ? lock.bridge_child_pid : null,
    last_error: cb.last_error || null,
    circuit_breaker: hasCircuit ? {
      disabled_until_ts: cb.disabled_until_ts,
      consecutive_failures: cb.consecutive_failures,
      last_error: cb.last_error
    } : null
  };
}
