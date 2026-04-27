'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync, spawn } = require('child_process');

const { nextFinding, recordDecision } = require('../../coordinator/verification');
const { stopRun } = require('../../coordinator/lifecycle');
const {
  createRun,
  updateStageStatus,
  updateGroupStatus,
  loadRun,
  mutateRun
} = require('../../coordinator/run-ledger');
const {
  stageMetaFile,
  stageFindingsQueueFile,
  stageDecisionsFile,
  stageVerifierFile,
  groupSnapshotFile,
  expectedGroupSnapshotPath
} = require('../../coordinator/paths');
const { writeJson, readJson, appendJsonLine } = require('../../coordinator/io');

const COORDINATOR = path.join(__dirname, '..', '..', 'coordinator', 'index.js');

function makeFinding(stageName, index) {
  return {
    type: 'finding',
    finding: {
      id: `${stageName}-${index}`,
      severity: 'medium',
      title: `Test finding ${index}`,
      file: `src/file${index}.js`,
      problem: 'Test problem',
      fix: 'Test fix',
      evidence: 'Test evidence'
    }
  };
}

function setupStageFiles(tmpDir, runId, stageName, findingCount, opts = {}) {
  const stageStatus = opts.stageStatus || 'awaiting_verification_completion';
  updateStageStatus(tmpDir, runId, stageName, stageStatus, {
    auditorExitCode: 0,
    findingsCount: findingCount
  });

  const auditDone = opts.auditDone !== undefined ? opts.auditDone : true;
  writeJson(stageMetaFile(tmpDir, runId, stageName), {
    stage: stageName,
    status: auditDone ? 'done' : 'auditing',
    auditDone,
    auditSucceeded: auditDone ? true : undefined,
    emittedCount: findingCount,
    auditorExitCode: auditDone ? 0 : undefined,
    updatedAt: new Date().toISOString()
  });

  const queuePath = stageFindingsQueueFile(tmpDir, runId, stageName);
  fs.mkdirSync(path.dirname(queuePath), { recursive: true });
  fs.writeFileSync(queuePath, '', 'utf8');
  for (let i = 1; i <= findingCount; i++) {
    appendJsonLine(queuePath, makeFinding(stageName, i));
  }

  writeJson(stageVerifierFile(tmpDir, runId, stageName), {
    stage: stageName,
    lastConsumedIndex: 0,
    processedFindingIds: [],
    fixedCount: 0,
    invalidCount: 0,
    deferredCount: 0,
    updatedAt: new Date().toISOString()
  });

  writeJson(stageDecisionsFile(tmpDir, runId, stageName), {
    stage: stageName,
    decisions: []
  });
}

function setupRunWithFindings(tmpDir, stageName, findingCount, opts = {}) {
  const spec = {
    pipelineName: null,
    groups: opts.groups || [[stageName]],
    stages: opts.stages || [stageName],
    scope: '--diff'
  };
  const created = createRun(tmpDir, spec);
  const runId = created.runId;

  updateGroupStatus(tmpDir, runId, 0, 'auditing');
  setupStageFiles(tmpDir, runId, stageName, findingCount, opts);

  const snapshotPath = expectedGroupSnapshotPath(runId, 0);
  fs.mkdirSync(snapshotPath, { recursive: true });
  writeJson(groupSnapshotFile(tmpDir, runId, 0), {
    type: 'temp-copy',
    path: snapshotPath,
    createdAt: new Date().toISOString()
  });

  return { runId, created };
}

