// Deterministic transcript filter ("chunker"). Same code path is used by
// the live hook write path (PreToolUse / Stop) AND by the consolidator's
// exchange-grouping step. No LLM is invoked here — every accept/reject and
// every exchange boundary is structural.
//
// Filter rules (DESIGN.md "Transcript filter"):
//   KEEP `user` records with plain-string content that is NOT a channel
//     doorbell (^<channel source=) → CLI prompt.
//   KEEP `assistant` records' `thinking` and `text` content blocks.
//   KEEP `assistant` records' `tool_use` blocks whose name (bare suffix
//     after the last '__') is in WRIGHTWARD_OUTBOUND_TOOLS.
//   KEEP `user` records' `tool_result` blocks whose originating tool_use_id
//     maps to WRIGHTWARD_INBOX_TOOL, but only the events whose `type` is in
//     INBOX_PRIMARY_EVENT_TYPES. ack / file_freed / delivery_failed are
//     dropped at this point — they're delivery mechanics, not signal.
//   DROP everything else: other top-level record types (attachment,
//     last-prompt, permission-mode, queue-operation, file-history-snapshot,
//     ai-title, system, ...), other tool_use blocks (Edit/Read/Bash/Glob/
//     Grep/...), tool_result blocks not from the inbox tool, compaction
//     summaries (isCompactSummary: true), and the autonomous-loop sentinels.
//
// Exchange grouping (DESIGN.md "Group rows into exchanges"):
//   An exchange opens on EITHER a real CLI user prompt OR an inbox event of
//   an INBOX_PRIMARY_EVENT_TYPES type. If multiple primary events are
//   batched in a single inbox dump, they form ONE combined opener.
//   Subsequent thinking / text / outbound-send chunks attach to the
//   currently-open exchange.

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

// Real wire names look like `mcp__plugin_wrightward_wrightward-bus__wrightward_send_message`.
// All we care about is the bare suffix after the final '__' delimiter.
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

// A wrightward_list_inbox tool_result wraps a JSON payload `{"events":[...]}`.
// Anthropic emits tool_result content as either a plain string or an array of
// content blocks where the first text block carries the payload. Be tolerant
// of both, and never throw on a malformed payload — return null.
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
    // Tool_result text wasn't JSON. Some inbox responses include other shapes
    // (tool_reference echoes, error envelopes); they carry no events.
  }
  return null;
}

// Inbox event types map straight onto kind names except for user_message,
// which becomes 'discord_user' to match the per-DESIGN.md schema enum and
// distinguish it from peer agent_message rows.
function kindForEventType(eventType) {
  if (eventType === 'user_message') return 'discord_user';
  return eventType;
}

