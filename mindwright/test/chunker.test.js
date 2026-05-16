// Chunker tests — one assertion per accept/reject rule plus a couple of
// integration cases. Fixtures live in test/fixtures/transcripts/ as small
// anonymized JSONL files; corruption / streaming cases are constructed in a
// temp dir so the assertions stay deterministic.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import { chunkTranscript, chunkStreaming } from '../lib/chunker.js';
import { readSinceOffset } from '../lib/transcript.js';
import {
  INBOX_PRIMARY_EVENT_TYPES,
  WRIGHTWARD_OUTBOUND_TOOLS,
  RRF_K,
  PER_RETRIEVER_N,
  RERANK_FLOOR,
  RECENCY_BOOST_DAYS,
} from '../lib/constants.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, 'fixtures', 'transcripts');

function loadLines(name) {
  const text = fs.readFileSync(path.join(FIXTURES, name), 'utf8');
  return text.split('\n').filter((l) => l.length > 0);
}

function tmpFile(name, body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-chunker-'));
  const p = path.join(dir, name);
  fs.writeFileSync(p, body);
  return p;
}

// ----- constants ------------------------------------------------------------

test('constants: numeric defaults match DESIGN.md', () => {
  assert.equal(RRF_K, 60);
  assert.equal(PER_RETRIEVER_N, 50);
  assert.equal(RERANK_FLOOR, 0.10);
  assert.equal(RECENCY_BOOST_DAYS, 14);
});

test('constants: INBOX_PRIMARY_EVENT_TYPES excludes delivery mechanics', () => {
  // Per wrightward/lib/bus-schema.js:26-34, URGENT_TYPES includes ack,
  // file_freed, and delivery_failed — mindwright must NOT treat those as
  // primary conversational signal.
  for (const t of ['user_message', 'agent_message', 'handoff', 'blocker', 'finding', 'decision']) {
    assert.ok(INBOX_PRIMARY_EVENT_TYPES.includes(t), `missing primary type: ${t}`);
  }
  for (const t of ['ack', 'file_freed', 'delivery_failed']) {
    assert.ok(!INBOX_PRIMARY_EVENT_TYPES.includes(t), `must not be primary: ${t}`);
  }
});

test('constants: WRIGHTWARD_OUTBOUND_TOOLS matches the four allowlisted names', () => {
  assert.deepEqual(
    [...WRIGHTWARD_OUTBOUND_TOOLS].sort(),
    ['wrightward_ack', 'wrightward_send_handoff', 'wrightward_send_message', 'wrightward_send_note'],
  );
});

// ----- accept/reject filter rules ------------------------------------------

test('KEEP cli user prompt with attached thinking + text', () => {
  const chunks = chunkTranscript(loadLines('cli_basic.jsonl'));
  assert.equal(chunks.length, 3);
  assert.deepEqual(
    chunks.map((c) => c.kind),
    ['cli_prompt', 'thinking', 'text'],
  );
  assert.equal(chunks[0].content, 'plan the next phase of mindwright');
  assert.equal(chunks[1].content, 'The user is asking for the next phase.');
  assert.equal(chunks[2].content, "Sure — I'll outline phase 4.");
});

test('DROP channel doorbell user record but keep the assistant thinking after it', () => {
  const chunks = chunkTranscript(loadLines('doorbell.jsonl'));
  // The doorbell user record is dropped; the subsequent assistant thinking is
  // kept. Grouping is the consolidator's job — chunker just emits the chunks.
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].kind, 'thinking');
});

test('KEEP outbound wrightward_send_message tool_use as outbound_send chunk', () => {
  const chunks = chunkTranscript(loadLines('outbound_send.jsonl'));
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].kind, 'cli_prompt');
  assert.equal(chunks[1].kind, 'outbound_send');
  assert.equal(chunks[1].content, 'hi from the agent');
  assert.equal(chunks[1].meta.tool, 'wrightward_send_message');
  assert.equal(chunks[1].meta.audience, 'user');
});

test('DROP non-allowlisted assistant tool_use blocks (Edit / Bash)', () => {
  const chunks = chunkTranscript(loadLines('blocklisted_tool_use.jsonl'));
  // CLI prompt is kept; Edit + Bash blocks are dropped → only one chunk.
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].kind, 'cli_prompt');
});