function runCli(args, cwd) {
  try {
    const stdout = execFileSync(process.execPath, [COORDINATOR, ...args], {
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

let tmpDir;
let origCwd;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verification-test-'));
  origCwd = process.cwd();
  process.chdir(tmpDir);
});

afterEach(() => {
  process.chdir(origCwd);
  for (let i = 0; i < 5; i++) {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      return;
    } catch (err) {
      if (err.code !== 'EPERM' && err.code !== 'EACCES') throw err;
      if (i === 4) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
});

describe('nextFinding', () => {
  it('returns finding when unprocessed findings exist', async () => {
    const { runId } = setupRunWithFindings(tmpDir, 'correctness', 2);
    const result = await nextFinding(runId);
    assert.equal(result.status, 'finding');
    assert.equal(result.stage, 'correctness');
    assert.equal(result.finding.id, 'correctness-1');
    assert.equal(result.progress.processed, 0);
    assert.equal(result.progress.total, 2);
  });

  it('skips already-processed findings', async () => {
    const { runId } = setupRunWithFindings(tmpDir, 'correctness', 2);
    const verifier = readJson(stageVerifierFile(tmpDir, runId, 'correctness'));
    verifier.processedFindingIds.push('correctness-1');
    verifier.lastConsumedIndex = 1;
    writeJson(stageVerifierFile(tmpDir, runId, 'correctness'), verifier);

    const result = await nextFinding(runId);
    assert.equal(result.status, 'finding');
    assert.equal(result.finding.id, 'correctness-2');
    assert.equal(result.progress.processed, 1);
  });

  it('returns waiting when auditor running and no new findings', async () => {
    const { runId } = setupRunWithFindings(tmpDir, 'correctness', 0, {
      auditDone: false,
      stageStatus: 'auditing'
    });
    const result = await nextFinding(runId);
    assert.equal(result.status, 'waiting');
    assert.equal(result.stage, 'correctness');
    assert.equal(result.progress.auditDone, false);
  });

  it('returns done when pipeline completed', async () => {
    const { runId } = setupRunWithFindings(tmpDir, 'correctness', 0);
    mutateRun(tmpDir, runId, run => {
      run.status = 'completed';
      for (const stage of run.stages) stage.status = 'completed';
      for (const group of run.groups) group.status = 'completed';
      return run;
    });
    const result = await nextFinding(runId);
    assert.equal(result.status, 'done');
  });

  it('returns error for audit_failed stage', async () => {
    const { runId } = setupRunWithFindings(tmpDir, 'correctness', 0, {
      stageStatus: 'audit_failed',
      auditDone: true
    });
    writeJson(stageMetaFile(tmpDir, runId, 'correctness'), {
      stage: 'correctness',
      status: 'failed',
      auditDone: true,
      auditSucceeded: false,
      error: 'auditor crashed',
      auditorExitCode: 1
    });
    updateStageStatus(tmpDir, runId, 'correctness', 'audit_failed');

    const result = await nextFinding(runId);
    assert.equal(result.status, 'error');
    assert.equal(result.stage, 'correctness');
  });

  it('skips completed stages and returns finding from next active stage', async () => {
    const { runId } = setupRunWithFindings(tmpDir, 'correctness', 1, {
      groups: [['correctness', 'security']],
      stages: ['correctness', 'security']
    });
    setupStageFiles(tmpDir, runId, 'security', 1);
    updateStageStatus(tmpDir, runId, 'correctness', 'completed');

    const result = await nextFinding(runId);
    assert.equal(result.status, 'finding');
    assert.equal(result.stage, 'security');
    assert.equal(result.finding.id, 'security-1');
  });

  it('auto-completes stage when all decided and auditDone', async () => {
    const { runId } = setupRunWithFindings(tmpDir, 'correctness', 1);
    writeJson(stageDecisionsFile(tmpDir, runId, 'correctness'), {
      stage: 'correctness',
      decisions: [{ findingId: 'correctness-1', decision: 'valid', action: 'fixed', rationale: 'test' }]
    });
    const verifier = readJson(stageVerifierFile(tmpDir, runId, 'correctness'));
    verifier.processedFindingIds.push('correctness-1');
    writeJson(stageVerifierFile(tmpDir, runId, 'correctness'), verifier);

    const result = await nextFinding(runId);
    assert.equal(result.status, 'done');
  });

  it('returns waiting for transient auditing+auditDone state', async () => {
    const { runId } = setupRunWithFindings(tmpDir, 'correctness', 1, {
      auditDone: true,
      stageStatus: 'auditing'
    });
    // Mark the one finding as processed so there are no unprocessed findings
    const verifier = readJson(stageVerifierFile(tmpDir, runId, 'correctness'));
    verifier.processedFindingIds.push('correctness-1');
    verifier.lastConsumedIndex = 1;
    writeJson(stageVerifierFile(tmpDir, runId, 'correctness'), verifier);

    const result = await nextFinding(runId);
    assert.equal(result.status, 'waiting');
    assert.equal(result.stage, 'correctness');
    assert.equal(result.progress.auditDone, true);
  });

  it('handles empty audit (0 findings, auditDone)', async () => {
    const { runId } = setupRunWithFindings(tmpDir, 'correctness', 0);
    const result = await nextFinding(runId);
    assert.equal(result.status, 'done');
  });

  it('with wait=true returns immediately when finding is available', async () => {
    const { runId } = setupRunWithFindings(tmpDir, 'correctness', 1);
    const t0 = performance.now();
    const result = await nextFinding(runId, { wait: true, pollIntervalMs: 10 });
    const elapsed = performance.now() - t0;
    assert.equal(result.status, 'finding');
    assert.ok(elapsed < 500, `expected fast return, took ${elapsed}ms`);
  });

  it('with wait timeout returns waiting after maxWaitMs when no findings appear', async () => {
    const { runId } = setupRunWithFindings(tmpDir, 'correctness', 0, {
      auditDone: false,
      stageStatus: 'auditing'
    });
    const t0 = performance.now();
    const result = await nextFinding(runId, { wait: 100, pollIntervalMs: 20 });
    const elapsed = performance.now() - t0;
    assert.equal(result.status, 'waiting');
    assert.ok(elapsed >= 100, `expected wait of at least 100ms, took ${elapsed}ms`);
    assert.ok(elapsed < 1000, `expected wait to terminate near deadline, took ${elapsed}ms`);
  });

  it('returns within wait deadline when pollInterval exceeds remaining budget', async () => {
    const { runId } = setupRunWithFindings(tmpDir, 'correctness', 0, {
      auditDone: false,
      stageStatus: 'auditing'
    });
    const t0 = performance.now();
    const result = await nextFinding(runId, { wait: 50, pollIntervalMs: 1000 });
    const elapsed = performance.now() - t0;
    assert.equal(result.status, 'waiting');
    assert.ok(elapsed < 300, `expected return within wait budget; took ${elapsed}ms`);
  });

  it('with wait=true unblocks when a finding appears mid-wait', async () => {
    const { runId } = setupRunWithFindings(tmpDir, 'correctness', 0, {
      auditDone: false,
      stageStatus: 'auditing'
    });
    const queuePath = stageFindingsQueueFile(tmpDir, runId, 'correctness');
    const timer = setTimeout(() => {
      appendJsonLine(queuePath, makeFinding('correctness', 1));
    }, 60);
    try {
      const result = await nextFinding(runId, { wait: 5000, pollIntervalMs: 20 });
      assert.equal(result.status, 'finding');
      assert.equal(result.finding.id, 'correctness-1');
    } finally {
      clearTimeout(timer);
    }
  });
});

describe('recordDecision', () => {
  it('records a decision and updates verifier file', async () => {
    const { runId } = setupRunWithFindings(tmpDir, 'correctness', 2);
    const result = await recordDecision(runId, 'correctness', 'correctness-1', {
      decision: 'valid',
      action: 'fixed',
      rationale: 'confirmed bug',
      filesChanged: ['src/file1.js'],
      evidence: 'checked line 42'
    });
    assert.equal(result.ok, true);
    assert.equal(result.findingId, 'correctness-1');
    assert.equal(result.decision, 'valid');
    assert.equal(result.stageComplete, false);

    const decisions = readJson(stageDecisionsFile(tmpDir, runId, 'correctness'));
    assert.equal(decisions.decisions.length, 1);
    assert.equal(decisions.decisions[0].findingId, 'correctness-1');

    const verifier = readJson(stageVerifierFile(tmpDir, runId, 'correctness'));
    assert.ok(verifier.processedFindingIds.includes('correctness-1'));
    assert.equal(verifier.fixedCount, 1);
  });

  it('rejects duplicate findingId', async () => {
    const { runId } = setupRunWithFindings(tmpDir, 'correctness', 2);
    await recordDecision(runId, 'correctness', 'correctness-1', { decision: 'valid', action: 'fixed' });
    await assert.rejects(
      () => recordDecision(runId, 'correctness', 'correctness-1', { decision: 'valid' }),
      /Duplicate decision/
    );
  });

  it('passes auditType from finding into decision when finding has auditType', async () => {
    const { runId } = setupRunWithFindings(tmpDir, 'audit-bundle', 0);
    const queuePath = stageFindingsQueueFile(tmpDir, runId, 'audit-bundle');
    appendJsonLine(queuePath, {
      type: 'finding',
      finding: {
        id: 'audit-bundle-1',
        auditType: 'security-audit',
        severity: 'high',
        title: 'tagged finding',
        file: 'src/x.js',
        problem: 'p',
        fix: 'f',
        evidence: 'e'
      }
    });

    await recordDecision(runId, 'audit-bundle', 'audit-bundle-1', {
      decision: 'valid',
      action: 'fixed',
      rationale: 'r'
    });

    const decisions = readJson(stageDecisionsFile(tmpDir, runId, 'audit-bundle'));
    assert.equal(decisions.decisions.length, 1);
    assert.equal(decisions.decisions[0].auditType, 'security-audit');
  });

  it('omits auditType on decision when finding has no auditType (back-compat)', async () => {
    const { runId } = setupRunWithFindings(tmpDir, 'correctness', 1);

    await recordDecision(runId, 'correctness', 'correctness-1', {
      decision: 'invalid',
      action: 'none',
      rationale: 'not real'
    });

    const decisions = readJson(stageDecisionsFile(tmpDir, runId, 'correctness'));
    assert.equal(decisions.decisions.length, 1);
    assert.equal(Object.prototype.hasOwnProperty.call(decisions.decisions[0], 'auditType'), false);
  });

  it('increments fixedCount for valid+fixed', async () => {
    const { runId } = setupRunWithFindings(tmpDir, 'correctness', 2);
    await recordDecision(runId, 'correctness', 'correctness-1', { decision: 'valid', action: 'fixed' });
    const verifier = readJson(stageVerifierFile(tmpDir, runId, 'correctness'));
    assert.equal(verifier.fixedCount, 1);
    assert.equal(verifier.invalidCount, 0);
    assert.equal(verifier.deferredCount, 0);
  });

  it('increments invalidCount for invalid', async () => {
    const { runId } = setupRunWithFindings(tmpDir, 'correctness', 2);
    await recordDecision(runId, 'correctness', 'correctness-1', { decision: 'invalid' });
    const verifier = readJson(stageVerifierFile(tmpDir, runId, 'correctness'));
    assert.equal(verifier.invalidCount, 1);
  });

  it('increments deferredCount for valid_needs_approval', async () => {
    const { runId } = setupRunWithFindings(tmpDir, 'correctness', 2);
    await recordDecision(runId, 'correctness', 'correctness-1', { decision: 'valid_needs_approval' });
    const verifier = readJson(stageVerifierFile(tmpDir, runId, 'correctness'));
    assert.equal(verifier.deferredCount, 1);
  });

  it('auto-completes stage when all findings decided and auditDone', async () => {
    const { runId } = setupRunWithFindings(tmpDir, 'correctness', 2);
    await recordDecision(runId, 'correctness', 'correctness-1', { decision: 'valid', action: 'fixed' });
    const result = await recordDecision(runId, 'correctness', 'correctness-2', { decision: 'invalid' });
    assert.equal(result.stageComplete, true);
    assert.equal(result.pipelineComplete, true);
  });

  it('does not auto-complete when auditDone is false', async () => {
    const { runId } = setupRunWithFindings(tmpDir, 'correctness', 1, {
      auditDone: false,
      stageStatus: 'auditing'
    });
    const result = await recordDecision(runId, 'correctness', 'correctness-1', { decision: 'valid', action: 'fixed' });
    assert.equal(result.stageComplete, false);
  });

  it('does not auto-complete when stage status is not awaiting_verification_completion', async () => {
    const { runId } = setupRunWithFindings(tmpDir, 'correctness', 1, {
      stageStatus: 'auditing'
    });
    const result = await recordDecision(runId, 'correctness', 'correctness-1', { decision: 'valid', action: 'fixed' });
    assert.equal(result.stageComplete, false);
  });

  it('derives result approval when any decision is valid_needs_approval', async () => {
    const { runId } = setupRunWithFindings(tmpDir, 'correctness', 2);
    await recordDecision(runId, 'correctness', 'correctness-1', { decision: 'valid', action: 'fixed' });
    const result = await recordDecision(runId, 'correctness', 'correctness-2', { decision: 'valid_needs_approval' });
    assert.equal(result.stageComplete, true);
    const run = loadRun(tmpDir, runId);
    const stage = run.stages.find(s => s.name === 'correctness');
    assert.equal(stage.verificationResult, 'approval');
  });

  it('derives result rejected when all decisions are invalid', async () => {
    const { runId } = setupRunWithFindings(tmpDir, 'correctness', 2);
    await recordDecision(runId, 'correctness', 'correctness-1', { decision: 'invalid' });
    const result = await recordDecision(runId, 'correctness', 'correctness-2', { decision: 'invalid' });
    assert.equal(result.stageComplete, true);
    const run = loadRun(tmpDir, runId);
    const stage = run.stages.find(s => s.name === 'correctness');
    assert.equal(stage.verificationResult, 'rejected');
  });

  it('derives result accepted for mixed valid/invalid', async () => {
    const { runId } = setupRunWithFindings(tmpDir, 'correctness', 2);
    await recordDecision(runId, 'correctness', 'correctness-1', { decision: 'valid', action: 'fixed' });
    const result = await recordDecision(runId, 'correctness', 'correctness-2', { decision: 'invalid' });
    assert.equal(result.stageComplete, true);
    const run = loadRun(tmpDir, runId);
    const stage = run.stages.find(s => s.name === 'correctness');
    assert.equal(stage.verificationResult, 'accepted');
  });

  it('validates decision is one of allowed values', async () => {
    const { runId } = setupRunWithFindings(tmpDir, 'correctness', 1);
    await assert.rejects(
      () => recordDecision(runId, 'correctness', 'correctness-1', { decision: 'bogus' }),
      /Invalid decision/
    );
  });

  it('validates findingId is non-empty', async () => {
    const { runId } = setupRunWithFindings(tmpDir, 'correctness', 1);
    await assert.rejects(
      () => recordDecision(runId, 'correctness', '', { decision: 'valid' }),
      /non-empty string/
    );
  });
});

describe('stopRun', () => {
  it('cancels a running run and marks stages as cancelled', () => {
    const { runId } = setupRunWithFindings(tmpDir, 'correctness', 2);
    const result = stopRun(runId);
    assert.equal(result.ok, true);
    assert.equal(result.status, 'cancelled');

    const run = loadRun(tmpDir, runId);
    assert.equal(run.status, 'cancelled');
    const stage = run.stages.find(s => s.name === 'correctness');
    assert.equal(stage.status, 'cancelled');
    assert.equal(run.auditor, null);
  });

  it('preserves completed stages when stopping', () => {
    const { runId } = setupRunWithFindings(tmpDir, 'correctness', 1, {
      groups: [['correctness', 'security']],
      stages: ['correctness', 'security']
    });
    setupStageFiles(tmpDir, runId, 'security', 1);
    updateStageStatus(tmpDir, runId, 'correctness', 'completed');

    const result = stopRun(runId);
    assert.equal(result.status, 'cancelled');

    const run = loadRun(tmpDir, runId);
    const correctness = run.stages.find(s => s.name === 'correctness');
    const security = run.stages.find(s => s.name === 'security');
    assert.equal(correctness.status, 'completed');
    assert.equal(security.status, 'cancelled');
  });

  it('is idempotent on already-cancelled run', () => {
    const { runId } = setupRunWithFindings(tmpDir, 'correctness', 1);
    stopRun(runId);
    const result = stopRun(runId);
    assert.equal(result.ok, true);
    assert.equal(result.status, 'cancelled');
    assert.deepEqual(result.killed, []);
  });

  it('is idempotent on already-completed run', () => {
    const { runId } = setupRunWithFindings(tmpDir, 'correctness', 0);
    mutateRun(tmpDir, runId, run => {
      run.status = 'completed';
      for (const stage of run.stages) stage.status = 'completed';
      for (const group of run.groups) group.status = 'completed';
      return run;
    });
    const result = stopRun(runId);
    assert.equal(result.ok, true);
    assert.equal(result.status, 'completed');
    assert.deepEqual(result.killed, []);
  });

  it('kills live worker and auditor processes', () => {
    const { runId } = setupRunWithFindings(tmpDir, 'correctness', 1);
    const worker = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    });
    const auditor = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    });
    worker.unref();
    auditor.unref();

    mutateRun(tmpDir, runId, current => {
      current.auditor = {
        correctness: {
          workerPid: worker.pid,
          pid: auditor.pid,
          stage: 'correctness'
        }
      };
      return current;
    });

    const result = stopRun(runId);
    assert.equal(result.status, 'cancelled');
    assert.equal(result.killed.length, 2);
    assert.ok(result.killed.some(k => k.role === 'worker' && k.pid === worker.pid));
    assert.ok(result.killed.some(k => k.role === 'auditor' && k.pid === auditor.pid));

    // Verify processes are actually dead
    let workerAlive = true;
    try { process.kill(worker.pid, 0); } catch (_) { workerAlive = false; }
    let auditorAlive = true;
    try { process.kill(auditor.pid, 0); } catch (_) { auditorAlive = false; }
    assert.equal(workerAlive, false, 'worker should be dead');
    assert.equal(auditorAlive, false, 'auditor should be dead');
  });

  it('clears activeStages on stop', () => {
    const { runId } = setupRunWithFindings(tmpDir, 'correctness', 1);
    mutateRun(tmpDir, runId, current => {
      current.activeStages = ['correctness'];
      return current;
    });
    stopRun(runId);
    const run = loadRun(tmpDir, runId);
    assert.deepEqual(run.activeStages, []);
  });
});

