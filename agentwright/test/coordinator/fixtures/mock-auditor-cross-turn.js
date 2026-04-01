#!/usr/bin/env node
'use strict';

// Mock auditor that emits prose in one content block and the done marker
// in a separate content block — reproducing the cross-turn buffer
// contamination bug where leftover prose text in the text-delta buffer
// prevents the done marker from being parsed.

const args = process.argv.slice(2);
const withFindings = args.includes('--with-findings');

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function textDelta(text) {
  emit({
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text }
    }
  });
}

function contentBlockStop() {
  emit({
    type: 'stream_event',
    event: { type: 'content_block_stop', index: 0 }
  });
}

function contentBlockStart(index) {
  emit({
    type: 'stream_event',
    event: {
      type: 'content_block_start',
      index,
      content_block: { type: 'text', text: '' }
    }
  });
}

function messageStop() {
  emit({ type: 'stream_event', event: { type: 'message_stop' } });
}

function messageStart() {
  emit({
    type: 'stream_event',
    event: {
      type: 'message_start',
      message: { role: 'assistant', content: [] }
    }
  });
}

// --- Turn 1: prose text WITHOUT a trailing newline ---
messageStart();
contentBlockStart(0);
textDelta('Now let me check the remaining in-scope files and relevant context files.');
// No trailing newline — this is the key trigger for the bug
contentBlockStop();
messageStop();

// --- Optional findings in a tool-use turn ---
if (withFindings) {
  messageStart();
  contentBlockStart(0);
  const f1 = JSON.stringify({
    type: 'finding',
    finding: {
      id: 'cross-1',
      severity: 'low',
      title: 'Test finding',
      file: 'a.js',
      problem: 'test',
      fix: 'test'
    }
  });
  textDelta(f1 + '\n');
  contentBlockStop();
  messageStop();
}

// --- Final turn: done marker ---
messageStart();
contentBlockStart(0);
const doneMarker = JSON.stringify({
  type: 'done',
  auditType: 'security',
  summary: 'No security findings in scope.',
  emittedCount: withFindings ? 1 : 0
});
textDelta(doneMarker);
// No trailing newline — will be flushed on process exit
contentBlockStop();
messageStop();

emit({
  type: 'result',
  is_error: false,
  result: doneMarker
});

process.exit(0);
