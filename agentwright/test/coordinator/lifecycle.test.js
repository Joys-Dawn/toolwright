'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  tryAdvanceGroup,
  validateCompletionResult,
  completeStage,
  stopRun
} = require('../../coordinator/lifecycle');
const {
  createRun,
  loadRun,
  updateStageStatus,
  updateGroupStatus,
  getCurrentGroup,
  mutateRun
} = require('../../coordinator/run-ledger');
const {
  stageMetaFile,
  stageDecisionsFile,
  stageFindingsQueueFile,
  stageVerifierFile,
  groupSnapshotFile,
  expectedGroupSnapshotPath,
  summaryFile
} = require('../../coordinator/paths');
const { writeJson, readJson, appendJsonLine } = require('../../coordinator/io');
const { setupRunForCompletion } = require('./helpers');

describe('lifecycle', () => {
  let tmpDir;
  let origCwd;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lifecycle-test-'));
    fs.mkdirSync(path.join(tmpDir, '.claude'), { recursive: true });
    origCwd = process.cwd();
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(origCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('validateCompletionResult', () => {
    it('accepts valid results', () => {
      assert.equal(validateCompletionResult('accepted'), 'accepted');
      assert.equal(validateCompletionResult('rejected'), 'rejected');
      assert.equal(validateCompletionResult('approval'), 'approval');
    });

    it('defaults to accepted for null/undefined', () => {
      assert.equal(validateCompletionResult(null), 'accepted');
      assert.equal(validateCompletionResult(undefined), 'accepted');
    });

    it('rejects invalid values', () => {
      assert.throws(() => validateCompletionResult('bad'), /Invalid completion result/);
    });
  });

  describe('tryAdvanceGroup', () => {
    it('advances when all stages in group are completed', () => {
      const run = createRun(tmpDir, {
        pipelineName: null,
        groups: [['correctness'], ['security']],
        stages: ['correctness', 'security'],
        scope: '--diff'
      });

      // Mark first group's stage as completed
      updateStageStatus(tmpDir, run.runId, 'correctness', 'completed');
      const loaded = loadRun(tmpDir, run.runId);

      const result = tryAdvanceGroup(loaded);
      assert.equal(result.groupCompleted, true);
      assert.equal(result.completedGroupIndex, 0);
      assert.equal(loaded.currentGroupIndex, 1);
    });

    it('does not advance when a stage is incomplete', () => {
      const run = createRun(tmpDir, {
        pipelineName: null,
        groups: [['correctness', 'security']],
        stages: ['correctness', 'security'],
        scope: '--diff'
      });

      updateStageStatus(tmpDir, run.runId, 'correctness', 'completed');
      // security still pending
      const loaded = loadRun(tmpDir, run.runId);

      const result = tryAdvanceGroup(loaded);
      assert.equal(result.groupCompleted, false);
    });

    it('sets run status to completed when last group finishes', () => {
      const run = createRun(tmpDir, {
        pipelineName: null,
        groups: [['correctness']],
        stages: ['correctness'],
        scope: '--diff'
      });

      updateStageStatus(tmpDir, run.runId, 'correctness', 'completed');
      const loaded = loadRun(tmpDir, run.runId);

      tryAdvanceGroup(loaded);
      assert.equal(loaded.status, 'completed');
    });
  });

  describe('completeStage', () => {
    it('completes a stage with zero findings', () => {
      const { runId } = setupRunForCompletion(tmpDir, 'correctness');
      writeJson(stageDecisionsFile(tmpDir, runId, 'correctness'), {
        stage: 'correctness',
        decisions: []
      });

      const result = completeStage(runId, 'correctness', 'accepted');
      assert.equal(result.ok, true);
      assert.equal(result.completedStage, 'correctness');
    });

    it('completes a stage with findings and matching decisions', () => {
      const { runId } = setupRunForCompletion(tmpDir, 'correctness', { findingsCount: 1 });

      // Write a finding to the queue
      appendJsonLine(stageFindingsQueueFile(tmpDir, runId, 'correctness'), {
        type: 'finding',
        finding: { id: 'c-1', severity: 'high', title: 'Bug', file: 'a.js', problem: 'p', fix: 'f' }
      });

      // Write matching decision
      writeJson(stageDecisionsFile(tmpDir, runId, 'correctness'), {
        stage: 'correctness',
        decisions: [{
          findingId: 'c-1',
          decision: 'valid',
          action: 'fixed',
          rationale: 'Fixed it'
        }]
      });

      const result = completeStage(runId, 'correctness', 'accepted');
      assert.equal(result.ok, true);

      // Stage should be completed
      const run = loadRun(tmpDir, runId);
      const stage = run.stages.find(s => s.name === 'correctness');
      assert.equal(stage.status, 'completed');
      assert.equal(stage.decisionsCount, 1);
    });

    it('throws when decisions do not match findings', () => {
      const { runId } = setupRunForCompletion(tmpDir, 'correctness', { findingsCount: 1 });

      appendJsonLine(stageFindingsQueueFile(tmpDir, runId, 'correctness'), {
        type: 'finding',
        finding: { id: 'c-1', severity: 'high', title: 'Bug', file: 'a.js', problem: 'p', fix: 'f' }
      });

      // Empty decisions — missing decision for c-1
      writeJson(stageDecisionsFile(tmpDir, runId, 'correctness'), {
        stage: 'correctness',
        decisions: []
      });

      assert.throws(() => completeStage(runId, 'correctness', 'accepted'), /do not match/);
    });

    it('throws when stage is not awaiting_verification_completion', () => {
      const run = createRun(tmpDir, {
        pipelineName: null,
        groups: [['correctness']],
        stages: ['correctness'],
        scope: '--diff'
      });
      // Stage is still 'pending', not 'awaiting_verification_completion'
      assert.throws(() => completeStage(run.runId, 'correctness', 'accepted'), /not ready for completion/);
    });

    it('updates summary with counts', () => {
      const { runId } = setupRunForCompletion(tmpDir, 'correctness', { findingsCount: 2 });

      appendJsonLine(stageFindingsQueueFile(tmpDir, runId, 'correctness'), {
        type: 'finding',
        finding: { id: 'c-1', severity: 'high', title: 'Bug', file: 'a.js', problem: 'p', fix: 'f' }
      });
      appendJsonLine(stageFindingsQueueFile(tmpDir, runId, 'correctness'), {
        type: 'finding',
        finding: { id: 'c-2', severity: 'low', title: 'Style', file: 'b.js', problem: 'p', fix: 'f' }
      });

      writeJson(stageDecisionsFile(tmpDir, runId, 'correctness'), {
        stage: 'correctness',
        decisions: [
          { findingId: 'c-1', decision: 'valid', action: 'fixed', rationale: 'done' },
          { findingId: 'c-2', decision: 'invalid', action: 'none', rationale: 'not a bug' }
        ]
      });

      completeStage(runId, 'correctness', 'accepted');

      const summary = readJson(summaryFile(tmpDir, runId));
      assert.ok(summary);
      const stageEntry = summary.completedStages.find(s => s.name === 'correctness');
      assert.equal(stageEntry.counts.valid, 1);
      assert.equal(stageEntry.counts.invalid, 1);
      assert.equal(stageEntry.counts.approval, 0);
      assert.equal(summary.rejectedFindings.length, 1);
      assert.equal(summary.rejectedFindings[0].findingId, 'c-2');
    });
  });

  describe('stopRun', () => {
    it('cancels a running run', () => {
      const run = createRun(tmpDir, {
        pipelineName: null,
        groups: [['correctness']],
        stages: ['correctness'],
        scope: '--diff'
      });
      updateStageStatus(tmpDir, run.runId, 'correctness', 'auditing');

      const result = stopRun(run.runId);
      assert.equal(result.ok, true);
      assert.equal(result.status, 'cancelled');

      const loaded = loadRun(tmpDir, run.runId);
      assert.equal(loaded.status, 'cancelled');
      assert.equal(loaded.stages[0].status, 'cancelled');
    });

    it('is idempotent on completed runs', () => {
      const run = createRun(tmpDir, {
        pipelineName: null,
        groups: [['correctness']],
        stages: ['correctness'],
        scope: '--diff'
      });
      updateStageStatus(tmpDir, run.runId, 'correctness', 'completed');
      mutateRun(tmpDir, run.runId, current => {
        current.status = 'completed';
        return current;
      });

      const result = stopRun(run.runId);
      assert.equal(result.ok, true);

      const loaded = loadRun(tmpDir, run.runId);
      assert.equal(loaded.status, 'completed');
      assert.equal(loaded.stages[0].status, 'completed');
    });
  });
});
