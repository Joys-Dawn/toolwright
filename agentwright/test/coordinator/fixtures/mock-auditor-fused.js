#!/usr/bin/env node
'use strict';

// Mock fused-stage auditor: emits stream-json events to stdout with three
// findings tagged by different auditType values, then the done marker.
// Mirrors mock-auditor.js so the same parsing harness can consume both.
// Usage: node mock-auditor-fused.js [--fail] [--no-done] [--missing-type]
//   --missing-type: omit auditType on the second finding to exercise the
//                   graceful-degradation path.

const args = process.argv.slice(2);
const shouldFail = args.includes('--fail');
const noDone = args.includes('--no-done');
const missingType = args.includes('--missing-type');

const findings = [
  {
    type: 'finding',
    finding: {
      id: 'audit-bundle-1',
      auditType: 'correctness-audit',
      severity: 'high',
      title: 'Off-by-one loop bound',
      file: 'src/loop.js',
      problem: 'Loop runs one extra iteration',
      fix: 'Change <= to <'
    }
  },
  {
    type: 'finding',
    finding: {
      id: 'audit-bundle-2',
      ...(missingType ? {} : { auditType: 'security-audit' }),
      severity: 'critical',
      title: 'Unsanitized SQL parameter',
      file: 'src/db.js',
      problem: 'Direct string concatenation into SQL',
      fix: 'Use parameterized query'
    }
  },
  {
    type: 'finding',
    finding: {
      id: 'audit-bundle-3',
      auditType: 'best-practices-audit',
      severity: 'low',
      title: 'Magic number used as timeout',
      file: 'src/util.js',
      problem: '5000 appears with no name',
      fix: 'Extract DEFAULT_TIMEOUT_MS constant'
    }
  }
];

const doneMarker = {
  type: 'done',
  auditType: 'audit-bundle',
  summary: 'Found 3 findings across 3 audit types.',
  emittedCount: 3
};

function emitStreamEvent(text) {
  process.stdout.write(JSON.stringify({
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      delta: { type: 'text_delta', text }
    }
  }) + '\n');
}

function emitResult(isError) {
  process.stdout.write(JSON.stringify({
    type: 'result',
    is_error: isError,
    result: isError ? 'Auditor failed.' : ''
  }) + '\n');
}

if (shouldFail) {
  emitResult(true);
  process.exit(1);
}

for (const finding of findings) {
  emitStreamEvent(JSON.stringify(finding) + '\n');
}
if (!noDone) {
  emitStreamEvent(JSON.stringify(doneMarker) + '\n');
}
emitResult(false);
process.exit(0);
