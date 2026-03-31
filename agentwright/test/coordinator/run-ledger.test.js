'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  withRunLock,
  mutateRun,
  createRun,
  loadRun,
  loadRunWithLiveStatus,
  getCurrentStage,
  getCurrentGroup,
  updateStageStatus,
  updateGroupStatus,
  cleanupCompletedStageArtifacts,
  cleanupCompletedGroupArtifacts,
  pruneTerminalRuns,
  listRuns
} = require('../../coordinator/run-ledger');
const {
  ensureAuditBase,
  getManagedSnapshotRoot,
  expectedGroupSnapshotPath,
  validateRunId,
  validateStageName,
  assertPathWithin,
  runDir,
  runFile,
  summaryFile,
  groupSnapshotFile,
  stageFindingsQueueFile,
  stageDecisionsFile,
  stageMetaFile,
  stageVerifierFile,
  stageLogsDir
} = require('../../coordinator/paths');
const { writeJson, appendJsonLine, readJson, readJsonLines } = require('../../coordinator/io');

describe('run-ledger', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // --- Validation ---

  describe('validateRunId', () => {
    it('accepts valid run IDs', () => {
      assert.equal(validateRunId('abc-123'), 'abc-123');
      assert.equal(validateRunId('2026-03-28T00-00-00-000Z-abcd1234'), '2026-03-28T00-00-00-000Z-abcd1234');
      assert.equal(validateRunId('run.1'), 'run.1');
    });

    it('rejects invalid run IDs', () => {
      assert.throws(() => validateRunId(''), /Invalid run ID/);
      assert.throws(() => validateRunId(null), /Invalid run ID/);
      assert.throws(() => validateRunId('.bad'), /Invalid run ID/);
      assert.throws(() => validateRunId('-bad'), /Invalid run ID/);
      assert.throws(() => validateRunId('has space'), /Invalid run ID/);
      assert.throws(() => validateRunId('has/slash'), /Invalid run ID/);
    });
  });

  describe('validateStageName', () => {
    it('accepts valid stage names', () => {
      assert.equal(validateStageName('correctness'), 'correctness');
      assert.equal(validateStageName('best-practices'), 'best-practices');
      assert.equal(validateStageName('test_frontend'), 'test_frontend');
    });

    it('rejects invalid stage names', () => {
      assert.throws(() => validateStageName(''), /Invalid stage name/);
      assert.throws(() => validateStageName(null), /Invalid stage name/);
      assert.throws(() => validateStageName('-bad'), /Invalid stage name/);
      assert.throws(() => validateStageName('_bad'), /Invalid stage name/);
      assert.throws(() => validateStageName('has space'), /Invalid stage name/);
    });
  });

  describe('assertPathWithin', () => {
    it('accepts paths within base', () => {
      const result = assertPathWithin(tmpDir, path.join(tmpDir, 'sub', 'file'));
      assert.ok(result);
    });

    it('accepts equal paths', () => {
      const result = assertPathWithin(tmpDir, tmpDir);
      assert.ok(result);
    });

    it('rejects paths outside base', () => {
      assert.throws(
        () => assertPathWithin(tmpDir, path.join(tmpDir, '..', 'escape'), 'Test'),
        /escaped/
      );
    });
  });

  // --- JSON utils ---

  describe('writeJson / readJson', () => {
    it('round-trips JSON data', () => {
      const filePath = path.join(tmpDir, 'test.json');
      writeJson(filePath, { key: 'value', num: 42 });
      const result = readJson(filePath);
      assert.deepEqual(result, { key: 'value', num: 42 });
    });

    it('creates parent directories', () => {
      const filePath = path.join(tmpDir, 'deep', 'nested', 'test.json');
      writeJson(filePath, { ok: true });
      assert.deepEqual(readJson(filePath), { ok: true });
    });

    it('returns fallback for missing file', () => {
      assert.equal(readJson(path.join(tmpDir, 'nope.json')), null);
      assert.deepEqual(readJson(path.join(tmpDir, 'nope.json'), []), []);
    });

    it('returns fallback on corrupt JSON', () => {
      const filePath = path.join(tmpDir, 'bad.json');
      fs.writeFileSync(filePath, 'not json', 'utf8');
      assert.equal(readJson(filePath), null);
      assert.deepEqual(readJson(filePath, { recovered: true }), { recovered: true });
    });
  });

  describe('appendJsonLine / readJsonLines', () => {
    it('appends and reads multiple JSON lines', () => {
      const filePath = path.join(tmpDir, 'test.jsonl');
      appendJsonLine(filePath, { type: 'a', id: 1 });
      appendJsonLine(filePath, { type: 'b', id: 2 });
      appendJsonLine(filePath, { type: 'c', id: 3 });
      const lines = readJsonLines(filePath);
      assert.equal(lines.length, 3);
      assert.equal(lines[0].type, 'a');
      assert.equal(lines[2].id, 3);
    });

    it('returns fallback for missing file', () => {
      assert.deepEqual(readJsonLines(path.join(tmpDir, 'nope.jsonl')), []);
      assert.deepEqual(readJsonLines(path.join(tmpDir, 'nope.jsonl'), [{ default: true }]), [{ default: true }]);
    });

    it('skips blank lines and corrupt lines', () => {
      const filePath = path.join(tmpDir, 'mixed.jsonl');
      fs.writeFileSync(filePath, '{"ok":true}\n\nnot json\n{"ok":false}\n', 'utf8');
      const lines = readJsonLines(filePath);
      assert.equal(lines.length, 2);
      assert.equal(lines[0].ok, true);
      assert.equal(lines[1].ok, false);
    });

    it('creates parent directories', () => {
      const filePath = path.join(tmpDir, 'deep', 'test.jsonl');
      appendJsonLine(filePath, { ok: true });
      assert.equal(readJsonLines(filePath).length, 1);
    });
  });

  // --- ensureAuditBase ---

  describe('ensureAuditBase', () => {
    it('creates .claude/audit-runs directory', () => {
      const base = ensureAuditBase(tmpDir);
      assert.ok(fs.existsSync(base));
      assert.ok(base.endsWith('audit-runs'));
    });

    it('is idempotent', () => {
      const first = ensureAuditBase(tmpDir);
      const second = ensureAuditBase(tmpDir);
      assert.equal(first, second);
    });
  });

  // --- Path builders ---

  describe('path builders', () => {
    const runId = 'test-run-1';

    it('runDir builds correct path', () => {
      const result = runDir(tmpDir, runId);
      assert.ok(result.includes('audit-runs'));
      assert.ok(result.endsWith(runId));
    });

    it('runFile ends with run.json', () => {
      assert.ok(runFile(tmpDir, runId).endsWith('run.json'));
    });

    it('summaryFile ends with summary.json', () => {
      assert.ok(summaryFile(tmpDir, runId).endsWith('summary.json'));
    });

    it('groupSnapshotFile includes group index', () => {
      assert.ok(groupSnapshotFile(tmpDir, runId, 0).includes('group-0-snapshot.json'));
    });

    it('stage file builders use per-stage subdirectories', () => {
      const sep = path.sep === '\\' ? '\\\\' : '/';
      const pattern = new RegExp(`stages${sep}correctness${sep}`);
      assert.ok(pattern.test(stageFindingsQueueFile(tmpDir, runId, 'correctness')));
      assert.ok(stageFindingsQueueFile(tmpDir, runId, 'correctness').endsWith('findings.jsonl'));
      assert.ok(stageDecisionsFile(tmpDir, runId, 'correctness').endsWith('decisions.json'));
      assert.ok(stageMetaFile(tmpDir, runId, 'correctness').endsWith('meta.json'));
      assert.ok(stageVerifierFile(tmpDir, runId, 'correctness').endsWith('verifier.json'));
      assert.ok(stageLogsDir(tmpDir, runId, 'correctness').endsWith('logs'));
    });

    it('stage file builders reject invalid stage names', () => {
      assert.throws(() => stageFindingsQueueFile(tmpDir, runId, '-bad'));
      assert.throws(() => stageMetaFile(tmpDir, runId, ''));
    });
  });

  // --- Snapshot path helpers ---

  describe('getManagedSnapshotRoot', () => {
    it('returns a path under os.tmpdir', () => {
      const root = getManagedSnapshotRoot();
      assert.ok(root.startsWith(os.tmpdir()));
      assert.ok(root.includes('agentwright-snapshots'));
    });
  });

  describe('expectedGroupSnapshotPath', () => {
    it('builds expected path', () => {
      const result = expectedGroupSnapshotPath('run-1', 0);
      assert.ok(result.includes('run-1-group-0'));
    });

    it('rejects invalid run ID', () => {
      assert.throws(() => expectedGroupSnapshotPath('.bad', 0));
    });
  });

  // --- createRun / loadRun ---

  describe('createRun / loadRun', () => {
    const spec = {
      pipelineName: 'default',
      groups: [['correctness'], ['security']],
      stages: ['correctness', 'security'],
      scope: '--diff'
    };

    it('creates a run with correct structure', () => {
      const run = createRun(tmpDir, spec);
      assert.ok(run.runId);
      assert.equal(run.status, 'running');
      assert.equal(run.scope, '--diff');
      assert.equal(run.pipelineName, 'default');
      assert.equal(run.currentGroupIndex, 0);
      assert.deepEqual(run.activeStages, ['correctness']);
      assert.equal(run.auditor, null);
      assert.equal(run.groups.length, 2);
      assert.equal(run.stages.length, 2);
    });

    it('persists run.json to disk', () => {
      const run = createRun(tmpDir, spec);
      assert.ok(fs.existsSync(runFile(tmpDir, run.runId)));
    });

    it('persists summary.json to disk', () => {
      const run = createRun(tmpDir, spec);
      const summary = readJson(summaryFile(tmpDir, run.runId));
      assert.equal(summary.runId, run.runId);
      assert.deepEqual(summary.completedStages, []);
    });

    it('loadRun retrieves persisted run', () => {
      const run = createRun(tmpDir, spec);
      const loaded = loadRun(tmpDir, run.runId);
      assert.equal(loaded.runId, run.runId);
      assert.equal(loaded.status, 'running');
    });

    it('loadRun throws for unknown run', () => {
      assert.throws(() => loadRun(tmpDir, 'nonexistent-run'), /Unknown run ID/);
    });

    it('stage groupIndex is correctly assigned', () => {
      const run = createRun(tmpDir, spec);
      const correctness = run.stages.find(s => s.name === 'correctness');
      const security = run.stages.find(s => s.name === 'security');
      assert.equal(correctness.groupIndex, 0);
      assert.equal(security.groupIndex, 1);
    });

    it('handles parallel groups', () => {
      const parallelSpec = {
        pipelineName: null,
        groups: [['correctness', 'security']],
        stages: ['correctness', 'security'],
        scope: 'src/'
      };
      const run = createRun(tmpDir, parallelSpec);
      assert.equal(run.groups.length, 1);
      assert.deepEqual(run.groups[0].stages, ['correctness', 'security']);
      assert.deepEqual(run.activeStages, ['correctness', 'security']);
      const correctness = run.stages.find(s => s.name === 'correctness');
      const security = run.stages.find(s => s.name === 'security');
      assert.equal(correctness.groupIndex, 0);
      assert.equal(security.groupIndex, 0);
    });

    it('handles empty first group gracefully', () => {
      const emptySpec = {
        pipelineName: null,
        groups: [],
        stages: [],
        scope: '--diff'
      };
      const run = createRun(tmpDir, emptySpec);
      assert.deepEqual(run.activeStages, []);
    });
  });

  // --- getCurrentGroup / getCurrentStage ---

  describe('getCurrentGroup', () => {
    it('returns first group when currentGroupIndex is 0', () => {
      const run = createRun(tmpDir, {
        pipelineName: null,
        groups: [['correctness'], ['security']],
        stages: ['correctness', 'security'],
        scope: '--diff'
      });
      const group = getCurrentGroup(run);
      assert.deepEqual(group.stages, ['correctness']);
      assert.equal(group.index, 0);
    });

    it('returns null when past all groups', () => {
      const run = createRun(tmpDir, {
        pipelineName: null,
        groups: [['correctness']],
        stages: ['correctness'],
        scope: '--diff'
      });
      run.currentGroupIndex = 99;
      assert.equal(getCurrentGroup(run), null);
    });
  });

  describe('getCurrentStage', () => {
    it('returns the first non-completed stage in current group', () => {
      const run = createRun(tmpDir, {
        pipelineName: null,
        groups: [['correctness', 'security']],
        stages: ['correctness', 'security'],
        scope: '--diff'
      });
      const stage = getCurrentStage(run);
      assert.equal(stage.name, 'correctness');
    });

    it('skips completed stages', () => {
      const run = createRun(tmpDir, {
        pipelineName: null,
        groups: [['correctness', 'security']],
        stages: ['correctness', 'security'],
        scope: '--diff'
      });
      run.stages[0].status = 'completed';
      const stage = getCurrentStage(run);
      assert.equal(stage.name, 'security');
    });

    it('returns null when all stages in group are completed', () => {
      const run = createRun(tmpDir, {
        pipelineName: null,
        groups: [['correctness']],
        stages: ['correctness'],
        scope: '--diff'
      });
      run.stages[0].status = 'completed';
      assert.equal(getCurrentStage(run), null);
    });

    it('returns null when past all groups', () => {
      const run = createRun(tmpDir, {
        pipelineName: null,
        groups: [['correctness']],
        stages: ['correctness'],
        scope: '--diff'
      });
      run.currentGroupIndex = 99;
      assert.equal(getCurrentStage(run), null);
    });
  });

  // --- Locking ---

  describe('withRunLock', () => {
    it('executes callback and returns result', () => {
      const run = createRun(tmpDir, {
        pipelineName: null,
        groups: [['correctness']],
        stages: ['correctness'],
        scope: '--diff'
      });
      const result = withRunLock(tmpDir, run.runId, () => 42);
      assert.equal(result, 42);
    });

    it('releases lock after callback', () => {
      const run = createRun(tmpDir, {
        pipelineName: null,
        groups: [['correctness']],
        stages: ['correctness'],
        scope: '--diff'
      });
      withRunLock(tmpDir, run.runId, () => {});
      // Should be able to acquire again immediately
      withRunLock(tmpDir, run.runId, () => {});
    });

    it('releases lock on callback error', () => {
      const run = createRun(tmpDir, {
        pipelineName: null,
        groups: [['correctness']],
        stages: ['correctness'],
        scope: '--diff'
      });
      assert.throws(() => withRunLock(tmpDir, run.runId, () => { throw new Error('boom'); }));
      // Should be able to acquire again
      withRunLock(tmpDir, run.runId, () => {});
    });
  });

  // --- mutateRun ---

  describe('mutateRun', () => {
    it('applies mutation and persists', () => {
      const run = createRun(tmpDir, {
        pipelineName: null,
        groups: [['correctness']],
        stages: ['correctness'],
        scope: '--diff'
      });
      mutateRun(tmpDir, run.runId, r => {
        r.scope = 'new-scope';
        return r;
      });
      const loaded = loadRun(tmpDir, run.runId);
      assert.equal(loaded.scope, 'new-scope');
    });

    it('updates updatedAt timestamp', () => {
      const run = createRun(tmpDir, {
        pipelineName: null,
        groups: [['correctness']],
        stages: ['correctness'],
        scope: '--diff'
      });
      const before = run.updatedAt;
      mutateRun(tmpDir, run.runId, r => r);
      const loaded = loadRun(tmpDir, run.runId);
      assert.notEqual(loaded.updatedAt, before);
    });

    it('handles callback returning undefined (uses original)', () => {
      const run = createRun(tmpDir, {
        pipelineName: null,
        groups: [['correctness']],
        stages: ['correctness'],
        scope: '--diff'
      });
      mutateRun(tmpDir, run.runId, r => { r.scope = 'mutated'; });
      const loaded = loadRun(tmpDir, run.runId);
      assert.equal(loaded.scope, 'mutated');
    });

    it('throws for unknown run', () => {
      // Create the run directory so the lock can be acquired, but no run.json inside
      const fakeRunDir = runDir(tmpDir, 'nonexistent-run');
      fs.mkdirSync(fakeRunDir, { recursive: true });
      assert.throws(() => mutateRun(tmpDir, 'nonexistent-run', r => r), /Unknown run ID/);
    });
  });

  // --- updateStageStatus / updateGroupStatus ---

  describe('updateStageStatus', () => {
    it('updates stage status', () => {
      const run = createRun(tmpDir, {
        pipelineName: null,
        groups: [['correctness']],
        stages: ['correctness'],
        scope: '--diff'
      });
      updateStageStatus(tmpDir, run.runId, 'correctness', 'auditing', { findingsCount: 0 });
      const loaded = loadRun(tmpDir, run.runId);
      const stage = loaded.stages.find(s => s.name === 'correctness');
      assert.equal(stage.status, 'auditing');
      assert.equal(stage.findingsCount, 0);
    });

    it('accepts run object as second arg', () => {
      const run = createRun(tmpDir, {
        pipelineName: null,
        groups: [['correctness']],
        stages: ['correctness'],
        scope: '--diff'
      });
      updateStageStatus(tmpDir, run.runId, 'correctness', 'auditing');
      const loaded = loadRun(tmpDir, run.runId);
      assert.equal(loaded.stages[0].status, 'auditing');
    });

    it('throws for unknown stage', () => {
      const run = createRun(tmpDir, {
        pipelineName: null,
        groups: [['correctness']],
        stages: ['correctness'],
        scope: '--diff'
      });
      assert.throws(
        () => updateStageStatus(tmpDir, run.runId, 'nonexistent', 'auditing'),
        /Unknown stage/
      );
    });
  });

  describe('updateGroupStatus', () => {
    it('updates group status', () => {
      const run = createRun(tmpDir, {
        pipelineName: null,
        groups: [['correctness']],
        stages: ['correctness'],
        scope: '--diff'
      });
      updateGroupStatus(tmpDir, run.runId, 0, 'auditing', { snapshotFile: 'snap.json' });
      const loaded = loadRun(tmpDir, run.runId);
      assert.equal(loaded.groups[0].status, 'auditing');
      assert.equal(loaded.groups[0].snapshotFile, 'snap.json');
    });

    it('throws for unknown group index', () => {
      const run = createRun(tmpDir, {
        pipelineName: null,
        groups: [['correctness']],
        stages: ['correctness'],
        scope: '--diff'
      });
      assert.throws(
        () => updateGroupStatus(tmpDir, run.runId, 99, 'auditing'),
        /Unknown group/
      );
    });
  });

  // --- listRuns ---

  describe('listRuns', () => {
    it('returns empty when no runs', () => {
      assert.deepEqual(listRuns(tmpDir), []);
    });

    it('lists created runs', () => {
      createRun(tmpDir, { pipelineName: null, groups: [['correctness']], stages: ['correctness'], scope: '--diff' });
      createRun(tmpDir, { pipelineName: null, groups: [['security']], stages: ['security'], scope: '--diff' });
      const runs = listRuns(tmpDir);
      assert.equal(runs.length, 2);
    });

    it('ignores directories without run.json', () => {
      ensureAuditBase(tmpDir);
      fs.mkdirSync(path.join(tmpDir, '.claude', 'audit-runs', 'not-a-run'), { recursive: true });
      assert.equal(listRuns(tmpDir).length, 0);
    });
  });

  // --- cleanupCompletedStageArtifacts ---

  describe('cleanupCompletedStageArtifacts', () => {
    it('deletes logs when retention.deleteCompletedLogs is true', () => {
      const run = createRun(tmpDir, { pipelineName: null, groups: [['correctness']], stages: ['correctness'], scope: '--diff' });
      const logsPath = stageLogsDir(tmpDir, run.runId, 'correctness');
      fs.mkdirSync(logsPath, { recursive: true });
      fs.writeFileSync(path.join(logsPath, 'log.txt'), 'log', 'utf8');
      cleanupCompletedStageArtifacts(tmpDir, run.runId, 'correctness', { deleteCompletedLogs: true, deleteCompletedFindings: false });
      assert.ok(!fs.existsSync(logsPath));
    });

    it('deletes findings queue when retention.deleteCompletedFindings is true', () => {
      const run = createRun(tmpDir, { pipelineName: null, groups: [['correctness']], stages: ['correctness'], scope: '--diff' });
      appendJsonLine(stageFindingsQueueFile(tmpDir, run.runId, 'correctness'), { type: 'finding' });
      cleanupCompletedStageArtifacts(tmpDir, run.runId, 'correctness', { deleteCompletedLogs: false, deleteCompletedFindings: true });
      assert.ok(!fs.existsSync(stageFindingsQueueFile(tmpDir, run.runId, 'correctness')));
    });

    it('preserves artifacts when retention flags are false', () => {
      const run = createRun(tmpDir, { pipelineName: null, groups: [['correctness']], stages: ['correctness'], scope: '--diff' });
      const logsPath = stageLogsDir(tmpDir, run.runId, 'correctness');
      fs.mkdirSync(logsPath, { recursive: true });
      appendJsonLine(stageFindingsQueueFile(tmpDir, run.runId, 'correctness'), { type: 'finding' });
      cleanupCompletedStageArtifacts(tmpDir, run.runId, 'correctness', { deleteCompletedLogs: false, deleteCompletedFindings: false });
      assert.ok(fs.existsSync(logsPath));
      assert.ok(fs.existsSync(stageFindingsQueueFile(tmpDir, run.runId, 'correctness')));
    });
  });

  // --- pruneTerminalRuns ---

  describe('pruneTerminalRuns', () => {
    function createCompletedRun(cwd, updatedAt) {
      const run = createRun(cwd, { pipelineName: null, groups: [['correctness']], stages: ['correctness'], scope: '--diff' });
      // Write directly to avoid mutateRun overriding updatedAt
      const filePath = runFile(cwd, run.runId);
      const data = readJson(filePath);
      data.status = 'completed';
      data.updatedAt = updatedAt || new Date().toISOString();
      writeJson(filePath, data);
      return run;
    }

    it('does not prune running runs', () => {
      createRun(tmpDir, { pipelineName: null, groups: [['correctness']], stages: ['correctness'], scope: '--diff' });
      const removed = pruneTerminalRuns(tmpDir, { keepCompletedRuns: 0, maxRunAgeDays: 0 });
      assert.equal(removed.length, 0);
    });

    it('prunes completed runs over keep limit', () => {
      createCompletedRun(tmpDir);
      createCompletedRun(tmpDir);
      createCompletedRun(tmpDir);
      const removed = pruneTerminalRuns(tmpDir, { keepCompletedRuns: 1, maxRunAgeDays: 0 });
      assert.equal(removed.length, 2);
    });

    it('prunes old completed runs by age', () => {
      const oldDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      const recentDate = new Date().toISOString();
      createCompletedRun(tmpDir, oldDate);
      createCompletedRun(tmpDir, recentDate);
      const removed = pruneTerminalRuns(tmpDir, { keepCompletedRuns: 100, maxRunAgeDays: 14 });
      assert.equal(removed.length, 1);
      // The recent one should survive
      assert.equal(listRuns(tmpDir).filter(r => r.run.status === 'completed').length, 1);
    });

    it('respects excludeRunIds', () => {
      const run = createCompletedRun(tmpDir);
      const removed = pruneTerminalRuns(tmpDir, { keepCompletedRuns: 0, maxRunAgeDays: 0 }, { excludeRunIds: [run.runId] });
      assert.equal(removed.length, 0);
    });

    it('actually deletes the run directory', () => {
      const run = createCompletedRun(tmpDir);
      const dir = runDir(tmpDir, run.runId);
      assert.ok(fs.existsSync(dir));
      pruneTerminalRuns(tmpDir, { keepCompletedRuns: 0, maxRunAgeDays: 0 });
      assert.ok(!fs.existsSync(dir));
    });
  });

  // --- loadRunWithLiveStatus ---

  describe('loadRunWithLiveStatus', () => {
    const spec = {
      pipelineName: null,
      groups: [['correctness']],
      stages: ['correctness'],
      scope: '--diff'
    };

    it('returns base run when no stages are auditing', () => {
      const run = createRun(tmpDir, spec);
      const live = loadRunWithLiveStatus(tmpDir, run.runId);
      assert.equal(live.stages[0].status, 'pending');
      assert.equal(live.stages[0].findingsCount, undefined);
    });

    it('merges emittedCount into findingsCount for auditing stage', () => {
      const run = createRun(tmpDir, spec);
      updateStageStatus(tmpDir, run.runId, 'correctness', 'auditing', { findingsCount: 0 });
      writeJson(stageMetaFile(tmpDir, run.runId, 'correctness'), {
        stage: 'correctness',
        status: 'auditing',
        emittedCount: 5,
        auditDone: false
      });
      const live = loadRunWithLiveStatus(tmpDir, run.runId);
      const stage = live.stages.find(s => s.name === 'correctness');
      assert.equal(stage.status, 'fixing_live');
      assert.equal(stage.findingsCount, 5);
    });

    it('does not touch stages in terminal statuses', () => {
      const run = createRun(tmpDir, spec);
      updateStageStatus(tmpDir, run.runId, 'correctness', 'awaiting_verification_completion', { findingsCount: 3 });
      writeJson(stageMetaFile(tmpDir, run.runId, 'correctness'), {
        stage: 'correctness',
        emittedCount: 99
      });
      const live = loadRunWithLiveStatus(tmpDir, run.runId);
      const stage = live.stages.find(s => s.name === 'correctness');
      assert.equal(stage.status, 'awaiting_verification_completion');
      assert.equal(stage.findingsCount, 3);
    });

    it('handles missing meta file gracefully', () => {
      const run = createRun(tmpDir, spec);
      updateStageStatus(tmpDir, run.runId, 'correctness', 'auditing', { findingsCount: 0 });
      // No meta file written
      const live = loadRunWithLiveStatus(tmpDir, run.runId);
      const stage = live.stages.find(s => s.name === 'correctness');
      assert.equal(stage.status, 'auditing');
    });

    it('keeps auditing status when emittedCount is 0', () => {
      const run = createRun(tmpDir, spec);
      updateStageStatus(tmpDir, run.runId, 'correctness', 'auditing', { findingsCount: 0 });
      writeJson(stageMetaFile(tmpDir, run.runId, 'correctness'), {
        stage: 'correctness',
        status: 'auditing',
        emittedCount: 0,
        auditDone: false
      });
      const live = loadRunWithLiveStatus(tmpDir, run.runId);
      const stage = live.stages.find(s => s.name === 'correctness');
      assert.equal(stage.status, 'auditing');
      assert.equal(stage.findingsCount, 0);
    });
  });
});
