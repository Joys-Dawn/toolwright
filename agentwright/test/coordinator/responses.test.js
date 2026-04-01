'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { buildStageResponse, buildGroupResponse, initializeStageFiles } = require('../../coordinator/responses');
const { createRun, loadRun, updateStageStatus, updateGroupStatus } = require('../../coordinator/run-ledger');
const {
  stageMetaFile,
  stageVerifierFile,
  stageDecisionsFile,
  stageFindingsQueueFile,
  groupSnapshotFile,
  expectedGroupSnapshotPath
} = require('../../coordinator/paths');
const { readJson, writeJson } = require('../../coordinator/io');

describe('responses', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'responses-test-'));
    fs.mkdirSync(path.join(tmpDir, '.claude'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('buildStageResponse', () => {
    it('returns stage response with all expected fields', () => {
      const run = createRun(tmpDir, {
        pipelineName: null,
        groups: [['correctness']],
        stages: ['correctness'],
        scope: '--diff'
      });
      const stage = run.stages[0];
      const response = buildStageResponse(tmpDir, run, stage);
      assert.equal(response.ok, true);
      assert.equal(response.runId, run.runId);
      assert.equal(response.currentStage, 'correctness');
      assert.equal(response.scope, '--diff');
      assert.ok(response.findingsQueueFile);
      assert.ok(response.decisionsFile);
      assert.ok(response.metaFile);
      assert.ok(response.verifierFile);
      assert.ok(response.snapshotFile);
      assert.ok(response.logsDir);
    });

    it('merges extra fields', () => {
      const run = createRun(tmpDir, {
        pipelineName: null,
        groups: [['correctness']],
        stages: ['correctness'],
        scope: '--diff'
      });
      const stage = run.stages[0];
      const response = buildStageResponse(tmpDir, run, stage, { custom: 'value' });
      assert.equal(response.custom, 'value');
    });
  });

  describe('buildGroupResponse', () => {
    it('returns group response with activeStages array', () => {
      const run = createRun(tmpDir, {
        pipelineName: null,
        groups: [['correctness', 'security']],
        stages: ['correctness', 'security'],
        scope: '--diff'
      });
      const group = run.groups[0];
      const response = buildGroupResponse(tmpDir, run, group);
      assert.equal(response.ok, true);
      assert.equal(response.currentGroupIndex, 0);
      assert.equal(response.activeStages.length, 2);
      assert.ok(response.groupSnapshotFile);
    });

    it('sets currentStage when group has single stage', () => {
      const run = createRun(tmpDir, {
        pipelineName: null,
        groups: [['correctness']],
        stages: ['correctness'],
        scope: '--diff'
      });
      const group = run.groups[0];
      const response = buildGroupResponse(tmpDir, run, group);
      assert.equal(response.currentStage, 'correctness');
    });

    it('does not set currentStage for multi-stage groups', () => {
      const run = createRun(tmpDir, {
        pipelineName: null,
        groups: [['correctness', 'security']],
        stages: ['correctness', 'security'],
        scope: '--diff'
      });
      const group = run.groups[0];
      const response = buildGroupResponse(tmpDir, run, group);
      assert.equal(response.currentStage, undefined);
    });
  });

  describe('initializeStageFiles', () => {
    it('creates all stage files', () => {
      const run = createRun(tmpDir, {
        pipelineName: null,
        groups: [['correctness']],
        stages: ['correctness'],
        scope: '--diff'
      });

      initializeStageFiles(tmpDir, run, 'correctness', 0);

      // Queue file should be empty
      const queueContent = fs.readFileSync(stageFindingsQueueFile(tmpDir, run.runId, 'correctness'), 'utf8');
      assert.equal(queueContent, '');

      // Meta should have initial state
      const meta = readJson(stageMetaFile(tmpDir, run.runId, 'correctness'));
      assert.equal(meta.stage, 'correctness');
      assert.equal(meta.status, 'preparing_snapshot');
      assert.equal(meta.auditDone, false);
      assert.equal(meta.emittedCount, 0);

      // Verifier should be initialized
      const verifier = readJson(stageVerifierFile(tmpDir, run.runId, 'correctness'));
      assert.equal(verifier.stage, 'correctness');
      assert.equal(verifier.lastConsumedIndex, 0);
      assert.deepEqual(verifier.processedFindingIds, []);

      // Decisions should be empty
      const decisions = readJson(stageDecisionsFile(tmpDir, run.runId, 'correctness'));
      assert.equal(decisions.stage, 'correctness');
      assert.deepEqual(decisions.decisions, []);
    });
  });
});