test('KEEP each primary inbox event type', () => {
  const chunks = chunkTranscript(loadLines('inbox_each_primary.jsonl'));
  // Five dumps, one primary event each → five chunks, each carrying the
  // correct kind. Exchange grouping happens later in the consolidator.
  assert.equal(chunks.length, 5);
  assert.deepEqual(
    chunks.map((c) => c.kind),
    ['agent_message', 'handoff', 'blocker', 'finding', 'decision'],
  );
});

test('user_message inbox event → discord_user kind', () => {
  const chunks = chunkTranscript(loadLines('inbox_user_message.jsonl'));
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].kind, 'discord_user');
  assert.equal(chunks[0].content, 'discord user body');
  assert.equal(chunks[0].meta.event_type, 'user_message');
});

test('Combined inbox dump with multiple primary events emits one chunk per event', () => {
  const chunks = chunkTranscript(loadLines('inbox_combined.jsonl'));
  // All three primary events from the single tool_result are emitted; the
  // chunker no longer bundles them into one exchange (the consolidator's
  // STORED_EXCHANGE_OPENERS pass handles grouping after persistence).
  assert.equal(chunks.length, 3);
});

test('inbox event with object body is JSON-stringified, never stored as "[object Object]"', () => {
  // Regression: ev.body was being coerced via String(ev.body ?? '') which
  // produces "[object Object]" for an object payload — opaque garbage that
  // pollutes recall, FTS, and the dropped-archive. Now: null/undefined body
  // → skip; non-string body → JSON.stringify so the payload is recoverable.
  const malformedEvent = {
    id: 'evt-malformed-1',
    type: 'user_message',
    from: 'someone-1234',
    to: 'me-5678',
    ts: '2026-05-13T01:00:00.000Z',
    body: { unexpected: 'object payload', items: [1, 2, 3] },
  };
  const lines = [
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-05-13T01:00:00.000Z',
      message: {
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: 'toolu_OBJ',
          name: 'mcp__plugin_wrightward_wrightward-bus__wrightward_list_inbox',
          input: {},
        }],
      },
    }),
    JSON.stringify({
      type: 'user',
      timestamp: '2026-05-13T01:00:00.500Z',
      message: {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'toolu_OBJ',
          content: [{ type: 'text', text: JSON.stringify({ events: [malformedEvent] }) }],
        }],
      },
    }),
  ];
  const chunks = chunkTranscript(lines);
  assert.equal(chunks.length, 1);
  assert.notEqual(chunks[0].content, '[object Object]');
  assert.match(chunks[0].content, /unexpected/);
  assert.match(chunks[0].content, /object payload/);
});

test('inbox event with null body is skipped, not stored as empty string', () => {
  const lines = [
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-05-13T01:00:00.000Z',
      message: {
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: 'toolu_NUL',
          name: 'mcp__plugin_wrightward_wrightward-bus__wrightward_list_inbox',
          input: {},
        }],
      },
    }),
    JSON.stringify({
      type: 'user',
      timestamp: '2026-05-13T01:00:00.500Z',
      message: {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'toolu_NUL',
          content: [{
            type: 'text',
            text: JSON.stringify({
              events: [{
                id: 'evt-null', type: 'user_message',
                from: 'a-1', to: 'b-2', ts: '2026-05-13T01:00:00.000Z',
                body: null,
              }],
            }),
          }],
        }],
      },
    }),
  ];
  assert.deepEqual(chunkTranscript(lines), []);
});

test('DROP non-primary inbox event types (ack / file_freed / delivery_failed)', () => {
  const chunks = chunkTranscript(loadLines('inbox_dropped.jsonl'));
  assert.equal(chunks.length, 0);
});

test('DROP autonomous-loop sentinel records (both static and dynamic forms)', () => {
  const chunks = chunkTranscript(loadLines('autonomous_loop.jsonl'));
  assert.equal(chunks.length, 0);
});

test('DROP isCompactSummary records but keep the user prompt that follows', () => {
  const chunks = chunkTranscript(loadLines('compaction_summary.jsonl'));
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].kind, 'cli_prompt');
  assert.equal(chunks[0].content, 'continue from where we left off');
});

// ----- chunk ordering / inbox-followed-by-thinking --------------------------

