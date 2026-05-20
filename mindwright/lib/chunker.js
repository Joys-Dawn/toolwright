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

// Slash-command and task-notification artifacts that Claude Code emits as
// `user`-role records but are NOT user prompts. Storing them as cli_prompt
// pollutes recall — a /compact stdout line is not memory-worthy. Header-only
// match so subsequent tags inside the content don't accidentally promote a
// real prompt that happens to mention these words.
const FAKE_PROMPT_PREFIXES = [
  '<command-name>',      // Slash-command invocation block.
  '<command-message>',   // Slash-command preamble that lacks the <command-name> first.
  '<local-command-stdout>', // /context, /exit, /compact etc.'s rendered output.
  '<task-notification>', // Claude Code's Task-tool delegation completion ping.
];

// Bare tool name whose tool_result body we DO persist alongside the paired
// tool_use input. Everything else's result body is dropped (the agent's next
// thinking block carries its own interpretation). Bash is the only tool whose
// raw stdout/stderr regularly carries semantic signal — test failures, build
// errors, command output — at sizes (p50 ~86 tokens) that embed cleanly.
const PAIRED_RESULT_TOOLS = new Set(['Bash']);

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

// A wrightward_list_inbox tool_result wraps `{"events":[...]}`. The text-body
// extraction is shared with readToolResultText (defined below); this layer
// adds the JSON parse + events-array check, returning null on any malformed
// payload so the caller skips the row.
function parseInboxEvents(content) {
  const text = readToolResultText(content);
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
// tool_use_id → { name, input, source_ref, timestamp } map so a later
// tool_result can both be classified AND paired against the original tool_use
// (for the tool_call emission path), and emits a Chunk[].
//
// The caller MAY pass in an existing `toolMap` so the mapping survives across
// chunkRecords calls within one session — required because a tool_use and its
// matching tool_result almost always land in different hook passes. A fresh
// per-call map would mis-classify every inbox tool_result and lose every
// paired tool_call. Mutated in place so the caller can persist it (entries
// are removed once their tool_result has been processed).
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

function userStringChunk(content, lineIdx, ts, sourceFile, uuid, isMeta) {
  // rec.isMeta=true marks Claude Code-generated user records that aren't user
  // input: <local-command-caveat> preambles, /context output, etc. Always
  // drop — they're metadata, not prompts.
  if (isMeta === true) return null;
  const trimmed = content.trim();
  if (AUTONOMOUS_LOOP_SENTINELS.has(trimmed)) return null;
  // Channel-doorbell pings are delivery mechanics — drop; the actual inbox
  // events arrive shortly after as tool_result blocks.
  if (content.startsWith(CHANNEL_DOORBELL_PREFIX)) return null;
  // Slash-command artifacts (invocations + their rendered stdout) and Task-
  // tool completion notifications arrive as user-role records but the user
  // never typed them. They share four header tags; check after the trim so a
  // leading-newline /compact stdout still matches.
  const head = trimmed;
  for (const p of FAKE_PROMPT_PREFIXES) {
    if (head.startsWith(p)) return null;
  }
  return {
    kind: 'cli_prompt',
    content,
    source_ref: sourceRefFor(sourceFile, uuid, lineIdx, null),
    timestamp: ts,
    meta: {},
  };
}

// Read the raw text body out of a tool_result.content (either a plain string
// or an array of `{type:'text', text}` blocks). Shared with parseInboxEvents
// because both paths face the same multi-shape source.
function readToolResultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('');
  }
  return '';
}

// Format a paired tool_call chunk's content. The agent's recall surface sees
// this verbatim, so it's intentionally plain text (no JSON envelope): the
// tool name leads, then a stable `input:`/`result:` separator the embedder
// can latch onto.
//
// Storage is INTENTIONALLY UNCAPPED on both sides. A verbose Bash result or a
// large Edit/Write input lands in entries.content + FTS5 verbatim, by design:
// the agent should be able to recall its own actions in full, and a downstream
// truncation marker would mask that the full content is gone. The embedder
// truncates at its own 8192-token limit for vector representation, and the
// seed-loop's SEED_BATCH_BUDGET_BYTES bounds how many such rows a single
// consolidate pass swallows, but the raw on-disk text stays whole.
function formatToolCallContent(toolName, input, resultText, includeResult) {
  const inputJson = (() => {
    try {
      return JSON.stringify(input ?? {});
    } catch {
      // Cyclic / non-serializable — surface a placeholder rather than throw.
      return '{"_unserializable":true}';
    }
  })();
  const head = `${toolName} input: ${inputJson}`;
  if (!includeResult) return head;
  return `${head}\n${toolName} result: ${resultText}`;
}

