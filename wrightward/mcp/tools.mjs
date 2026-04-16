/**
 * MCP tool definitions and handlers for wrightward bus.
 * 8 tools: list_inbox, ack, send_note, send_handoff, watch_file, bus_status,
 * send_message, whoami.
 */

import { createRequire } from 'module';
import {
  readLock,
  readCircuitBreaker,
  isProcessAlive
} from '../broker/lifecycle.mjs';
const require = createRequire(import.meta.url);

const { withAgentsLock, readAgents } = require('../lib/agents');
const { readBookmark, append, appendBatch } = require('../lib/bus-log');
const { listInbox, writeInterest, writeAck, findEventById, buildFileFreedEvents } = require('../lib/bus-query');
const { createEvent, URGENT_TYPES } = require('../lib/bus-schema');
const { readContext, writeContext } = require('../lib/context');
const { getAllClaimedFiles } = require('../lib/session-state');
const { projectRelative } = require('../lib/path-normalize');
const busMeta = require('../lib/bus-meta');
const { readInboxFresh, advanceBookmark } = require('../lib/bus-delivery');
const { resolveAudience, handleFor } = require('../lib/handles');

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

const SEND_NOTE_KINDS = new Set(['note', 'finding', 'decision']);

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
  if (args.kind !== undefined && !SEND_NOTE_KINDS.has(args.kind)) {
    throw new Error('kind must be one of: note, finding, decision');
  }
}

function validateSendHandoffArgs(args) {
  if (typeof args.to !== 'string' || args.to.trim().length === 0) {
    throw new Error('to must be a non-empty string (target peer handle, e.g. "bob-42")');
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
    throw new Error('audience must be a non-empty string ("user", "all", or a peer handle like "bob-42")');
  }
}

const TOOL_DEFINITIONS = [
  {
    name: 'wrightward_list_inbox',
    description: 'List urgent bus events targeted at this session. Advances delivery bookmark by default. Only returns urgent event types (handoff, file_freed, user_message, blocker, delivery_failed, agent_message, ack, finding, decision).',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max events to return' },
        types: { type: 'array', items: { type: 'string' }, description: 'Filter within urgent event types only. Valid values: "handoff", "file_freed", "user_message", "blocker", "delivery_failed", "agent_message", "ack", "finding", "decision". Non-urgent types are never returned.' },
        mark_delivered: { type: 'boolean', description: 'Advance bookmark (default true)' }
      }
    }
  },
  {
    name: 'wrightward_ack',
    description: 'Acknowledge a handoff (or other bus event) and notify its original sender. Looks up the event by id, routes the ack at the sender\'s session so they see your decision on their next tool call and in their Discord thread.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Event ID to acknowledge (e.g., the handoff id from your inbox).' },
        decision: { type: 'string', enum: ['accepted', 'rejected', 'dismissed'], description: 'Your decision. Defaults to "accepted".' }
      },
      required: ['id']
    }
  },
  {
    name: 'wrightward_send_note',
    description: 'Log an observability entry to the bus. Use `kind` to signal importance: "note" (default) is a quiet log — persisted but non-urgent, shows only in Discord; "finding" is urgent and broadcasts to every agent — use when you discover something others MUST know (bug, gotcha, surprising behavior); "decision" is urgent and broadcasts — use when you make a choice others must know about (picked approach X, ruled out Y). To direct at a specific agent, set `to` to their handle (e.g. "bob-42").',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Target: peer handle (e.g. "bob-42") or "all" (default).' },
        body: { type: 'string', description: 'Message body.' },
        kind: { type: 'string', enum: ['note', 'finding', 'decision'], description: 'Observability level. "note" quiet; "finding" and "decision" urgent. Defaults to "note".' },
        files: { type: 'array', items: { type: 'string' }, description: 'Related file paths.' }
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
        to: { type: 'string', description: 'Target peer handle (e.g. "bob-42").' },
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
    description: 'Send a message via Discord. Use this to reply to the user when they have spoken to you in a Discord channel/thread (rather than the CLI). The Discord bridge must be running. Audience controls who else receives it: "user" replies to Discord only; "all" also broadcasts to every other active wrightward agent\'s inbox; a peer agent\'s handle (e.g. "bob-42") posts into that agent\'s Discord thread AND notifies them via the bus. The bridge automatically prefixes the sender\'s handle at the top of every broadcast/thread post — you do not need to self-identify in the body.',
    inputSchema: {
      type: 'object',
      properties: {
        body: { type: 'string', description: 'Message text. Truncated to 1800 chars in Discord.' },
        audience: { type: 'string', description: '"user" (Discord-only reply), "all" (Discord broadcast + every active agent\'s inbox), or a peer handle like "bob-42" / "sam-17". Call wrightward_whoami to see your own handle.' }
      },
      required: ['body', 'audience']
    }
  },
  {
    name: 'wrightward_whoami',
    description: 'Return your own agent handle, session ID, and registration time. Use this when you need to remind yourself of your identity (e.g. after compaction), or to announce yourself unambiguously. Handles are deterministic per-session — the same session always gets the same handle.',
    inputSchema: { type: 'object', properties: {} }
  }
];

export function getToolDefinitions() {
  return TOOL_DEFINITIONS;
}