test('Inbox event chunk emits before subsequent assistant thinking chunk', () => {
  const records = [
    {
      type: 'assistant',
      timestamp: '2026-05-13T01:00:00.000Z',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_X',
            name: 'mcp__plugin_wrightward_wrightward-bus__wrightward_list_inbox',
            input: {},
          },
        ],
      },
    },
    {
      type: 'user',
      timestamp: '2026-05-13T01:00:00.500Z',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_X',
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  events: [
                    {
                      id: 'evX',
                      ts: 1778646000000,
                      from: 'sam-17',
                      to: 'ray-2633',
                      type: 'handoff',
                      body: 'opener',
                      meta: {},
                    },
                  ],
                }),
              },
            ],
          },
        ],
      },
    },
    {
      type: 'assistant',
      timestamp: '2026-05-13T01:00:01.000Z',
      message: {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: 'reasoning about the handoff' }],
      },
    },
  ];
  const lines = records.map((r) => JSON.stringify(r));
  const chunks = chunkTranscript(lines);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].kind, 'handoff');
  assert.equal(chunks[1].kind, 'thinking');
});

// ----- chunkTranscript / chunkStreaming robustness --------------------------

test('chunkTranscript drops invalid lines silently', () => {
  const lines = [
    '{"type":"user","message":{"role":"user","content":"hello"}}',
    'not valid json {',
    '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"ok"}]}}',
  ];
  const chunks = chunkTranscript(lines);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].kind, 'cli_prompt');
  assert.equal(chunks[1].kind, 'text');
});

test('chunkTranscript([]) and non-array input return []', () => {
  assert.deepEqual(chunkTranscript([]), []);
  assert.deepEqual(chunkTranscript(null), []);
  assert.deepEqual(chunkTranscript(undefined), []);
});

test('chunkStreaming reads from offset and reports new byte offset', () => {
  const body = fs.readFileSync(path.join(FIXTURES, 'cli_basic.jsonl'), 'utf8');
  const p = tmpFile('cli.jsonl', body);
  const first = chunkStreaming(p, 0);
  assert.equal(first.chunks.length, 3);
  assert.equal(first.newOffset, fs.statSync(p).size);
  // A second call with the previous offset has no new content.
  const second = chunkStreaming(p, first.newOffset);
  assert.equal(second.chunks.length, 0);
  assert.equal(second.newOffset, first.newOffset);
});

test('chunkStreaming on missing file → { chunks: [], newOffset: 0 }', () => {
  const r = chunkStreaming(path.join(os.tmpdir(), 'mw-does-not-exist-' + Date.now()), 0);
  assert.deepEqual(r.chunks, []);
  assert.equal(r.newOffset, 0);
});

test('chunkStreaming persists tool_use_id→name across passes — inbox tool_result arriving in a later pass is still classified', () => {
  // Regression for the silent-drop bug: in normal Claude Code flow, the
  // PreToolUse hook fires AFTER the assistant emits a tool_use(list_inbox)
  // and BEFORE the tool actually runs — so the first hook pass advances the
  // offset past the tool_use line. The tool then runs and the matching
  // tool_result is appended to the transcript as part of the NEXT user
  // record. A later hook pass sees only that user record. Without a
  // persisted map, the chunker has no way to learn that tool_use_id
  // toolu_LATE was list_inbox, and silently drops the inbox events.
  const assistantLine = JSON.stringify({
    type: 'assistant',
    timestamp: '2026-05-13T02:00:00.000Z',
    message: {
      role: 'assistant',
      content: [{
        type: 'tool_use',
        id: 'toolu_LATE',
        name: 'mcp__plugin_wrightward_wrightward-bus__wrightward_list_inbox',
        input: {},
      }],
    },
  }) + '\n';
  const userLine = JSON.stringify({
    type: 'user',
    timestamp: '2026-05-13T02:00:01.000Z',
    message: {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: 'toolu_LATE',
        content: [{
          type: 'text',
          text: JSON.stringify({
            events: [{
              id: 'evt-late', type: 'user_message',
              from: 'someone-1234', to: 'me-5678',
              ts: '2026-05-13T02:00:00.500Z',
              body: 'hello from a previous pass',
            }],
          }),
        }],
      }],
    },
  }) + '\n';
  // First pass: only the assistant line exists in the transcript.
  const p = tmpFile('split.jsonl', assistantLine);
  const toolMap = new Map();
  const first = chunkStreaming(p, 0, toolMap);
  // The tool_use is non-outbound so it produces no chunks, but the map MUST
  // have recorded the id → name mapping for the next pass.
  assert.equal(first.chunks.length, 0);
  assert.equal(toolMap.get('toolu_LATE'), 'mcp__plugin_wrightward_wrightward-bus__wrightward_list_inbox');
  // Second pass: tool_result is appended; offset advances from the first
  // pass's newOffset. The same map is reused.
  fs.appendFileSync(p, userLine);
  const second = chunkStreaming(p, first.newOffset, toolMap);
  assert.equal(second.chunks.length, 1, 'inbox event must survive a cross-pass split');
  assert.equal(second.chunks[0].kind, 'discord_user');
  assert.match(second.chunks[0].content, /hello from a previous pass/);
  // And without the persisted map (fresh empty map for the same second
  // pass), the inbox event would be dropped — that's the bug this guards.
  const freshMap = new Map();
  const naive = chunkStreaming(p, first.newOffset, freshMap);
  assert.equal(naive.chunks.length, 0, 'without persisted map the chunker silently drops the inbox event');
});

