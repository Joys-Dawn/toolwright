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
    fs.mkdirSync(path.join(tmpDir, '.claude'), { recursive: true });
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
    fs.writeFileSync(path.join(tmpDir, '.claude', 'agentwright.json'), JSON.stringify({
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

  it('writes failure meta when custom skillPath does not exist', () => {
    fs.writeFileSync(path.join(tmpDir, '.claude', 'agentwright.json'), JSON.stringify({
      customStages: {
        pathstage: { type: 'skill', skillPath: 'nonexistent/SKILL.md' }
      }
    }), 'utf8');

    const run = createRun(tmpDir, {
      pipelineName: null,
      groups: [['pathstage']],
      stages: ['pathstage'],
      scope: '--diff'
    });
    updateStageStatus(tmpDir, run.runId, 'pathstage', 'auditing');

    const snapshotPath = expectedGroupSnapshotPath(run.runId, 0);
    fs.mkdirSync(snapshotPath, { recursive: true });
    writeJson(groupSnapshotFile(tmpDir, run.runId, 0), {
      type: 'temp-copy',
      path: snapshotPath,
      createdAt: new Date().toISOString()
    });

    const result = runWorker([
      '--run', run.runId,
      '--stage', 'pathstage',
      '--group-index', '0'
    ], tmpDir);

    assert.equal(result.exitCode, 1);

    const meta = readJson(stageMetaFile(tmpDir, run.runId, 'pathstage'));
    assert.ok(meta);
    assert.equal(meta.auditDone, true);
    assert.equal(meta.auditSucceeded, false);
    assert.ok(meta.summary.includes('Custom skill file not found'));

    fs.rmSync(snapshotPath, { recursive: true, force: true });
  });

  describe('buildAuditorPrompt — fused stages', () => {
    const { buildAuditorPrompt, resolveSkillPaths } = require('../../coordinator/stage-worker');
    const PLUGIN_ROOT = path.resolve(__dirname, '../..');

    it('produces a single-skill prompt when stageDef has one skillId', () => {
      const prompt = buildAuditorPrompt({
        pluginRoot: PLUGIN_ROOT,
        cwd: tmpDir,
        stageName: 'correctness',
        stageDef: { type: 'skill', skillId: 'correctness-audit' },
        scope: '--diff',
        scopeMode: 'diff'
      });
      assert.ok(prompt.includes('Audit stage: correctness'));
      assert.ok(!prompt.includes('FUSED stage'));
      assert.ok(!prompt.includes('===== Skill:'));
      assert.ok(!prompt.includes('"auditType":"correctness-audit"'));
    });

    it('produces a fused prompt that lists every skill ID in the auditType instruction', () => {
      const prompt = buildAuditorPrompt({
        pluginRoot: PLUGIN_ROOT,
        cwd: tmpDir,
        stageName: 'audit-bundle',
        stageDef: {
          type: 'skill',
          skillIds: ['correctness-audit', 'security-audit', 'best-practices-audit']
        },
        scope: '--diff',
        scopeMode: 'diff'
      });
      assert.ok(prompt.includes('Audit stage: audit-bundle (fused: correctness-audit, security-audit, best-practices-audit)'));
      assert.ok(prompt.includes('FUSED stage running 3 audit types'));
      assert.ok(prompt.includes('"correctness-audit"'));
      assert.ok(prompt.includes('"security-audit"'));
      assert.ok(prompt.includes('"best-practices-audit"'));
      assert.ok(prompt.includes('===== Skill: correctness-audit ====='));
      assert.ok(prompt.includes('===== Skill: security-audit ====='));
      assert.ok(prompt.includes('===== Skill: best-practices-audit ====='));
      assert.ok(prompt.includes('"auditType":"correctness-audit|security-audit|best-practices-audit"'));
      assert.ok(prompt.includes(`{"type":"done","auditType":"audit-bundle"`));
    });

    it('resolveSkillPaths returns one entry for single-skill stages', () => {
      const skills = resolveSkillPaths({
        pluginRoot: PLUGIN_ROOT,
        cwd: tmpDir,
        stageName: 'correctness',
        stageDef: { type: 'skill', skillId: 'correctness-audit' }
      });
      assert.equal(skills.length, 1);
      assert.equal(skills[0].id, 'correctness-audit');
      assert.ok(skills[0].path.endsWith('SKILL.md'));
    });

    it('resolveSkillPaths returns N entries for fused stages, preserving order', () => {
      const skills = resolveSkillPaths({
        pluginRoot: PLUGIN_ROOT,
        cwd: tmpDir,
        stageName: 'audit-bundle',
        stageDef: {
          type: 'skill',
          skillIds: ['security-audit', 'correctness-audit']
        }
      });
      assert.equal(skills.length, 2);
      assert.deepEqual(skills.map(s => s.id), ['security-audit', 'correctness-audit']);
    });

    it('resolveSkillPaths throws when a fused skillIds entry is unknown', () => {
      assert.throws(() => resolveSkillPaths({
        pluginRoot: PLUGIN_ROOT,
        cwd: tmpDir,
        stageName: 'audit-bundle',
        stageDef: { type: 'skill', skillIds: ['correctness-audit', 'no-such-skill'] }
      }), /Vendored skill not found/);
    });
  });

  describe('resolveScopeMode', () => {
    const { resolveScopeMode } = require('../../coordinator/stage-worker');

    function initGitRepoWithCommittedFile(filename, contents) {
      execFileSync('git', ['init', '-q'], { cwd: tmpDir });
      execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmpDir });
      execFileSync('git', ['config', 'user.name', 'test'], { cwd: tmpDir });
      fs.writeFileSync(path.join(tmpDir, filename), contents);
      execFileSync('git', ['add', '.'], { cwd: tmpDir });
      execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: tmpDir });
    }

    it('returns full mode for --all on a git worktree snapshot', () => {
      const result = resolveScopeMode({
        scope: '--all',
        snapshot: { type: 'git-worktree', dirtyOverlay: true },
        cwd: tmpDir
      });
      assert.equal(result.scopeMode, 'full');
      assert.equal(result.effectiveScope, '');
    });

    it('returns full mode for --all on a temp-copy snapshot', () => {
      const result = resolveScopeMode({
        scope: '--all',
        snapshot: { type: 'temp-copy' },
        cwd: tmpDir
      });
      assert.equal(result.scopeMode, 'full');
      assert.equal(result.effectiveScope, '');
    });

    it('returns diff mode for --diff on a dirty git worktree', () => {
      const result = resolveScopeMode({
        scope: '--diff',
        snapshot: { type: 'git-worktree', dirtyOverlay: true },
        cwd: tmpDir
      });
      assert.equal(result.scopeMode, 'diff');
      assert.equal(result.effectiveScope, '--diff');
    });

    it('returns full mode for --diff on a clean git worktree', () => {
      const result = resolveScopeMode({
        scope: '--diff',
        snapshot: { type: 'git-worktree', dirtyOverlay: false },
        cwd: tmpDir
      });
      assert.equal(result.scopeMode, 'full');
    });

    it('returns targeted mode for a path scope', () => {
      const result = resolveScopeMode({
        scope: 'src/api/',
        snapshot: { type: 'git-worktree', dirtyOverlay: true },
        cwd: tmpDir
      });
      assert.equal(result.scopeMode, 'targeted');
      assert.equal(result.effectiveScope, 'src/api/');
    });

    it('returns targeted mode for --all-foo (a token that is not exactly --all)', () => {
      const result = resolveScopeMode({
        scope: '--all-foo',
        snapshot: { type: 'git-worktree', dirtyOverlay: true },
        cwd: tmpDir
      });
      assert.equal(result.scopeMode, 'targeted');
    });

    it('returns targeted mode for --diff-staged (a token that is not exactly --diff)', () => {
      const result = resolveScopeMode({
        scope: '--diff-staged',
        snapshot: { type: 'git-worktree', dirtyOverlay: true },
        cwd: tmpDir
      });
      assert.equal(result.scopeMode, 'targeted');
    });

    it('returns targeted with diff filenames for --diff on a temp-copy snapshot of a dirty git repo', () => {
      initGitRepoWithCommittedFile('tracked.js', 'const x = 1;');
      fs.writeFileSync(path.join(tmpDir, 'tracked.js'), 'const x = 2;');

      const result = resolveScopeMode({
        scope: '--diff',
        snapshot: { type: 'temp-copy' },
        cwd: tmpDir
      });
      assert.equal(result.scopeMode, 'targeted');
      assert.match(result.effectiveScope, /tracked\.js/);
    });

    it('returns full for --diff on a temp-copy snapshot of a clean git repo', () => {
      initGitRepoWithCommittedFile('tracked.js', 'const x = 1;');

      const result = resolveScopeMode({
        scope: '--diff',
        snapshot: { type: 'temp-copy' },
        cwd: tmpDir
      });
      assert.equal(result.scopeMode, 'full');
    });

    it('returns full for --diff on a temp-copy snapshot of a non-git directory', () => {
      const result = resolveScopeMode({
        scope: '--diff',
        snapshot: { type: 'temp-copy' },
        cwd: tmpDir
      });
      assert.equal(result.scopeMode, 'full');
    });

    it('deduplicates files that are both staged and unstaged on a temp-copy + --diff', () => {
      initGitRepoWithCommittedFile('dup.js', 'const x = 1;');
      fs.writeFileSync(path.join(tmpDir, 'dup.js'), 'const x = 2;');
      execFileSync('git', ['add', 'dup.js'], { cwd: tmpDir });
      fs.writeFileSync(path.join(tmpDir, 'dup.js'), 'const x = 3;');

      const result = resolveScopeMode({
        scope: '--diff',
        snapshot: { type: 'temp-copy' },
        cwd: tmpDir
      });
      const occurrences = result.effectiveScope.split(/\s+/).filter(t => t === 'dup.js').length;
      assert.equal(occurrences, 1);
    });

    it('falls through to targeted with the original value when scope is null', () => {
      const result = resolveScopeMode({
        scope: null,
        snapshot: { type: 'git-worktree', dirtyOverlay: true },
        cwd: tmpDir
      });
      assert.equal(result.scopeMode, 'targeted');
      assert.equal(result.effectiveScope, null);
    });

    it('falls through to targeted when scope is empty string', () => {
      const result = resolveScopeMode({
        scope: '',
        snapshot: { type: 'git-worktree', dirtyOverlay: true },
        cwd: tmpDir
      });
      assert.equal(result.scopeMode, 'targeted');
      assert.equal(result.effectiveScope, '');
    });

    it('falls through to targeted when scope is whitespace only', () => {
      const result = resolveScopeMode({
        scope: '   ',
        snapshot: { type: 'git-worktree', dirtyOverlay: true },
        cwd: tmpDir
      });
      assert.equal(result.scopeMode, 'targeted');
      assert.equal(result.effectiveScope, '   ');
    });
  });

  describe('prompt building validation', () => {
    it('rejects invalid skill IDs via worker error path', () => {
      // Create a config with a stage that has an invalid skillId
      fs.writeFileSync(path.join(tmpDir, '.claude', 'agentwright.json'), JSON.stringify({
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