export function handleToolCall(toolName, args, collabDir, sessionId, config, projectRoot) {
  if (!sessionId) {
    return { content: [{ type: 'text', text: JSON.stringify({
      error: 'MCP server not bound to a session',
      hint: 'Try again in a few seconds — session binding is async.'
    }) }] };
  }
  if (!config.BUS_ENABLED) {
    return { content: [{ type: 'text', text: JSON.stringify({
      error: 'Bus is disabled',
      hint: 'Ask the user to set BUS_ENABLED=true in .claude/wrightward.json.'
    }) }] };
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
      case 'wrightward_whoami':
        return handleWhoami(collabDir, sessionId);
      default:
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'Unknown tool: ' + toolName }) }] };
    }
  } catch (err) {
    // Structured audience errors carry a `hint` that lists live handles —
    // surface it so the agent can recover (e.g. retry with a valid handle)
    // without calling wrightward_list_inbox just to learn names.
    if (err && err.audienceError) {
      return { content: [{ type: 'text', text: JSON.stringify({
        error: err.audienceError.message,
        hint: err.audienceError.hint,
        live_handles: err.audienceError.liveHandles
      }) }] };
    }
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
  let result;
  withAgentsLock(collabDir, (token) => {
    // Look up the original event so we can route the ack at its sender.
    // Without this, acks would broadcast to `all` and the original sender
    // would have no automated path to learn their handoff was acted on.
    const original = findEventById(token, collabDir, args.id);
    if (!original) {
      result = {
        error: 'ackOf refers to an unknown or expired event',
        hint: 'Call wrightward_list_inbox to see live event ids.'
      };
      return;
    }
    const taskRef = original.meta && typeof original.meta.task_ref === 'string'
      ? original.meta.task_ref
      : undefined;
    const id = writeAck(
      token, collabDir, sessionId,
      original.from, args.id,
      args.decision || 'accepted',
      taskRef
    );
    result = { ok: true, id, hint: 'Sender notified on their next tool call.' };
  });
  return { content: [{ type: 'text', text: JSON.stringify(result) }] };
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

  // kind determines the event type. 'note' is non-urgent (quiet log).
  // 'finding' and 'decision' are urgent — they auto-inject into other
  // agents' contexts on their next tool call. See bus-schema URGENT_TYPES.
  const kind = args.kind || 'note';

  const rawTarget = args.to || 'all';
  const resolved = resolveAudience(collabDir, rawTarget);

  let id;
  withAgentsLock(collabDir, (token) => {
    const event = createEvent(sessionId, resolved.target, kind, args.body, { files });
    append(token, collabDir, event);
    id = event.id;
  });
  const hint = kind === 'note'
    ? 'Logged quietly. Discord only; other agents not notified.'
    : 'Broadcast — every active agent sees this on their next tool call.';
  return { content: [{ type: 'text', text: JSON.stringify({ id, hint }) }] };
}

function handleSendMessage(args, collabDir, sessionId) {
  validateSendMessageArgs(args);
  // resolveAudience guarantees the `to` field is either 'user', 'all', or a
  // canonical session UUID owned by a live agent. This is the gate that
  // prevents hallucinated UUIDs (valid-shape-but-no-session) from being
  // persisted to bus.jsonl where matchesSession would silently drop them.
  const resolved = resolveAudience(collabDir, args.audience);
  let id;
  let recipientHandle;
  withAgentsLock(collabDir, (token) => {
    const event = createEvent(sessionId, resolved.target, 'agent_message', args.body);
    append(token, collabDir, event);
    id = event.id;
    if (resolved.type === 'sessionId') {
      const roster = readAgents(collabDir);
      recipientHandle = handleFor(resolved.target, roster[resolved.target]);
    }
  });
  let hint;
  if (resolved.target === 'user') {
    hint = 'Posted to Discord (user-facing channel).';
  } else if (resolved.target === 'all') {
    hint = 'Broadcast to Discord + every active agent\'s inbox.';
  } else {
    hint = `Posted to ${recipientHandle}'s Discord thread and inbox.`;
  }
  return { content: [{ type: 'text', text: JSON.stringify({ id, hint }) }] };
}

function handleWhoami(collabDir, sessionId) {
  const roster = readAgents(collabDir);
  const row = roster[sessionId] || {};
  const handle = handleFor(sessionId, row);
  const registered_at = typeof row.registered_at === 'number' ? row.registered_at : null;
  return { content: [{ type: 'text', text: JSON.stringify({
    sessionId,
    handle,
    registered_at,
    hint: `Use @agent-${handle} in Discord to address you; peers reach you via wrightward_send_message(audience="${handle}").`
  }) }] };
}

function handleSendHandoff(args, collabDir, sessionId, config, projectRoot) {
  validateSendHandoffArgs(args);

  // Resolve `to` against the live roster so callers can supply a handle
  // (e.g. "bob-42") instead of a raw UUID. Consistent with send_message
  // and send_note; rejects hallucinated targets before we write the event.
  const resolved = resolveAudience(collabDir, args.to);
  if (resolved.type !== 'sessionId') {
    throw new Error('handoff target must be a specific agent handle (e.g. "bob-42"), not a broadcast target');
  }
  const targetSessionId = resolved.target;

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
      excludeRecipients: [targetSessionId],
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
    const event = createEvent(sessionId, targetSessionId, 'handoff', args.next_action, {
      task_ref: args.task_ref,
      files_unlocked: filesToUnlock,
      next_action: args.next_action,
      ttl_ms: ttlMs
    }, 'info', expiresAt);
    append(token, collabDir, event);
    id = event.id;
  });
  return { content: [{ type: 'text', text: JSON.stringify({
    id,
    hint: 'Recipient sees this on their next tool call. Their ack will arrive in your inbox.'
  }) }] };
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
  return { content: [{ type: 'text', text: JSON.stringify({
    id,
    hint: 'You\'ll be notified when the file frees up.'
  }) }] };
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