test('readSinceOffset: partial trailing line is NOT committed (offset stays before it)', () => {
  const fullLine =
    '{"type":"user","message":{"role":"user","content":"complete"}}\n';
  const partial = '{"type":"user","mes';
  const p = tmpFile('partial.jsonl', fullLine + partial);
  const r = readSinceOffset(p, 0);
  assert.equal(r.records.length, 1);
  // newOffset must stop right after the first \n, leaving the partial line
  // in place so the next pass picks it up whole.
  assert.equal(r.newOffset, Buffer.byteLength(fullLine, 'utf8'));
});

test('readSinceOffset: interior corrupted line is skipped, offset advances past it', () => {
  const body =
    '{"type":"user","message":{"role":"user","content":"a"}}\n' +
    '{this is not valid json}\n' +
    '{"type":"user","message":{"role":"user","content":"b"}}\n';
  const p = tmpFile('mid_corrupt.jsonl', body);
  const r = readSinceOffset(p, 0);
  assert.equal(r.records.length, 2);
  assert.equal(r.newOffset, Buffer.byteLength(body, 'utf8'));
});

test('readSinceOffset: out-of-range offset (rotation / truncation) restarts from 0', () => {
  const body = '{"type":"user","message":{"role":"user","content":"x"}}\n';
  const p = tmpFile('rotate.jsonl', body);
  // Pretend the previous offset was beyond EOF (file was rotated/truncated).
  const r = readSinceOffset(p, 999999);
  assert.equal(r.records.length, 1);
  assert.equal(r.newOffset, Buffer.byteLength(body, 'utf8'));
});

test('readSinceOffset: missing file returns offset 0 not file size', () => {
  const p = path.join(os.tmpdir(), 'mw-no-file-' + Date.now() + '.jsonl');
  const r = readSinceOffset(p, 0);
  assert.deepEqual(r, { records: [], newOffset: 0 });
});

test('readSinceOffset: bounded read does not allocate a multi-pass buffer in one shot', () => {
  // MAX_READ_PER_PASS is 16 MiB inside lib/transcript.js. Build a transcript
  // ~17 MiB so a single pass cannot cover it — the cap must force a second
  // pass and the partial-line accounting must keep advancing only past \n
  // boundaries (no torn records).
  const lineTemplate = '{"type":"user","message":{"role":"user","content":"';
  const lineTail = '"}}\n';
  // ~64 KiB per line × ~260 lines ≈ 17 MiB. Each line ends with \n so every
  // line is fully terminated; the boundary cap will land mid-line in pass 1.
  const padLen = 64 * 1024 - (lineTemplate.length + lineTail.length);
  const pad = 'x'.repeat(padLen);
  const oneLine = lineTemplate + pad + lineTail;
  const lines = [];
  let totalBytes = 0;
  while (totalBytes < 17 * 1024 * 1024) {
    lines.push(oneLine);
    totalBytes += Buffer.byteLength(oneLine, 'utf8');
  }
  const body = lines.join('');
  const p = tmpFile('big_transcript.jsonl', body);

  const fileSize = Buffer.byteLength(body, 'utf8');
  // First pass: must read no more than the cap; must advance offset; must
  // produce at least one parsed record.
  const r1 = readSinceOffset(p, 0);
  assert.ok(r1.records.length > 0, 'first pass produced no records');
  assert.ok(r1.newOffset > 0, 'first pass did not advance offset');
  assert.ok(
    r1.newOffset < fileSize,
    `expected partial first pass; got newOffset=${r1.newOffset} fileSize=${fileSize}`,
  );

  // Second pass picks up where the first left off and reaches EOF (no torn
  // records, no skipped bytes).
  const r2 = readSinceOffset(p, r1.newOffset);
  assert.equal(r2.newOffset, fileSize, 'second pass did not reach EOF');
  // Total record count across both passes matches the file's line count.
  assert.equal(
    r1.records.length + r2.records.length,
    lines.length,
    'records were lost across the read cap boundary',
  );
});

