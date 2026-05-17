// Deterministic transcript filter ("chunker"), shared by the live hook write
// path and the consolidator's exchange-grouping step. No LLM here — every
// accept/reject is structural.

import {
  INBOX_PRIMARY_EVENT_TYPES,
  WRIGHTWARD_OUTBOUND_TOOLS,
  WRIGHTWARD_INBOX_TOOL,
} from './constants.js';
import { readSinceOffset } from './transcript.js';
import { basename } from 'node:path';

const CHANNEL_DOORBELL_PREFIX = '<channel source=';
const AUTONOMOUS_LOOP_SENTINELS = new Set([
  '<<autonomous-loop>>',
  '<<autonomous-loop-dynamic>>',
]);

// Wire names look like `mcp__plugin_wrightward_wrightward-bus__wrightward_send_message`;
// only the bare suffix after the final '__' matters.
function bareToolName(name) {
  if (typeof name !== 'string') return '';
  const idx = name.lastIndexOf('__');
  return idx === -1 ? name : name.slice(idx + 2);
}

function isOutboundWrightward(name) {
  return WRIGHTWARD_OUTBOUND_TOOLS.includes(bareToolName(name));
}

function isInboxTool(name) {
  return bareToolName(name) === WRIGHTWARD_INBOX_TOOL;
}

// A wrightward_list_inbox tool_result wraps `{"events":[...]}`. tool_result
// content is either a plain string or an array of content blocks; tolerate
// both, and never throw on a malformed payload — return null.
function parseInboxEvents(content) {
  let text;
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('');
  } else {
    return null;
  }
  if (!text) return null;
  try {
    const obj = JSON.parse(text);
    if (obj && Array.isArray(obj.events)) return obj.events;
  } catch {
    // Not JSON — some inbox responses are other shapes carrying no events.
  }
  return null;
}

// Event types map straight onto kind names except user_message → discord_user
// (distinguishes it from peer agent_message rows).
function kindForEventType(eventType) {
  if (eventType === 'user_message') return 'discord_user';
  return eventType;
}

function isoFromEventTs(ts, fallback) {
  if (typeof ts === 'number' && Number.isFinite(ts)) {
    // Bus events store ts as Unix ms (wrightward bus-schema createEvent).
    return new Date(ts).toISOString();
  }
  if (typeof ts === 'string' && ts.length > 0) return ts;
  return fallback || null;
}

// Pure record-level chunker. Walks parsed records in order, maintains a
// tool_use_id → tool_name map so a later tool_result can be classified, and
// emits a Chunk[].
//
// The caller MAY pass in an existing `toolUseIdToName` map so the mapping
// survives across chunkRecords calls within one session — required because a
// tool_use and its matching tool_result almost always land in different hook
// passes. A fresh per-call map would mis-classify every inbox tool_result as
// "unknown" and drop every wrightward bus event. Mutated in place so the
// caller can persist it.
//
// Exchange grouping is NOT done here — consolidator.groupIntoExchanges is the
// single source of truth, re-deriving it over persisted rows at drain time.

// Recover a chunk-ready body string from an arbitrary bus event payload.
// Returns null on undecodable input so the caller can skip cleanly.
function recoverEventBody(body) {
  // body is declared string but a malformed/old peer could send object/null:
  // null → skip; non-string → JSON.stringify so it stays inspectable in the
  // dropped-archive instead of stored as '[object Object]'.
  if (body == null) return null;
  if (typeof body === 'string') return body;
  try {
    return JSON.stringify(body);
  } catch (e) {
    // Cyclic / non-serializable — drop, but log so a repeated pattern is
    // visible to an operator.
    process.stderr.write(
      `[mindwright/chunker] dropping unserializable event body (${typeof body}): ${e && e.message ? e.message : e}\n`,
    );
    return null;
  }
}

// Durable provenance locator. A Claude Code transcript record carries a stable
// `uuid`; pairing it with the transcript basename yields a locator that
// survives flush passes and re-seeding — unlike the within-batch `line:` index,
// which resets to 0 every pass. Multi-block records append `:b<bi>` so each
// chunk stays unique. Records with no uuid fall back to the deterministic
// `line:` form.
function sourceRefFor(sourceFile, uuid, lineIdx, bi) {
  if (typeof uuid === 'string' && uuid.length > 0) {
    const base = sourceFile ? `${sourceFile}:` : '';
    return bi == null ? `${base}${uuid}` : `${base}${uuid}:b${bi}`;
  }
  return bi == null ? `line:${lineIdx}` : `line:${lineIdx}:b${bi}`;
}

function eventToChunk(ev, lineIdx, bi, fallbackTs, sourceFile, uuid) {
  const body = recoverEventBody(ev.body);
  if (body == null) return null;
  return {
    kind: kindForEventType(ev.type),
    content: body,
    source_ref: ev.id ? `bus:${ev.id}` : sourceRefFor(sourceFile, uuid, lineIdx, bi),
    timestamp: isoFromEventTs(ev.ts, fallbackTs),
    meta: {
      event_type: ev.type,
      from: ev.from ?? null,
      to: ev.to ?? null,
    },
  };
}

function userStringChunk(content, lineIdx, ts, sourceFile, uuid) {
  const trimmed = content.trim();
  if (AUTONOMOUS_LOOP_SENTINELS.has(trimmed)) return null;
  // Channel-doorbell pings are delivery mechanics — drop; the actual inbox
  // events arrive shortly after as tool_result blocks.
  if (content.startsWith(CHANNEL_DOORBELL_PREFIX)) return null;
  return {
    kind: 'cli_prompt',
    content,
    source_ref: sourceRefFor(sourceFile, uuid, lineIdx, null),
    timestamp: ts,
    meta: {},
  };
}