describe('CLI integration', () => {
  it('next-finding via CLI', () => {
    const { runId } = setupRunWithFindings(tmpDir, 'correctness', 1);
    const { exitCode, stdout } = runCli(['next-finding', '--run', runId], tmpDir);
    assert.equal(exitCode, 0);
    const result = JSON.parse(stdout);
    assert.equal(result.status, 'finding');
    assert.equal(result.finding.id, 'correctness-1');
  });

  it('stop via CLI', () => {
    const { runId } = setupRunWithFindings(tmpDir, 'correctness', 1);
    const { exitCode, stdout } = runCli(['stop', '--run', runId], tmpDir);
    assert.equal(exitCode, 0);
    const result = JSON.parse(stdout);
    assert.equal(result.ok, true);
    assert.equal(result.status, 'cancelled');
  });

  it('record-decision via CLI', () => {
    const { runId } = setupRunWithFindings(tmpDir, 'correctness', 2);
    const { exitCode, stdout } = runCli([
      'record-decision',
      '--run', runId,
      '--stage', 'correctness',
      '--finding', 'correctness-1',
      '--decision', 'valid',
      '--action', 'fixed',
      '--rationale', 'test fix',
      '--files-changed', 'a.js,b.js',
      '--evidence', 'checked it'
    ], tmpDir);
    assert.equal(exitCode, 0);
    const result = JSON.parse(stdout);
    assert.equal(result.ok, true);
    assert.equal(result.findingId, 'correctness-1');
  });

  it('next-finding --wait via CLI returns finding when one is already available', () => {
    const { runId } = setupRunWithFindings(tmpDir, 'correctness', 1);
    const { exitCode, stdout } = runCli(['next-finding', '--run', runId, '--wait', '1'], tmpDir);
    assert.equal(exitCode, 0);
    const result = JSON.parse(stdout);
    assert.equal(result.status, 'finding');
    assert.equal(result.finding.id, 'correctness-1');
  });

  it('next-finding --wait via CLI rejects zero seconds', () => {
    const { runId } = setupRunWithFindings(tmpDir, 'correctness', 1);
    const { exitCode, stderr } = runCli(['next-finding', '--run', runId, '--wait', '0'], tmpDir);
    assert.notEqual(exitCode, 0);
    assert.match(stderr, /positive number/);
  });

  it('next-finding --wait via CLI rejects non-numeric value', () => {
    const { runId } = setupRunWithFindings(tmpDir, 'correctness', 1);
    const { exitCode, stderr } = runCli(['next-finding', '--run', runId, '--wait', 'abc'], tmpDir);
    assert.notEqual(exitCode, 0);
    assert.match(stderr, /positive number/);
  });
});