test('readSinceOffset: oversized JSONL line beyond the cap is skipped (no infinite no-progress loop)', () => {
  // Regression: when a single JSONL record exceeds MAX_READ_PER_PASS, the
  // first read returns the cap-sized prefix with no '\n'. The old code
  // produced committedBytes=0 and returned newOffset=from — every subsequent
  // pass repeated the same read forever, permanently blocking transcript
  // ingest from that offset onward. The fix: detect (no newline, cap hit,
  // more file beyond) and advance past the cap so ingest can recover.
  //
  // Use a small maxReadPerPass override (64 B) so the test runs in
  // milliseconds instead of needing a 16 MiB fixture.
  const SMALL_CAP = 64;
  const oversized = 'x'.repeat(SMALL_CAP * 3); // 192 bytes, no newline
  const goodLine = '{"type":"user","message":{"role":"user","content":"after"}}\n';
  const body = oversized + '\n' + goodLine;
  const p = tmpFile('oversized.jsonl', body);

  // First pass: oversized line dominates the read window — advance past
  // the cap (committedBytes = SMALL_CAP) without producing any records.
  const r1 = readSinceOffset(p, 0, { maxReadPerPass: SMALL_CAP });
  assert.equal(r1.records.length, 0);
  assert.equal(r1.newOffset, SMALL_CAP, `expected newOffset to advance past the cap; got ${r1.newOffset}`);

  // Keep iterating; each pass advances by another SMALL_CAP until the next
  // newline lands inside the read window. Bound the loop tightly so a
  // regression that re-introduces the no-progress bug fails fast instead
  // of timing out.
  let offset = r1.newOffset;
  let totalRecords = 0;
  for (let i = 0; i < 20; i++) {
    const r = readSinceOffset(p, offset, { maxReadPerPass: SMALL_CAP });
    if (r.newOffset === offset) {
      assert.fail(`no-progress regression at offset ${offset} after ${i} iterations`);
    }
    offset = r.newOffset;
    totalRecords += r.records.length;
    if (offset === Buffer.byteLength(body, 'utf8')) break;
  }
  assert.equal(offset, Buffer.byteLength(body, 'utf8'), 'ingest must reach EOF');
  assert.equal(totalRecords, 1, 'the good line after the oversized record must be parsed');
});

// ----- bare-tool-name matching ---------------------------------------------

test('Bare-tool-name matching handles both old and new MCP namespacing', () => {
  // The chunker has to recognize outbound sends whether the wire name is
  // `mcp__wrightward-bus__wrightward_send_message` (older) or
  // `mcp__plugin_wrightward_wrightward-bus__wrightward_send_message` (newer).
  const lines = [
    JSON.stringify({
      type: 'user',
      timestamp: '2026-05-13T01:00:00.000Z',
      message: { role: 'user', content: 'k' },
    }),
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-05-13T01:00:01.000Z',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'a',
            name: 'mcp__wrightward-bus__wrightward_send_note',
            input: { audience: 'all', body: 'old style' },
          },
          {
            type: 'tool_use',
            id: 'b',
            name: 'mcp__plugin_wrightward_wrightward-bus__wrightward_send_handoff',
            input: { audience: 'sam-17', body: 'new style' },
          },
        ],
      },
    }),
  ];
  const chunks = chunkTranscript(lines);
  assert.equal(chunks.length, 3);
  assert.equal(chunks[1].kind, 'outbound_send');
  assert.equal(chunks[1].meta.tool, 'wrightward_send_note');
  assert.equal(chunks[2].kind, 'outbound_send');
  assert.equal(chunks[2].meta.tool, 'wrightward_send_handoff');
});

