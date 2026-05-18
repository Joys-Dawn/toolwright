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
  projectSnapshotKey,
  getManagedSnapshotRoot,
  getClaudeProjectsDir,
  claudeProjectSlug,
  managedSnapshotProjectSlugPrefix,
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

  describe('projectSnapshotKey', () => {
    it('produces a stable key for the same cwd across calls', () => {
      const a = projectSnapshotKey(tmpDir);
      const b = projectSnapshotKey(tmpDir);
      assert.equal(a, b);
    });

    it('produces different keys for different cwds', () => {
      const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paths-test-other-'));
      try {
        assert.notEqual(projectSnapshotKey(tmpDir), projectSnapshotKey(otherDir));
      } finally {
        fs.rmSync(otherDir, { recursive: true, force: true });
      }
    });

    it('embeds a basename slug for human readability', () => {
      const key = projectSnapshotKey(tmpDir);
      assert.ok(key.startsWith(path.basename(tmpDir).slice(0, 32)));
    });

    it('falls back to path.resolve for non-existent cwd', () => {
      const ghost = path.join(os.tmpdir(), 'paths-test-does-not-exist-' + Date.now());
      const key = projectSnapshotKey(ghost);
      assert.ok(/^[A-Za-z0-9._-]+-[0-9a-f]{12}$/.test(key));
    });
  });

  describe('getManagedSnapshotRoot', () => {
    it('returns a path under os.tmpdir() namespaced by cwd', () => {
      const root = getManagedSnapshotRoot(tmpDir);
      assert.ok(root.startsWith(os.tmpdir()));
      assert.ok(root.includes('agentwright-snapshots'));
      assert.ok(root.endsWith(projectSnapshotKey(tmpDir)));
    });

    it('isolates two different cwds into different roots', () => {
      const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paths-test-other-'));
      try {
        assert.notEqual(getManagedSnapshotRoot(tmpDir), getManagedSnapshotRoot(otherDir));
      } finally {
        fs.rmSync(otherDir, { recursive: true, force: true });
      }
    });

    it('throws when called without a cwd', () => {
      assert.throws(() => getManagedSnapshotRoot(), /requires a cwd/);
      assert.throws(() => getManagedSnapshotRoot(null), /requires a cwd/);
    });
  });

  describe('getClaudeProjectsDir', () => {
    const ORIGINAL = process.env.CLAUDE_CONFIG_DIR;
    afterEach(() => {
      if (ORIGINAL === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = ORIGINAL;
    });

    it('honors CLAUDE_CONFIG_DIR when set', () => {
      process.env.CLAUDE_CONFIG_DIR = path.join(tmpDir, 'cfg');
      assert.equal(getClaudeProjectsDir(), path.join(tmpDir, 'cfg', 'projects'));
    });

    it('falls back to ~/.claude/projects when unset or blank', () => {
      delete process.env.CLAUDE_CONFIG_DIR;
      assert.equal(getClaudeProjectsDir(), path.join(os.homedir(), '.claude', 'projects'));
      process.env.CLAUDE_CONFIG_DIR = '   ';
      assert.equal(getClaudeProjectsDir(), path.join(os.homedir(), '.claude', 'projects'));
    });
  });

  describe('claudeProjectSlug', () => {
    it('replaces every non-alphanumeric char with a dash', () => {
      // Verified first-party against on-disk ~/.claude/projects entries.
      assert.equal(claudeProjectSlug('C:\\Users\\y\\AI_engineering'), 'C--Users-y-AI-engineering');
    });

    it('does NOT collapse consecutive separators (": \\" -> "--")', () => {
      assert.equal(claudeProjectSlug('C:\\a'), 'C--a');
    });

    it('preserves case and treats underscore as non-alphanumeric', () => {
      assert.equal(claudeProjectSlug('HxH_DnD'), 'HxH-DnD');
    });
  });

  describe('managedSnapshotProjectSlugPrefix', () => {
    it('is the slug of the managed snapshot root plus a trailing dash', () => {
      const expected = claudeProjectSlug(getManagedSnapshotRoot(tmpDir)) + '-';
      assert.equal(managedSnapshotProjectSlugPrefix(tmpDir), expected);
    });

    it('embeds the agentwright-snapshots marker so it cannot match a user project', () => {
      const prefix = managedSnapshotProjectSlugPrefix(tmpDir);
      assert.ok(prefix.includes('agentwright-snapshots'));
      assert.ok(prefix.endsWith('-'));
    });

    it('a group snapshot dir slug starts with the prefix', () => {
      const snapDir = expectedGroupSnapshotPath(tmpDir, '2026-01-01T00-00-00-000Z-abcd1234', 0);
      assert.ok(claudeProjectSlug(snapDir).startsWith(managedSnapshotProjectSlugPrefix(tmpDir)));
    });
  });

  describe('expectedGroupSnapshotPath', () => {
    it('returns path with run ID and group index under the project root', () => {
      const p = expectedGroupSnapshotPath(tmpDir, 'test-run', 0);
      assert.ok(p.startsWith(getManagedSnapshotRoot(tmpDir)));
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
