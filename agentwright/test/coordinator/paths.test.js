'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  validateRunId,
  validateStageName,
  assertPathWithin,
  getManagedSnapshotRoot,
  expectedGroupSnapshotPath,
  ensureAuditBase,
  runDir,
  runFile,
  summaryFile,
  groupSnapshotFile,
  stageDir,
  stageFindingsQueueFile,
  stageDecisionsFile,
  stageMetaFile,
  stageVerifierFile,
  stageLogsDir
} = require('../../coordinator/paths');

describe('paths', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paths-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('validateRunId', () => {
    it('accepts valid run IDs', () => {
      assert.equal(validateRunId('2026-04-01T14-41-10-870Z-f17e30fd'), '2026-04-01T14-41-10-870Z-f17e30fd');
      assert.equal(validateRunId('abc123'), 'abc123');
      assert.equal(validateRunId('run.1'), 'run.1');
    });

    it('rejects empty string', () => {
      assert.throws(() => validateRunId(''), /Invalid run ID/);
    });

    it('rejects path traversal characters', () => {
      assert.throws(() => validateRunId('../etc'), /Invalid run ID/);
      assert.throws(() => validateRunId('run/../../bad'), /Invalid run ID/);
    });

    it('rejects non-string input', () => {
      assert.throws(() => validateRunId(null), /Invalid run ID/);
      assert.throws(() => validateRunId(undefined), /Invalid run ID/);
      assert.throws(() => validateRunId(123), /Invalid run ID/);
    });
  });

  describe('validateStageName', () => {
    it('accepts valid stage names', () => {
      assert.equal(validateStageName('correctness'), 'correctness');
      assert.equal(validateStageName('best-practices'), 'best-practices');
      assert.equal(validateStageName('tests_edge'), 'tests_edge');
    });

    it('rejects empty or non-string input', () => {
      assert.throws(() => validateStageName(''), /Invalid stage name/);
      assert.throws(() => validateStageName(null), /Invalid stage name/);
    });

    it('rejects path traversal', () => {
      assert.throws(() => validateStageName('../etc'), /Invalid stage name/);
    });
  });

  describe('assertPathWithin', () => {
    it('accepts paths within the base', () => {
      const sub = path.join(tmpDir, 'sub');
      fs.mkdirSync(sub, { recursive: true });
      const result = assertPathWithin(tmpDir, sub, 'Test');
      assert.ok(result);
    });

    it('rejects paths outside the base', () => {
      assert.throws(
        () => assertPathWithin(tmpDir, path.join(tmpDir, '..', '..', 'etc'), 'Test'),
        /escaped the managed directory/
      );
    });
  });

  describe('getManagedSnapshotRoot', () => {
    it('returns a path under os.tmpdir()', () => {
      const root = getManagedSnapshotRoot();
      assert.ok(root.startsWith(os.tmpdir()));
      assert.ok(root.includes('agentwright-snapshots'));
    });
  });

  describe('expectedGroupSnapshotPath', () => {
    it('returns path with run ID and group index', () => {
      const p = expectedGroupSnapshotPath('test-run', 0);
      assert.ok(p.includes('test-run'));
      assert.ok(p.includes('group-0'));
    });
  });

  describe('ensureAuditBase', () => {
    it('creates .claude/audit-runs directory', () => {
      const base = ensureAuditBase(tmpDir);
      assert.ok(fs.existsSync(base));
      assert.ok(base.endsWith('audit-runs'));
    });
  });

  describe('path builders', () => {
    it('runDir contains the run ID', () => {
      const dir = runDir(tmpDir, 'my-run');
      assert.ok(dir.includes('my-run'));
    });

    it('runFile ends with run.json', () => {
      assert.ok(runFile(tmpDir, 'my-run').endsWith('run.json'));
    });

    it('summaryFile ends with summary.json', () => {
      assert.ok(summaryFile(tmpDir, 'my-run').endsWith('summary.json'));
    });

    it('groupSnapshotFile contains group index', () => {
      const f = groupSnapshotFile(tmpDir, 'my-run', 2);
      assert.ok(f.includes('group-2-snapshot.json'));
    });

    it('stageDir contains stage name', () => {
      assert.ok(stageDir(tmpDir, 'my-run', 'security').includes('security'));
    });

    it('stageFindingsQueueFile ends with findings.jsonl', () => {
      assert.ok(stageFindingsQueueFile(tmpDir, 'my-run', 'security').endsWith('findings.jsonl'));
    });

    it('stageDecisionsFile ends with decisions.json', () => {
      assert.ok(stageDecisionsFile(tmpDir, 'my-run', 'security').endsWith('decisions.json'));
    });

    it('stageMetaFile ends with meta.json', () => {
      assert.ok(stageMetaFile(tmpDir, 'my-run', 'security').endsWith('meta.json'));
    });

    it('stageVerifierFile ends with verifier.json', () => {
      assert.ok(stageVerifierFile(tmpDir, 'my-run', 'security').endsWith('verifier.json'));
    });

    it('stageLogsDir ends with logs', () => {
      assert.ok(stageLogsDir(tmpDir, 'my-run', 'security').endsWith('logs'));
    });
  });
});