// ----- tool_result classification edge cases --------------------------------

test('tool_result whose tool_use_id maps to a non-inbox tool is dropped', () => {
  // Assistant calls a non-inbox tool (e.g. Read). The user record carrying
  // that tool_result must NOT be parsed as inbox events even if its content
  // happens to look JSON-shaped.
  const lines = [
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-05-13T01:00:00.000Z',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_READ',
            name: 'Read',
            input: { file_path: '/tmp/x' },
          },
        ],
      },
    }),
    JSON.stringify({
      type: 'user',
      timestamp: '2026-05-13T01:00:00.500Z',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_READ',
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  events: [
                    { id: 'spoof', ts: 0, type: 'handoff', body: 'should not appear', meta: {} },
                  ],
                }),
              },
            ],
          },
        ],
      },
    }),
  ];
  const chunks = chunkTranscript(lines);
  assert.equal(chunks.length, 0);
});

test('inbox tool_result with malformed inner JSON yields no chunks', () => {
  const lines = [
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-05-13T01:00:00.000Z',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_MAL',
            name: 'mcp__plugin_wrightward_wrightward-bus__wrightward_list_inbox',
            input: {},
          },
        ],
      },
    }),
    JSON.stringify({
      type: 'user',
      timestamp: '2026-05-13T01:00:00.500Z',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_MAL',
            content: [{ type: 'text', text: 'not json at all' }],
          },
        ],
      },
    }),
  ];
  assert.deepEqual(chunkTranscript(lines), []);
});

test('mixed transcript: doorbell dropped, real prompt opens exchange, outbound send attaches', () => {
  // Realistic mixed flow: doorbell → list_inbox tool_use → inbox dump with
  // one ack only (dropped) → CLI prompt → assistant text → outbound send.
  const lines = [
    JSON.stringify({
      type: 'user',
      timestamp: '2026-05-13T01:00:00.000Z',
      message: { role: 'user', content: '<channel source="wrightward-bus" pending_count="1">\n</channel>' },
      origin: { kind: 'channel', server: 'wrightward-bus' },
    }),
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-05-13T01:00:01.000Z',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_LB',
            name: 'mcp__plugin_wrightward_wrightward-bus__wrightward_list_inbox',
            input: {},
          },
        ],
      },
    }),
    JSON.stringify({
      type: 'user',
      timestamp: '2026-05-13T01:00:01.500Z',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_LB',
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  events: [
                    { id: 'ack1', ts: 0, type: 'ack', body: 'a', meta: {} },
                  ],
                }),
              },
            ],
          },
        ],
      },
    }),
    JSON.stringify({
      type: 'user',
      timestamp: '2026-05-13T01:01:00.000Z',
      message: { role: 'user', content: 'now do the work' },
    }),
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-05-13T01:01:01.000Z',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'on it' },
          {
            type: 'tool_use',
            id: 'toolu_SND',
            name: 'mcp__plugin_wrightward_wrightward-bus__wrightward_send_message',
            input: { audience: 'user', body: 'starting' },
          },
        ],
      },
    }),
  ];
  const chunks = chunkTranscript(lines);
  // Expected: [cli_prompt, text, outbound_send] in order.
  assert.equal(chunks.length, 3);
  assert.deepEqual(chunks.map((c) => c.kind), ['cli_prompt', 'text', 'outbound_send']);
});

// ----- durable source_ref (event-time provenance overhaul) ------------------

