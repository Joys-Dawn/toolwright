'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { validateDecisions, updateSummary } = require('../../coordinator/decisions');
const { createRun } = require('../../coordinator/run-ledger');
const { appendJsonLine, readJson, writeJson } = require('../../coordinator/io');
const { stageFindingsQueueFile, summaryFile } = require('../../coordinator/paths');

function makeSpec() {
  return {
    pipelineName: 'test',
    groups: [['correctness']],
    stages: ['correctness'],
    scope: '--diff'
  };
}

function emitFinding(cwd, runId, stage, id) {
  appendJsonLine(stageFindingsQueueFile(cwd, runId, stage), {
    type: 'finding',
    finding: { id, severity: 'warning', title: 'test', file: 'a.js', problem: 'test' }
  });
}

describe('decisions', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'decisions-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('validateDecisions', () => {
    it('passes when decisions match emitted findings exactly', () => {
      const run = createRun(tmpDir, makeSpec());
      emitFinding(tmpDir, run.runId, 'correctness', 'f1');
      emitFinding(tmpDir, run.runId, 'correctness', 'f2');

      const decisions = {
        stage: 'correctness',
        decisions: [
          { findingId: 'f1', decision: 'valid', action: 'fixed', rationale: 'ok' },
          { findingId: 'f2', decision: 'invalid', action: 'none', rationale: 'no' }
        ]
      };

      assert.doesNotThrow(() => validateDecisions(tmpDir, run.runId, 'correctness', decisions));
    });

    it('throws when a finding has no corresponding decision', () => {
      const run = createRun(tmpDir, makeSpec());
      emitFinding(tmpDir, run.runId, 'correctness', 'f1');
      emitFinding(tmpDir, run.runId, 'correctness', 'f2');

      const decisions = {
        stage: 'correctness',
        decisions: [
          { findingId: 'f1', decision: 'valid', action: 'fixed', rationale: 'ok' }
        ]
      };

      assert.throws(
        () => validateDecisions(tmpDir, run.runId, 'correctness', decisions),
        /Missing: 1/
      );
    });

    it('throws on duplicate finding IDs in decisions', () => {
      const run = createRun(tmpDir, makeSpec());
      emitFinding(tmpDir, run.runId, 'correctness', 'f1');

      const decisions = {
        stage: 'correctness',
        decisions: [
          { findingId: 'f1', decision: 'valid', action: 'fixed', rationale: 'ok' },
          { findingId: 'f1', decision: 'invalid', action: 'none', rationale: 'dup' }
        ]
      };

      assert.throws(
        () => validateDecisions(tmpDir, run.runId, 'correctness', decisions),
        /duplicate: 1/
      );
    });

    it('throws on decisions for non-existent findings', () => {
      const run = createRun(tmpDir, makeSpec());
      emitFinding(tmpDir, run.runId, 'correctness', 'f1');

      const decisions = {
        stage: 'correctness',
        decisions: [
          { findingId: 'f1', decision: 'valid', action: 'fixed', rationale: 'ok' },
          { findingId: 'ghost', decision: 'invalid', action: 'none', rationale: 'no' }
        ]
      };

      assert.throws(
        () => validateDecisions(tmpDir, run.runId, 'correctness', decisions),
        /unexpected: 1/
      );
    });

    it('passes with empty findings and empty decisions', () => {
      const run = createRun(tmpDir, makeSpec());
      const decisions = { stage: 'correctness', decisions: [] };

      assert.doesNotThrow(() => validateDecisions(tmpDir, run.runId, 'correctness', decisions));
    });

    it('ignores non-finding events in the queue', () => {
      const run = createRun(tmpDir, makeSpec());
      appendJsonLine(stageFindingsQueueFile(tmpDir, run.runId, 'correctness'), {
        type: 'heartbeat', rawType: 'stream_event'
      });
      emitFinding(tmpDir, run.runId, 'correctness', 'f1');
      appendJsonLine(stageFindingsQueueFile(tmpDir, run.runId, 'correctness'), {
        type: 'done', auditType: 'correctness', emittedCount: 1
      });

      const decisions = {
        stage: 'correctness',
        decisions: [
          { findingId: 'f1', decision: 'valid', action: 'fixed', rationale: 'ok' }
        ]
      };

      assert.doesNotThrow(() => validateDecisions(tmpDir, run.runId, 'correctness', decisions));
    });

    it('skips findings with non-string IDs', () => {
      const run = createRun(tmpDir, makeSpec());
      appendJsonLine(stageFindingsQueueFile(tmpDir, run.runId, 'correctness'), {
        type: 'finding',
        finding: { id: 42, severity: 'warning', title: 'bad id' }
      });
      emitFinding(tmpDir, run.runId, 'correctness', 'f1');

      const decisions = {
        stage: 'correctness',
        decisions: [
          { findingId: 'f1', decision: 'valid', action: 'fixed', rationale: 'ok' }
        ]
      };

      assert.doesNotThrow(() => validateDecisions(tmpDir, run.runId, 'correctness', decisions));
    });
  });

  describe('updateSummary', () => {
    it('appends stage results to summary', () => {
      const run = createRun(tmpDir, makeSpec());
      const decisions = {
        stage: 'correctness',
        decisions: [
          { findingId: 'f1', decision: 'valid', action: 'fixed', rationale: 'ok' },
          { findingId: 'f2', decision: 'invalid', action: 'none', rationale: 'wrong' },
          { findingId: 'f3', decision: 'valid_needs_approval', action: 'none', rationale: 'broad' }
        ]
      };

      updateSummary(tmpDir, run.runId, 'correctness', decisions, 'accepted', '--diff');

      const summary = readJson(summaryFile(tmpDir, run.runId));
      assert.equal(summary.completedStages.length, 1);
      assert.equal(summary.completedStages[0].name, 'correctness');
      assert.equal(summary.completedStages[0].result, 'accepted');
      assert.deepStrictEqual(summary.completedStages[0].counts, { valid: 1, invalid: 1, approval: 1 });
      assert.equal(summary.rejectedFindings.length, 1);
      assert.equal(summary.rejectedFindings[0].findingId, 'f2');
      assert.equal(summary.pendingApprovals.length, 1);
      assert.equal(summary.pendingApprovals[0].findingId, 'f3');
    });

    it('accumulates across multiple stages', () => {
      const run = createRun(tmpDir, makeSpec());
      const d1 = {
        stage: 'correctness',
        decisions: [{ findingId: 'f1', decision: 'valid', action: 'fixed', rationale: 'ok' }]
      };
      const d2 = {
        stage: 'security',
        decisions: [{ findingId: 'f2', decision: 'invalid', action: 'none', rationale: 'no' }]
      };

      updateSummary(tmpDir, run.runId, 'correctness', d1, 'accepted', '--diff');
      updateSummary(tmpDir, run.runId, 'security', d2, 'accepted', '--diff');

      const summary = readJson(summaryFile(tmpDir, run.runId));
      assert.equal(summary.completedStages.length, 2);
      assert.equal(summary.rejectedFindings.length, 1);
      assert.equal(summary.rejectedFindings[0].stage, 'security');
    });

    it('handles empty decisions array', () => {
      const run = createRun(tmpDir, makeSpec());
      const decisions = { stage: 'correctness', decisions: [] };

      updateSummary(tmpDir, run.runId, 'correctness', decisions, 'accepted', '--diff');

      const summary = readJson(summaryFile(tmpDir, run.runId));
      assert.equal(summary.completedStages.length, 1);
      assert.deepStrictEqual(summary.completedStages[0].counts, { valid: 0, invalid: 0, approval: 0 });
      assert.equal(summary.rejectedFindings.length, 0);
      assert.equal(summary.pendingApprovals.length, 0);
    });
  });
});
