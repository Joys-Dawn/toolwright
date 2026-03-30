'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { createRun, updateStageStatus, updateGroupStatus, mutateRun } = require('../../coordinator/run-ledger');
const {
  groupSnapshotFile,
  stageMetaFile,
  stageFindingsFile,
  stageFindingsQueueFile,
  stageLogsDir,
  getManagedSnapshotRoot,
  expectedGroupSnapshotPath
} = require('../../coordinator/paths');
const { writeJson, readJson } = require('../../coordinator/io');

const WORKER = path.resolve(__dirname, '../../coordinator/stage-worker.js');

function runWorker(args, cwd) {
  try {
    const stdout = execFileSync('node', [WORKER, ...args], {
      cwd,
      encoding: 'utf8',
      timeout: 15000,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    return { exitCode: 0, stdout, stderr: '' };
  } catch (e) {
    return { exitCode: e.status, stdout: e.stdout || '', stderr: e.stderr || '' };
  }
}

describe('stage-worker', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('exits with error when --run is missing', () => {
    const result = runWorker(['--stage', 'correctness', '--group-index', '0'], tmpDir);
    assert.equal(result.exitCode, 1);
  });

  it('exits with error when --stage is missing', () => {
    const result = runWorker(['--run', 'test-run', '--group-index', '0'], tmpDir);
    assert.equal(result.exitCode, 1);
  });

  it('exits with error when --group-index is missing', () => {
    const result = runWorker(['--run', 'test-run', '--stage', 'correctness'], tmpDir);
    assert.equal(result.exitCode, 1);
  });

  it('exits with error for unknown run ID', () => {
    const result = runWorker(['--run', 'nonexistent-run', '--stage', 'correctness', '--group-index', '0'], tmpDir);
    assert.equal(result.exitCode, 1);
  });

  it('writes failure meta when snapshot path is wrong', () => {
    // Use a custom stage with invalid skillId to trigger a predictable error
    // before the auditor is spawned (no dependency on claude CLI)
    fs.writeFileSync(path.join(tmpDir, '.agentwright.json'), JSON.stringify({
      customStages: {
        fakestage: { type: 'skill', skillId: 'nonexistent-skill-dir' }
      }
    }), 'utf8');

    const run = createRun(tmpDir, {
      pipelineName: null,
      groups: [['fakestage']],
      stages: ['fakestage'],
      scope: '--diff'
    });
    updateStageStatus(tmpDir, run.runId, 'fakestage', 'auditing');

    const snapshotPath = expectedGroupSnapshotPath(run.runId, 0);
    fs.mkdirSync(snapshotPath, { recursive: true });
    writeJson(groupSnapshotFile(tmpDir, run.runId, 0), {
      type: 'temp-copy',
      path: snapshotPath,
      createdAt: new Date().toISOString()
    });

    const result = runWorker([
      '--run', run.runId,
      '--stage', 'fakestage',
      '--group-index', '0'
    ], tmpDir);

    assert.equal(result.exitCode, 1);

    // Verify the worker wrote failure metadata via its catch handler
    const meta = readJson(stageMetaFile(tmpDir, run.runId, 'fakestage'));
    assert.ok(meta);
    assert.equal(meta.auditDone, true);
    assert.equal(meta.auditSucceeded, false);
    assert.equal(meta.error, true);
    assert.ok(meta.summary.includes('skill not found') || meta.summary.includes('Vendored skill'));

    // Verify stage status was updated to audit_failed
    const loaded = require('../../coordinator/run-ledger').loadRun(tmpDir, run.runId);
    const stage = loaded.stages.find(s => s.name === 'fakestage');
    assert.equal(stage.status, 'audit_failed');

    fs.rmSync(snapshotPath, { recursive: true, force: true });
  });

  describe('prompt building validation', () => {
    it('rejects invalid skill IDs via worker error path', () => {
      // Create a config with a stage that has an invalid skillId
      fs.writeFileSync(path.join(tmpDir, '.agentwright.json'), JSON.stringify({
        customStages: {
          badstage: { type: 'skill', skillId: '../../../etc/passwd' }
        }
      }), 'utf8');

      const run = createRun(tmpDir, {
        pipelineName: null,
        groups: [['badstage']],
        stages: ['badstage'],
        scope: '--diff'
      });

      const snapshotPath = expectedGroupSnapshotPath(run.runId, 0);
      fs.mkdirSync(snapshotPath, { recursive: true });
      writeJson(groupSnapshotFile(tmpDir, run.runId, 0), {
        type: 'temp-copy',
        path: snapshotPath,
        createdAt: new Date().toISOString()
      });

      const result = runWorker([
        '--run', run.runId,
        '--stage', 'badstage',
        '--group-index', '0'
      ], tmpDir);

      assert.equal(result.exitCode, 1);

      // Should have written failure meta with the invalid skill ID error
      const meta = readJson(stageMetaFile(tmpDir, run.runId, 'badstage'));
      if (meta) {
        assert.equal(meta.auditSucceeded, false);
        assert.ok(meta.summary.includes('Invalid skill ID') || meta.summary.includes('skill'));
      }

      fs.rmSync(snapshotPath, { recursive: true, force: true });
    });
  });
});
