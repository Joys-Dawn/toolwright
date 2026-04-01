'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { isPidAlive, markDeadStageWorkers } = require('../../coordinator/health-check');
const { createRun, loadRun, mutateRun, updateStageStatus } = require('../../coordinator/run-ledger');
const { stageMetaFile, expectedGroupSnapshotPath, groupSnapshotFile } = require('../../coordinator/paths');
const { writeJson, readJson } = require('../../coordinator/io');

describe('health-check', () => {
  describe('isPidAlive', () => {
    it('returns true for the current process', () => {
      assert.equal(isPidAlive(process.pid), true);
    });

    it('returns false for a clearly dead PID', () => {
      // PID 99999999 is almost certainly not running
      assert.equal(isPidAlive(99999999), false);
    });

    it('returns false for invalid PIDs', () => {
      assert.equal(isPidAlive(0), false);
      assert.equal(isPidAlive(-1), false);
      assert.equal(isPidAlive(null), false);
      assert.equal(isPidAlive(undefined), false);
      assert.equal(isPidAlive('not-a-number'), false);
    });
  });

  describe('markDeadStageWorkers', () => {
    let tmpDir;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'health-test-'));
      fs.mkdirSync(path.join(tmpDir, '.claude'), { recursive: true });
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('returns empty array when no auditor entries exist', () => {
      const run = createRun(tmpDir, {
        pipelineName: null,
        groups: [['correctness']],
        stages: ['correctness'],
        scope: '--diff'
      });
      const result = markDeadStageWorkers(tmpDir, run);
      assert.deepEqual(result, []);
    });

    it('marks stage as failed when worker PID is dead', () => {
      const run = createRun(tmpDir, {
        pipelineName: null,
        groups: [['correctness']],
        stages: ['correctness'],
        scope: '--diff'
      });
      updateStageStatus(tmpDir, run.runId, 'correctness', 'auditing');

      // Write meta that is NOT yet done
      writeJson(stageMetaFile(tmpDir, run.runId, 'correctness'), {
        stage: 'correctness',
        status: 'auditing',
        auditDone: false,
        emittedCount: 0
      });

      // Register a dead worker PID
      mutateRun(tmpDir, run.runId, current => {
        current.auditor = {
          correctness: {
            workerPid: 99999999,
            pid: 99999998,
            stage: 'correctness',
            groupIndex: 0
          }
        };
        return current;
      });

      const result = markDeadStageWorkers(tmpDir, loadRun(tmpDir, run.runId));
      assert.deepEqual(result, ['correctness']);

      // Verify meta was updated
      const meta = readJson(stageMetaFile(tmpDir, run.runId, 'correctness'));
      assert.equal(meta.status, 'failed');
      assert.equal(meta.auditDone, true);
      assert.equal(meta.auditSucceeded, false);

      // Verify auditor entry was cleaned up
      const updated = loadRun(tmpDir, run.runId);
      assert.ok(!updated.auditor || !updated.auditor.correctness);
    });

    it('skips stages that are already done', () => {
      const run = createRun(tmpDir, {
        pipelineName: null,
        groups: [['correctness']],
        stages: ['correctness'],
        scope: '--diff'
      });
      updateStageStatus(tmpDir, run.runId, 'correctness', 'auditing');

      // Write meta that IS already done
      writeJson(stageMetaFile(tmpDir, run.runId, 'correctness'), {
        stage: 'correctness',
        status: 'done',
        auditDone: true,
        auditSucceeded: true,
        emittedCount: 3
      });

      mutateRun(tmpDir, run.runId, current => {
        current.auditor = {
          correctness: {
            workerPid: 99999999,
            stage: 'correctness',
            groupIndex: 0
          }
        };
        return current;
      });

      const result = markDeadStageWorkers(tmpDir, loadRun(tmpDir, run.runId));
      assert.deepEqual(result, [], 'Should not mark already-done stages');
    });

    it('skips stages with live worker PIDs', () => {
      const run = createRun(tmpDir, {
        pipelineName: null,
        groups: [['correctness']],
        stages: ['correctness'],
        scope: '--diff'
      });
      updateStageStatus(tmpDir, run.runId, 'correctness', 'auditing');

      writeJson(stageMetaFile(tmpDir, run.runId, 'correctness'), {
        stage: 'correctness',
        status: 'auditing',
        auditDone: false,
        emittedCount: 0
      });

      // Use the current process PID (alive)
      mutateRun(tmpDir, run.runId, current => {
        current.auditor = {
          correctness: {
            workerPid: process.pid,
            stage: 'correctness',
            groupIndex: 0
          }
        };
        return current;
      });

      const result = markDeadStageWorkers(tmpDir, loadRun(tmpDir, run.runId));
      assert.deepEqual(result, [], 'Should not mark stages with live workers');
    });
  });
});