function userArrayChunks(blocks, lineIdx, ts, map, sourceFile, uuid) {
  const out = [];
  for (let bi = 0; bi < blocks.length; bi++) {
    const block = blocks[bi];
    if (!block || block.type !== 'tool_result') continue;
    const id = block.tool_use_id;
    const pending = id != null ? map.get(id) : null;
    if (!pending) continue; // Orphan result — no matching tool_use in flight.
    const toolName = pending.name;
    // Two single-purpose paths share the toolMap; each is the OWNER of one
    // bare tool name so the dispatch is unambiguous.
    if (isInboxTool(toolName)) {
      // Inbox tool_result → decompose into per-event chunks; the tool_call
      // pairing is intentionally suppressed here (each event already becomes
      // its own discord_user/agent_message/etc row).
      const events = parseInboxEvents(block.content);
      // Remove the pending entry whether or not we extracted events: a
      // single inbox tool_use has exactly one result, and keeping the entry
      // around would leak across passes.
      map.delete(id);
      if (!Array.isArray(events) || events.length === 0) continue;
      for (const ev of events) {
        if (!ev || typeof ev.type !== 'string') continue;
        if (!INBOX_PRIMARY_EVENT_TYPES.includes(ev.type)) continue;
        const chunk = eventToChunk(ev, lineIdx, bi, ts, sourceFile, uuid);
        if (chunk) out.push(chunk);
      }
      continue;
    }
    // Generic tool pair: emit one tool_call chunk carrying the originating
    // tool_use input plus, for the allowlisted tools (Bash today), the raw
    // result body. Source_ref and timestamp come from the tool_use side so
    // the memory is anchored to when the agent ACTED, not when the result
    // happened to come back.
    const bare = bareToolName(toolName);
    const includeResult = PAIRED_RESULT_TOOLS.has(bare);
    // The raw Bash output is persisted verbatim — intentionally uncapped (see
    // formatToolCallContent above).
    const resultText = includeResult ? readToolResultText(block.content) : '';
    const content = formatToolCallContent(bare, pending.input, resultText, includeResult);
    out.push({
      kind: 'tool_call',
      content,
      source_ref: pending.source_ref || sourceRefFor(sourceFile, uuid, lineIdx, bi),
      timestamp: pending.timestamp || ts,
      meta: {
        tool: bare,
        tool_use_id: id,
        has_result: includeResult,
      },
    });
    map.delete(id);
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
    if (typeof block.id !== 'string' || typeof block.name !== 'string') return null;
    // Outbound wrightward sends emit their own dedicated chunk and never
    // enter the pairing buffer — their tool_result is just an ack with no
    // recall value, so a second `tool_call` row would be pure noise.
    if (isOutboundWrightward(block.name)) {
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
    // Everything else (inbox tool, MCP, Bash, Read, Edit, Write, Grep, Glob,
    // Agent, WebFetch/WebSearch, Task*, Skill, …) buffers the originating
    // tool_use in the toolMap so the late-arriving tool_result can either
    // (a) trigger the inbox-event decomposition path for list_inbox, or
    // (b) emit a paired tool_call chunk for everything else. No standalone
    // chunk is emitted here — the pairing IS the memory.
    map.set(block.id, {
      name: block.name,
      input: (block.input && typeof block.input === 'object') ? block.input : {},
      source_ref: sourceRefFor(sourceFile, uuid, lineIdx, bi),
      timestamp: ts,
    });
    return null;
  }
  return null; // unknown assistant block type
}

function chunkRecords(records, toolMap, sourceFile = null) {
  const chunks = [];
  // Separate local so we never reassign the caller's parameter — that would
  // break the "mutated in place so the caller can persist it" contract when
  // the caller passed a non-Map.
  const map = toolMap instanceof Map ? toolMap : new Map();

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
        const chunk = userStringChunk(content, lineIdx, ts, sourceFile, uuid, rec.isMeta);
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
// persisted tool_use_id → { name, input, source_ref, timestamp } map (see
// chunkRecords). `sourceFile` is threaded so chunks carry a durable
// `<basename>:<uuid>` source_ref.
export function chunkTranscript(lines, toolMap, { sourceFile = null } = {}) {
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
  return chunkRecords(records, toolMap, sourceFile);
}

// Streams `[fromOffset, EOF]`, chunks the new content, returns the byte offset
// for the next pass. Partial trailing content is preserved (newOffset stays
// before it) so the next call sees the line whole once flushed.
export function chunkStreaming(filepath, fromOffset, toolMap) {
  // Basename, not full path: the locator must be portable across machines and
  // the ~/.claude/projects/<encoded-cwd> tree — the basename is the globally
  // unique session id.
  const sourceFile = typeof filepath === 'string' ? basename(filepath) : null;
  const { records, newOffset } = readSinceOffset(filepath, fromOffset);
  return { chunks: chunkRecords(records, toolMap, sourceFile), newOffset };
}

export const __internal = { chunkRecords, bareToolName, parseInboxEvents };
