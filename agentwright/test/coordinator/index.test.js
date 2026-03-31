'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { createRun, loadRun, updateStageStatus, updateGroupStatus, mutateRun } = require('../../coordinator/run-ledger');
const {
  runFile,
  stageMetaFile,
  stageFindingsQueueFile,
  stageDecisionsFile,
  stageVerifierFile,
  stageLogsDir,
  groupSnapshotFile,
  summaryFile,
  getManagedSnapshotRoot,
  expectedGroupSnapshotPath
} = require('../../coordinator/paths');
const { writeJson, readJson, appendJsonLine } = require('../../coordinator/io');

const { setupRunForCompletion } = require('./helpers');

const COORDINATOR = path.resolve(__dirname, '../../coordinator/index.js');

function run(args, cwd, expectFail = false) {
  try {
    const stdout = execFileSync('node', [COORDINATOR, ...args], {
      cwd,
      encoding: 'utf8',
      timeout: 15000,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    return { exitCode: 0, stdout, stderr: '' };
  } catch (e) {
    if (!expectFail) {
      throw e;
    }
    return { exitCode: e.status, stdout: e.stdout || '', stderr: e.stderr || '' };
  }
}

describe('coordinator CLI', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coord-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('--help', () => {
    it('prints usage', () => {
      const result = run(['--help'], tmpDir);
      assert.ok(result.stdout.includes('Usage'));
      assert.ok(result.stdout.includes('start'));
      assert.ok(result.stdout.includes('complete-stage'));
    });
  });

  describe('status', () => {
    it('lists all runs when no run id given', () => {
      createRun(tmpDir, { pipelineName: null, groups: [['correctness']], stages: ['correctness'], scope: '--diff' });
      const result = run(['status'], tmpDir);
      const parsed = JSON.parse(result.stdout);
      assert.ok(parsed.ok);
      assert.equal(parsed.runs.length, 1);
    });

    it('returns empty runs list when no runs exist', () => {
      const result = run(['status'], tmpDir);
      const parsed = JSON.parse(result.stdout);
      assert.ok(parsed.ok);
      assert.deepEqual(parsed.runs, []);
    });

    it('shows specific run details', () => {
      const created = createRun(tmpDir, { pipelineName: null, groups: [['correctness']], stages: ['correctness'], scope: '--diff' });
      const result = run(['status', '--run', created.runId], tmpDir);
      const parsed = JSON.parse(result.stdout);
      assert.equal(parsed.runId, created.runId);
      assert.equal(parsed.status, 'running');
    });

    it('marks dead workers when checking status', () => {
      const created = createRun(tmpDir, { pipelineName: null, groups: [['correctness']], stages: ['correctness'], scope: '--diff' });
      // Set up a dead worker (PID 99999999 doesn't exist)
      mutateRun(tmpDir, created.runId, r => {
        r.auditor = { correctness: { workerPid: 99999999, pid: 99999998, stage: 'correctness', groupIndex: 0 } };
        return r;
      });
      updateStageStatus(tmpDir, created.runId, 'correctness', 'auditing');
      writeJson(stageMetaFile(tmpDir, created.runId, 'correctness'), {
        stage: 'correctness',
        status: 'auditing',
        auditDone: false,
        emittedCount: 0
      });
      const result = run(['status', '--run', created.runId], tmpDir);
      const parsed = JSON.parse(result.stdout);
      // The dead worker should have been marked as failed
      const stage = parsed.stages.find(s => s.name === 'correctness');
      assert.equal(stage.status, 'audit_failed');
    });
  });

  describe('complete-stage', () => {
    it('completes a stage with zero findings', () => {
      const { runId } = setupRunForCompletion(tmpDir, 'correctness');
      writeJson(stageDecisionsFile(tmpDir, runId, 'correctness'), {
        stage: 'correctness',
        decisions: []
      });
      const result = run(['complete-stage', '--run', runId, '--stage', 'correctness'], tmpDir);
      const parsed = JSON.parse(result.stdout);
      assert.ok(parsed.ok);
      assert.equal(parsed.completedStage, 'correctness');
      assert.equal(parsed.groupCompleted, true);
    });

    it('completes a stage with matching findings and decisions', () => {
      const { runId } = setupRunForCompletion(tmpDir, 'correctness', { findingsCount: 2 });
      // Write findings to queue
      appendJsonLine(stageFindingsQueueFile(tmpDir, runId, 'correctness'), {
        type: 'finding', finding: { id: 'correctness-1', severity: 'low', title: 'test' }
      });
      appendJsonLine(stageFindingsQueueFile(tmpDir, runId, 'correctness'), {
        type: 'finding', finding: { id: 'correctness-2', severity: 'medium', title: 'test2' }
      });
      writeJson(stageDecisionsFile(tmpDir, runId, 'correctness'), {
        stage: 'correctness',
        decisions: [
          { findingId: 'correctness-1', decision: 'valid', action: 'fixed', rationale: 'fixed it' },
          { findingId: 'correctness-2', decision: 'invalid', action: 'none', rationale: 'false positive' }
        ]
      });
      const result = run(['complete-stage', '--run', runId, '--stage', 'correctness'], tmpDir);
      const parsed = JSON.parse(result.stdout);
      assert.ok(parsed.ok);
      assert.equal(parsed.groupCompleted, true);

      // Check summary was populated
      const summary = readJson(summaryFile(tmpDir, runId));
      assert.equal(summary.completedStages.length, 1);
      assert.equal(summary.completedStages[0].counts.valid, 1);
      assert.equal(summary.completedStages[0].counts.invalid, 1);
      assert.equal(summary.rejectedFindings.length, 1);
    });

    it('rejects when stage is not in awaiting_verification_completion', () => {
      const created = createRun(tmpDir, { pipelineName: null, groups: [['correctness']], stages: ['correctness'], scope: '--diff' });
      writeJson(stageDecisionsFile(tmpDir, created.runId, 'correctness'), { stage: 'correctness', decisions: [] });
      const result = run(['complete-stage', '--run', created.runId, '--stage', 'correctness'], tmpDir, true);
      assert.notEqual(result.exitCode, 0);
      assert.ok(result.stderr.includes('not ready for completion'));
    });

    it('rejects when decisions are missing for findings', () => {
      const { runId } = setupRunForCompletion(tmpDir, 'correctness', { findingsCount: 1 });
      appendJsonLine(stageFindingsQueueFile(tmpDir, runId, 'correctness'), {
        type: 'finding', finding: { id: 'correctness-1', severity: 'low', title: 'test' }
      });
      // Empty decisions — mismatch
      writeJson(stageDecisionsFile(tmpDir, runId, 'correctness'), {
        stage: 'correctness',
        decisions: []
      });
      const result = run(['complete-stage', '--run', runId, '--stage', 'correctness'], tmpDir, true);
      assert.notEqual(result.exitCode, 0);
      assert.ok(result.stderr.includes('Missing'));
    });

    it('rejects duplicate decisions', () => {
      const { runId } = setupRunForCompletion(tmpDir, 'correctness', { findingsCount: 1 });
      appendJsonLine(stageFindingsQueueFile(tmpDir, runId, 'correctness'), {
        type: 'finding', finding: { id: 'correctness-1', severity: 'low', title: 'test' }
      });
      writeJson(stageDecisionsFile(tmpDir, runId, 'correctness'), {
        stage: 'correctness',
        decisions: [
          { findingId: 'correctness-1', decision: 'valid', action: 'fixed', rationale: 'a' },
          { findingId: 'correctness-1', decision: 'invalid', action: 'none', rationale: 'b' }
        ]
      });
      const result = run(['complete-stage', '--run', runId, '--stage', 'correctness'], tmpDir, true);
      assert.notEqual(result.exitCode, 0);
      assert.ok(result.stderr.includes('duplicate'));
    });

    it('rejects unexpected decision IDs', () => {
      const { runId } = setupRunForCompletion(tmpDir, 'correctness', { findingsCount: 0 });
      writeJson(stageDecisionsFile(tmpDir, runId, 'correctness'), {
        stage: 'correctness',
        decisions: [
          { findingId: 'ghost-1', decision: 'valid', action: 'fixed', rationale: 'a' }
        ]
      });
      const result = run(['complete-stage', '--run', runId, '--stage', 'correctness'], tmpDir, true);
      assert.notEqual(result.exitCode, 0);
      assert.ok(result.stderr.includes('unexpected'));
    });

    it('rejects when audit failed', () => {
      const { runId } = setupRunForCompletion(tmpDir, 'correctness');
      // Override meta to indicate failure
      writeJson(stageMetaFile(tmpDir, runId, 'correctness'), {
        stage: 'correctness',
        status: 'failed',
        auditDone: true,
        auditSucceeded: false,
        error: true,
        auditorExitCode: 1
      });
      writeJson(stageDecisionsFile(tmpDir, runId, 'correctness'), { stage: 'correctness', decisions: [] });
      const result = run(['complete-stage', '--run', runId, '--stage', 'correctness'], tmpDir, true);
      assert.notEqual(result.exitCode, 0);
      assert.ok(result.stderr.includes('failed'));
    });

    it('accepts --result flag', () => {
      const { runId } = setupRunForCompletion(tmpDir, 'correctness');
      writeJson(stageDecisionsFile(tmpDir, runId, 'correctness'), { stage: 'correctness', decisions: [] });
      const result = run(['complete-stage', '--run', runId, '--stage', 'correctness', '--result', 'rejected'], tmpDir);
      const parsed = JSON.parse(result.stdout);
      assert.ok(parsed.ok);
      // Verify verificationResult in run
      const loaded = loadRun(tmpDir, runId);
      const stage = loaded.stages.find(s => s.name === 'correctness');
      assert.equal(stage.verificationResult, 'rejected');
    });

    it('rejects invalid --result value', () => {
      const { runId } = setupRunForCompletion(tmpDir, 'correctness');
      writeJson(stageDecisionsFile(tmpDir, runId, 'correctness'), { stage: 'correctness', decisions: [] });
      const result = run(['complete-stage', '--run', runId, '--stage', 'correctness', '--result', 'bogus'], tmpDir, true);
      assert.notEqual(result.exitCode, 0);
      assert.ok(result.stderr.includes('Invalid completion result'));
    });

    it('completes run when last group finishes', () => {
      const { runId } = setupRunForCompletion(tmpDir, 'correctness');
      writeJson(stageDecisionsFile(tmpDir, runId, 'correctness'), { stage: 'correctness', decisions: [] });
      run(['complete-stage', '--run', runId, '--stage', 'correctness'], tmpDir);
      const loaded = loadRun(tmpDir, runId);
      assert.equal(loaded.status, 'completed');
    });

    it('advances group but does not complete run when more groups remain', () => {
      const spec = {
        pipelineName: null,
        groups: [['correctness'], ['security']],
        stages: ['correctness', 'security'],
        scope: '--diff'
      };
      const created = createRun(tmpDir, spec);
      const runId = created.runId;

      // Set up correctness stage for completion
      updateStageStatus(tmpDir, runId, 'correctness', 'awaiting_verification_completion', { auditorExitCode: 0, findingsCount: 0 });
      updateGroupStatus(tmpDir, runId, 0, 'auditing');
      writeJson(stageMetaFile(tmpDir, runId, 'correctness'), {
        stage: 'correctness', status: 'done', auditDone: true, auditSucceeded: true, emittedCount: 0, auditorExitCode: 0
      });
      const queuePath = stageFindingsQueueFile(tmpDir, runId, 'correctness');
      fs.mkdirSync(path.dirname(queuePath), { recursive: true });
      fs.writeFileSync(queuePath, '', 'utf8');
      writeJson(stageDecisionsFile(tmpDir, runId, 'correctness'), { stage: 'correctness', decisions: [] });
      const snapPath = expectedGroupSnapshotPath(runId, 0);
      fs.mkdirSync(snapPath, { recursive: true });
      writeJson(groupSnapshotFile(tmpDir, runId, 0), { type: 'temp-copy', path: snapPath });

      const result = run(['complete-stage', '--run', runId, '--stage', 'correctness'], tmpDir);
      const parsed = JSON.parse(result.stdout);
      assert.ok(parsed.ok);
      assert.equal(parsed.groupCompleted, true);
      assert.deepEqual(parsed.nextGroup, ['security']);

      const loaded = loadRun(tmpDir, runId);
      assert.equal(loaded.status, 'running');
      assert.equal(loaded.currentGroupIndex, 1);
      // activeStages should be empty until `next` launches them (BUG 9 fix)
      assert.deepEqual(loaded.activeStages, []);
    });

    it('populates pending approvals in summary', () => {
      const { runId } = setupRunForCompletion(tmpDir, 'correctness', { findingsCount: 1 });
      appendJsonLine(stageFindingsQueueFile(tmpDir, runId, 'correctness'), {
        type: 'finding', finding: { id: 'correctness-1', severity: 'high', title: 'big refactor needed' }
      });
      writeJson(stageDecisionsFile(tmpDir, runId, 'correctness'), {
        stage: 'correctness',
        decisions: [{ findingId: 'correctness-1', decision: 'valid_needs_approval', action: 'none', rationale: 'too big' }]
      });
      run(['complete-stage', '--run', runId, '--stage', 'correctness'], tmpDir);
      const summary = readJson(summaryFile(tmpDir, runId));
      assert.equal(summary.pendingApprovals.length, 1);
      assert.equal(summary.pendingApprovals[0].findingId, 'correctness-1');
    });
  });

  describe('next', () => {
    it('reports completed when run is finished', () => {
      const created = createRun(tmpDir, { pipelineName: null, groups: [['correctness']], stages: ['correctness'], scope: '--diff' });
      // Manually complete the run
      const data = readJson(runFile(tmpDir, created.runId));
      data.status = 'completed';
      data.currentGroupIndex = 1;
      writeJson(runFile(tmpDir, created.runId), data);
      const result = run(['next', '--run', created.runId], tmpDir);
      const parsed = JSON.parse(result.stdout);
      assert.ok(parsed.ok);
      assert.equal(parsed.nextGroup, null);
      assert.equal(parsed.status, 'completed');
    });

    it('reports failed stages when group has failures', () => {
      const created = createRun(tmpDir, { pipelineName: null, groups: [['correctness']], stages: ['correctness'], scope: '--diff' });
      updateStageStatus(tmpDir, created.runId, 'correctness', 'audit_failed', { auditorExitCode: 1, findingsCount: 0 });
      const result = run(['next', '--run', created.runId], tmpDir);
      const parsed = JSON.parse(result.stdout);
      assert.ok(parsed.ok);
      assert.deepEqual(parsed.failedStages, ['correctness']);
    });

    it('reports already active stages', () => {
      const created = createRun(tmpDir, { pipelineName: null, groups: [['correctness']], stages: ['correctness'], scope: '--diff' });
      updateStageStatus(tmpDir, created.runId, 'correctness', 'auditing');
      const result = run(['next', '--run', created.runId], tmpDir);
      const parsed = JSON.parse(result.stdout);
      assert.ok(parsed.ok);
      assert.equal(parsed.stageAlreadyActive, true);
    });
  });

  describe('clean', () => {
    it('cleans completed runs', () => {
      const created = createRun(tmpDir, { pipelineName: null, groups: [['correctness']], stages: ['correctness'], scope: '--diff' });
      const data = readJson(runFile(tmpDir, created.runId));
      data.status = 'completed';
      writeJson(runFile(tmpDir, created.runId), data);
      // Create some artifacts
      const logsPath = stageLogsDir(tmpDir, created.runId, 'correctness');
      fs.mkdirSync(logsPath, { recursive: true });
      fs.writeFileSync(path.join(logsPath, 'test.log'), 'log data', 'utf8');
      const result = run(['clean'], tmpDir);
      const parsed = JSON.parse(result.stdout);
      assert.ok(parsed.ok);
      assert.ok(parsed.logsRemoved >= 1);
    });

    it('deletes entire run directory for cancelled runs', () => {
      const created = createRun(tmpDir, { pipelineName: null, groups: [['correctness']], stages: ['correctness'], scope: '--diff' });
      const data = readJson(runFile(tmpDir, created.runId));
      data.status = 'cancelled';
      for (const s of data.stages) s.status = 'cancelled';
      for (const g of data.groups) g.status = 'cancelled';
      writeJson(runFile(tmpDir, created.runId), data);
      const logsPath = stageLogsDir(tmpDir, created.runId, 'correctness');
      fs.mkdirSync(logsPath, { recursive: true });
      fs.writeFileSync(path.join(logsPath, 'test.log'), 'log data', 'utf8');

      const result = run(['clean'], tmpDir);
      const parsed = JSON.parse(result.stdout);
      assert.ok(parsed.ok);
      assert.ok(parsed.removedRuns.includes(created.runId));
      const { runDir } = require('../../coordinator/paths');
      assert.equal(fs.existsSync(runDir(tmpDir, created.runId)), false);
    });

    it('deletes entire run directory for failed runs', () => {
      const created = createRun(tmpDir, { pipelineName: null, groups: [['correctness']], stages: ['correctness'], scope: '--diff' });
      const data = readJson(runFile(tmpDir, created.runId));
      data.status = 'failed';
      writeJson(runFile(tmpDir, created.runId), data);

      const result = run(['clean'], tmpDir);
      const parsed = JSON.parse(result.stdout);
      assert.ok(parsed.ok);
      assert.ok(parsed.removedRuns.includes(created.runId));
    });

    it('does not delete cancelled runs with --logs-only', () => {
      const created = createRun(tmpDir, { pipelineName: null, groups: [['correctness']], stages: ['correctness'], scope: '--diff' });
      const data = readJson(runFile(tmpDir, created.runId));
      data.status = 'cancelled';
      writeJson(runFile(tmpDir, created.runId), data);

      const result = run(['clean', '--logs-only'], tmpDir);
      const parsed = JSON.parse(result.stdout);
      assert.ok(parsed.ok);
      assert.deepEqual(parsed.removedRuns, []);
      const { runDir } = require('../../coordinator/paths');
      assert.equal(fs.existsSync(runDir(tmpDir, created.runId)), true);
    });

    it('respects --logs-only flag', () => {
      const created = createRun(tmpDir, { pipelineName: null, groups: [['correctness']], stages: ['correctness'], scope: '--diff' });
      const data = readJson(runFile(tmpDir, created.runId));
      data.status = 'completed';
      writeJson(runFile(tmpDir, created.runId), data);
      const logsPath = stageLogsDir(tmpDir, created.runId, 'correctness');
      fs.mkdirSync(logsPath, { recursive: true });
      fs.writeFileSync(path.join(logsPath, 'test.log'), 'log data', 'utf8');
      const result = run(['clean', '--logs-only'], tmpDir);
      const parsed = JSON.parse(result.stdout);
      assert.ok(parsed.ok);
      assert.deepEqual(parsed.removedRuns, []);
    });
  });

  describe('unknown command', () => {
    it('exits with error', () => {
      const result = run(['bogus-command'], tmpDir, true);
      assert.notEqual(result.exitCode, 0);
      assert.ok(result.stderr.includes('Unknown command'));
    });
  });
});