function userArrayChunks(blocks, lineIdx, ts, map, sourceFile, uuid) {
  const out = [];
  for (let bi = 0; bi < blocks.length; bi++) {
    const block = blocks[bi];
    if (!block || block.type !== 'tool_result') continue;
    const toolName = map.get(block.tool_use_id);
    if (!toolName || !isInboxTool(toolName)) continue;
    const events = parseInboxEvents(block.content);
    if (!Array.isArray(events) || events.length === 0) continue;
    for (const ev of events) {
      if (!ev || typeof ev.type !== 'string') continue;
      if (!INBOX_PRIMARY_EVENT_TYPES.includes(ev.type)) continue;
      const chunk = eventToChunk(ev, lineIdx, bi, ts, sourceFile, uuid);
      if (chunk) out.push(chunk);
    }
  }
  return out;
}

function assistantBlockChunk(block, lineIdx, bi, ts, map, sourceFile, uuid) {
  if (!block || typeof block !== 'object') return null;
  if (block.type === 'thinking') {
    return {
      kind: 'thinking',
      content: typeof block.thinking === 'string' ? block.thinking : '',
      source_ref: sourceRefFor(sourceFile, uuid, lineIdx, bi),
      timestamp: ts,
      meta: {},
    };
  }
  if (block.type === 'text') {
    return {
      kind: 'text',
      content: typeof block.text === 'string' ? block.text : '',
      source_ref: sourceRefFor(sourceFile, uuid, lineIdx, bi),
      timestamp: ts,
      meta: {},
    };
  }
  if (block.type === 'tool_use') {
    // Only remember inbox-tool ids: recording every Read/Edit/Bash id would
    // grow the persisted map without bound on long sessions.
    if (
      typeof block.id === 'string' &&
      typeof block.name === 'string' &&
      isInboxTool(block.name)
    ) {
      map.set(block.id, block.name);
    }
    if (!isOutboundWrightward(block.name)) return null;
    const input = (block.input && typeof block.input === 'object') ? block.input : {};
    const body = typeof input.body === 'string' ? input.body : '';
    return {
      kind: 'outbound_send',
      content: body,
      source_ref: sourceRefFor(sourceFile, uuid, lineIdx, bi),
      timestamp: ts,
      meta: {
        tool: bareToolName(block.name),
        audience: typeof input.audience === 'string' ? input.audience : null,
      },
    };
  }
  return null; // unknown assistant block type
}

function chunkRecords(records, toolUseIdToName, sourceFile = null) {
  const chunks = [];
  // Separate local so we never reassign the caller's parameter — that would
  // break the "mutated in place so the caller can persist it" contract when
  // the caller passed a non-Map.
  const map = toolUseIdToName instanceof Map ? toolUseIdToName : new Map();

  for (let lineIdx = 0; lineIdx < records.length; lineIdx++) {
    const rec = records[lineIdx];
    if (!rec || typeof rec !== 'object') continue;
    const ts = typeof rec.timestamp === 'string' ? rec.timestamp : null;
    // Stable per-record provenance id; null for the rare record without one
    // (sourceRefFor then falls back to the line: form).
    const uuid = typeof rec.uuid === 'string' ? rec.uuid : null;

    if (rec.type === 'user') {
      // Compaction summaries are post-hoc syntheses, not real conversation.
      if (rec.isCompactSummary === true) continue;
      const content = rec.message && rec.message.content;
      if (typeof content === 'string') {
        const chunk = userStringChunk(content, lineIdx, ts, sourceFile, uuid);
        if (chunk) chunks.push(chunk);
        continue;
      }
      if (Array.isArray(content)) {
        chunks.push(...userArrayChunks(content, lineIdx, ts, map, sourceFile, uuid));
        continue;
      }
      continue; // other content shapes: drop
    }

    if (rec.type === 'assistant') {
      const content = rec.message && rec.message.content;
      if (!Array.isArray(content)) continue;
      for (let bi = 0; bi < content.length; bi++) {
        const chunk = assistantBlockChunk(content[bi], lineIdx, bi, ts, map, sourceFile, uuid);
        if (chunk) chunks.push(chunk);
      }
      continue;
    }

    // Any other record type: drop.
  }

  return chunks;
}

// Parses raw JSONL line strings (unparseable lines dropped). Second arg is the
// persisted tool_use_id → tool_name map (see chunkRecords). `sourceFile` is
// threaded so chunks carry a durable `<basename>:<uuid>` source_ref.
export function chunkTranscript(lines, toolUseIdToName, { sourceFile = null } = {}) {
  if (!Array.isArray(lines)) return [];
  const records = [];
  for (const line of lines) {
    if (typeof line !== 'string' || line.length === 0) continue;
    try {
      const obj = JSON.parse(line);
      if (obj && typeof obj === 'object') records.push(obj);
    } catch {
      // Drop invalid lines.
    }
  }
  return chunkRecords(records, toolUseIdToName, sourceFile);
}

// Streams `[fromOffset, EOF]`, chunks the new content, returns the byte offset
// for the next pass. Partial trailing content is preserved (newOffset stays
// before it) so the next call sees the line whole once flushed.
export function chunkStreaming(filepath, fromOffset, toolUseIdToName) {
  // Basename, not full path: the locator must be portable across machines and
  // the ~/.claude/projects/<encoded-cwd> tree — the basename is the globally
  // unique session id.
  const sourceFile = typeof filepath === 'string' ? basename(filepath) : null;
  const { records, newOffset } = readSinceOffset(filepath, fromOffset);
  return { chunks: chunkRecords(records, toolUseIdToName, sourceFile), newOffset };
}

export const __internal = { chunkRecords, bareToolName, parseInboxEvents };
