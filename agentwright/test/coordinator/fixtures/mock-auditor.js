#!/usr/bin/env node
'use strict';

// Mock auditor that emits stream-json events to stdout like the real Claude CLI.
// Usage: node mock-auditor.js [--fail] [--no-done] [--timeout <ms>]

const args = process.argv.slice(2);
const shouldFail = args.includes('--fail');
const noDone = args.includes('--no-done');
const timeoutIndex = args.indexOf('--timeout');
const timeoutMs = timeoutIndex >= 0 ? Number(args[timeoutIndex + 1]) : 0;

const finding1 = {
  type: 'finding',
  finding: {
    id: 'mock-1',
    severity: 'high',
    title: 'Mock finding one',
    file: 'src/app.js',
    problem: 'Test problem',
    fix: 'Test fix'
  }
};

const finding2 = {
  type: 'finding',
  finding: {
    id: 'mock-2',
    severity: 'low',
    title: 'Mock finding two',
    file: 'src/utils.js',
    problem: 'Another problem',
    fix: 'Another fix'
  }
};

const doneMarker = {
  type: 'done',
  auditType: 'mock-stage',
  summary: 'Found 2 mock issues.',
  emittedCount: 2
};

function emitStreamEvent(content) {
  // Wrap text in stream-json format like the real Claude CLI
  const event = {
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      delta: {
        type: 'text_delta',
        text: content
      }
    }
  };
  process.stdout.write(JSON.stringify(event) + '\n');
}

function emitResult(isError) {
  const event = {
    type: 'result',
    is_error: isError,
    result: isError ? 'Auditor failed.' : ''
  };
  process.stdout.write(JSON.stringify(event) + '\n');
}

function run() {
  if (timeoutMs > 0) {
    setTimeout(run, timeoutMs);
    return;
  }

  if (shouldFail) {
    emitResult(true);
    process.exit(1);
  }

  emitStreamEvent(JSON.stringify(finding1) + '\n');
  emitStreamEvent(JSON.stringify(finding2) + '\n');
  if (!noDone) {
    emitStreamEvent(JSON.stringify(doneMarker) + '\n');
  }
  emitResult(false);
  process.exit(0);
}

run();