function isoFromEventTs(ts, fallback) {
  if (typeof ts === 'number' && Number.isFinite(ts)) {
    // Bus events store ts as Unix ms (verified against
    // wrightward/lib/bus-schema.js createEvent — ts: Date.now()).
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
// survives across multiple chunkRecords calls within one session — required
// because a tool_use and its matching tool_result almost always land in
// different hook passes (the tool_use is in an assistant record consumed by
// PreToolUse, then the tool fires, then the tool_result appears in a later
// user record consumed by the next PreToolUse/Stop). A fresh per-call map
// would mis-classify every inbox tool_result as "unknown" and drop every
// wrightward bus event mindwright is built to ingest. The map is mutated in
// place so the caller can persist it after the call.
//
// Exchange grouping is NOT done here. The chunker once stamped chunks with a
// per-call exchange_id, but the schema has no exchange_id column and
// transcript-flush never persisted it; consolidator.groupIntoExchanges
// re-derives the grouping from STORED_EXCHANGE_OPENERS over persisted rows
// at drain time. Two parallel groupings risked drifting on edge cases
// (chunker bundled multi-primary inbox dumps into one exchange; consolidator
// opens one per opener-kind row). The single source of truth is the
// consolidator's pass.
// Recover a chunk-ready body string from an arbitrary bus event payload.
// Returns null on undecodable input so the caller can skip cleanly.
function recoverEventBody(body) {
  // wrightward bus schema declares body: string, but a malformed peer (or
  // older event version) could send an object or null.
  //  - null/undefined: skip — no recoverable content.
  //  - non-string: JSON.stringify so the payload is at least inspectable
  //    in the dropped-archive instead of stored as literal '[object Object]'.
  if (body == null) return null;
  if (typeof body === 'string') return body;
  try {
    return JSON.stringify(body);
  } catch (e) {
    // Cyclic / non-serializable. Drop the chunk but log to stderr so a
    // repeated pattern is visible to an operator — matches the
    // store.loadToolMap recovery convention.
    process.stderr.write(
      `[mindwright/chunker] dropping unserializable event body (${typeof body}): ${e && e.message ? e.message : e}\n`,
    );
    return null;
  }
}

// Durable provenance locator. A real Claude Code transcript record carries a
// stable `uuid` (verified present on every user/assistant record); pairing it
// with the transcript basename yields a locator that survives flush passes and
// re-seeding — unlike the within-batch `line:<lineIdx>` index, which is reset
// to 0 every pass (a fresh `records` slice) and so cannot trace a memory back
// to its origin. Multi-block records (assistant content arrays, batched inbox
// dumps) append `:b<bi>` so each emitted chunk stays unique. Bus events keep
// their own globally-unique `bus:<ev.id>` (handled at the call site). When a
// record has no uuid (rare non-conversation records the chunker mostly drops
// anyway), fall back to the legacy `line:` form — deterministic for a given
// parse and byte-identical to pre-change behavior for those records.
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

// User-record handler for string content — emits a single cli_prompt chunk
// or returns null (sentinel / doorbell — drop).
function userStringChunk(content, lineIdx, ts, sourceFile, uuid) {
  // Sentinel-only contents (autonomous-loop drivers) carry no real
  // user signal and must not open an exchange.
  const trimmed = content.trim();
  if (AUTONOMOUS_LOOP_SENTINELS.has(trimmed)) return null;
  // Channel-doorbell pings from wrightward et al. are delivery mechanics —
  // drop them; the actual inbox events arrive shortly after as tool_result
  // blocks.
  if (content.startsWith(CHANNEL_DOORBELL_PREFIX)) return null;
  return {
    kind: 'cli_prompt',
    content,
    source_ref: sourceRefFor(sourceFile, uuid, lineIdx, null),
    timestamp: ts,
    meta: {},
  };
}

// User-record handler for array content — walks each block, drops anything
// that isn't a wrightward inbox tool_result, and emits one chunk per
// primary bus event inside it.
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

// Assistant block dispatcher — returns one chunk or null. Mutates `map`
// for wrightward-inbox tool_use ids so the matching tool_result on a
// later record can be classified.
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
    // Only remember ids that name the wrightward inbox tool — those are
    // the only ones the tool_result lookup in userArrayChunks cares about.
    // Recording every Read/Edit/Bash id would let the persisted map grow
    // without bound on long autonomous-loop sessions and pay O(n) on
    // every flushTranscript pass.
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
  // Use a separate local so we never reassign the caller's parameter — that
  // would break the "mutated in place so the caller can persist it" contract
  // when the caller passed a non-Map (the local Map would diverge from
  // whatever the caller still holds).
  const map = toolUseIdToName instanceof Map ? toolUseIdToName : new Map();

  for (let lineIdx = 0; lineIdx < records.length; lineIdx++) {
    const rec = records[lineIdx];
    if (!rec || typeof rec !== 'object') continue;
    const ts = typeof rec.timestamp === 'string' ? rec.timestamp : null;
    // Stable per-record provenance id (verified present on every real
    // user/assistant Claude Code transcript record). null for the rare
    // record without one — sourceRefFor then falls back to the legacy
    // line: form, byte-identical to pre-change behavior for that record.
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
      // Other user-content shapes (null, number, object): drop silently.
      continue;
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

    // Anything else (attachment, last-prompt, queue-operation,
    // file-history-snapshot, permission-mode, ai-title, system, ...): drop.
  }

  return chunks;
}

// Public API ------------------------------------------------------------------

// Takes an array of raw JSONL line strings (the on-disk form). Parses each
// line; lines that fail to parse are dropped silently. The optional second
// argument is the persisted tool_use_id → tool_name map (see chunkRecords).
// `sourceFile` (the transcript basename) is threaded so emitted chunks carry
// a durable `<basename>:<uuid>` source_ref; omitted by callers that have no
// stable file identity (the legacy `line:` fallback then applies).
export function chunkTranscript(lines, toolUseIdToName, { sourceFile = null } = {}) {
  if (!Array.isArray(lines)) return [];
  const records = [];
  for (const line of lines) {
    if (typeof line !== 'string' || line.length === 0) continue;
    try {
      const obj = JSON.parse(line);
      if (obj && typeof obj === 'object') records.push(obj);
    } catch {
      // Drop invalid lines (matches transcript.js interior-line behavior).
    }
  }
  return chunkRecords(records, toolUseIdToName, sourceFile);
}

// Streams `[fromOffset, EOF]` of a transcript file, chunks the new content,
// and returns the byte offset to store for the next pass. Partial trailing
// content is preserved (newOffset stays before it) so the next call sees the
// line whole once it's flushed. `toolUseIdToName`, when provided, is mutated
// in place — pass the same Map across calls within one session and the
// chunker can classify a tool_result whose tool_use was consumed in an
// earlier hook pass.
export function chunkStreaming(filepath, fromOffset, toolUseIdToName) {
  // Basename, not the full path: the locator must be portable across machines
  // and the ~/.claude/projects/<encoded-cwd> tree (where the absolute prefix
  // differs per host) — the basename is the session id, globally unique.
  const sourceFile = typeof filepath === 'string' ? basename(filepath) : null;
  const { records, newOffset } = readSinceOffset(filepath, fromOffset);
  return { chunks: chunkRecords(records, toolUseIdToName, sourceFile), newOffset };
}

// Exported for tests so the same grouping logic can be exercised without
// re-deriving the wire-format boilerplate.
export const __internal = { chunkRecords, bareToolName, parseInboxEvents };