test('chunkStreaming stamps transcript chunks with <basename>:<uuid> locators', () => {
  // The locator must survive flush passes and re-seeding, so it pairs the
  // transcript basename (chunkStreaming derives it from the file path) with
  // the record's stable uuid. Multi-block assistant records suffix :b<bi> so
  // each emitted chunk stays unique.
  const records = [
    {
      type: 'user',
      uuid: 'u-cli-1',
      timestamp: '2026-05-13T01:00:00.000Z',
      message: { role: 'user', content: 'plan the next phase' },
    },
    {
      type: 'assistant',
      uuid: 'a-1',
      timestamp: '2026-05-13T01:00:01.000Z',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'pondering' },
          { type: 'text', text: 'here is the plan' },
        ],
      },
    },
  ];
  const body = records.map((r) => JSON.stringify(r)).join('\n') + '\n';
  const p = tmpFile('sess-7f3a2b.jsonl', body);

  const { chunks } = chunkStreaming(p, 0);

  assert.equal(chunks.length, 3);
  assert.equal(chunks[0].kind, 'cli_prompt');
  assert.equal(chunks[0].source_ref, 'sess-7f3a2b.jsonl:u-cli-1');
  assert.equal(chunks[1].kind, 'thinking');
  assert.equal(chunks[1].source_ref, 'sess-7f3a2b.jsonl:a-1:b0');
  assert.equal(chunks[2].kind, 'text');
  assert.equal(chunks[2].source_ref, 'sess-7f3a2b.jsonl:a-1:b1');
});

test('bus event source_ref stays bus:<id> regardless of file/uuid threading', () => {
  // A wrightward bus event carries its own globally-unique id; threading the
  // transcript basename + record uuid must NOT override it (the durable
  // locator for an event is the bus id, not where it happened to be dumped).
  const records = [
    {
      type: 'assistant',
      uuid: 'a-lb',
      timestamp: '2026-05-13T01:00:00.000Z',
      message: {
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: 'toolu_LB',
          name: 'mcp__plugin_wrightward_wrightward-bus__wrightward_list_inbox',
          input: {},
        }],
      },
    },
    {
      type: 'user',
      uuid: 'u-res',
      timestamp: '2026-05-13T01:00:01.000Z',
      message: {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'toolu_LB',
          content: [{
            type: 'text',
            text: JSON.stringify({
              events: [{
                id: 'evt-bus-9', type: 'agent_message',
                from: 'sam-17', to: 'ray-2',
                ts: '2026-05-13T01:00:00.500Z',
                body: 'peer ping',
              }],
            }),
          }],
        }],
      },
    },
  ];
  const body = records.map((r) => JSON.stringify(r)).join('\n') + '\n';
  const p = tmpFile('sess-bus.jsonl', body);

  const { chunks } = chunkStreaming(p, 0);

  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].kind, 'agent_message');
  assert.equal(chunks[0].source_ref, 'bus:evt-bus-9');
});

test('record without uuid falls back to deterministic line:<lineIdx> (byte-identical to pre-change)', () => {
  // The locator must never throw on a record missing uuid (rare
  // non-conversation records). Even when a sourceFile is supplied, a missing
  // uuid falls back to the legacy `line:` form so behavior for those records
  // is byte-identical to before this change — no basename prefix, no break.
  const records = [
    {
      type: 'user',
      timestamp: '2026-05-13T01:00:00.000Z',
      message: { role: 'user', content: 'no uuid here' },
    },
    {
      type: 'assistant',
      timestamp: '2026-05-13T01:00:01.000Z',
      message: {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: 'still no uuid' }],
      },
    },
  ];
  const lines = records.map((r) => JSON.stringify(r));

  const chunks = chunkTranscript(lines, undefined, { sourceFile: 'x.jsonl' });

  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].source_ref, 'line:0');
  assert.equal(chunks[1].source_ref, 'line:1:b0');
});

test('chunkTranscript without a sourceFile emits a bare <uuid> locator (no basename prefix)', () => {
  // chunkTranscript's sourceFile is optional; a caller with no stable file
  // identity still gets a durable per-record locator from the uuid alone.
  const records = [
    {
      type: 'user',
      uuid: 'u-2',
      timestamp: '2026-05-13T01:00:00.000Z',
      message: { role: 'user', content: 'hello' },
    },
    {
      type: 'assistant',
      uuid: 'a-9',
      timestamp: '2026-05-13T01:00:01.000Z',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'hi' }],
      },
    },
  ];
  const lines = records.map((r) => JSON.stringify(r));

  const chunks = chunkTranscript(lines);

  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].source_ref, 'u-2');
  assert.equal(chunks[1].source_ref, 'a-9:b0');
});
