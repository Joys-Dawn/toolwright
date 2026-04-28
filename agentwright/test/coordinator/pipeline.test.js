'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  BUILTIN_STAGES,
  DEFAULT_PIPELINES,
  DEFAULT_RETENTION,
  loadUserConfig,
  normalizePipelineGroups,
  flattenGroups,
  resolveStageDefinition,
  resolveNamedPipeline,
  resolveCommandArgs,
  validateScope
} = require('../../coordinator/pipeline');

describe('pipeline', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-test-'));
    fs.mkdirSync(path.join(tmpDir, '.claude'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('BUILTIN_STAGES', () => {
    it('has all expected stages', () => {
      const expected = [
        'correctness', 'security', 'best-practices',
        'implementation', 'migration', 'ui', 'behavior',
        'test-coverage', 'test-quality'
      ];
      for (const name of expected) {
        assert.ok(BUILTIN_STAGES[name], `Missing builtin stage: ${name}`);
        assert.equal(BUILTIN_STAGES[name].type, 'skill');
        assert.ok(BUILTIN_STAGES[name].skillId);
      }
    });

    it('test-quality stage maps to test-quality-audit skill', () => {
      assert.equal(BUILTIN_STAGES['test-quality'].skillId, 'test-quality-audit');
    });
  });

  describe('DEFAULT_PIPELINES', () => {
    it('has default and full pipelines', () => {
      assert.ok(Array.isArray(DEFAULT_PIPELINES.default));
      assert.ok(Array.isArray(DEFAULT_PIPELINES.full));
    });

    it('default pipeline matches expected stages', () => {
      assert.deepEqual(
        DEFAULT_PIPELINES.default,
        ['implementation', 'correctness', 'best-practices', 'behavior', 'test-coverage']
      );
    });

    it('default pipeline does not include test-quality (opt-in only)', () => {
      assert.ok(!DEFAULT_PIPELINES.default.includes('test-quality'));
    });

    it('full pipeline includes parallel groups', () => {
      const hasNestedArray = DEFAULT_PIPELINES.full.some(entry => Array.isArray(entry));
      assert.ok(hasNestedArray);
    });

    it('full pipeline ends with test-coverage then test-quality', () => {
      const flat = DEFAULT_PIPELINES.full.flat();
      const coverageIdx = flat.indexOf('test-coverage');
      const qualityIdx = flat.indexOf('test-quality');
      assert.ok(coverageIdx >= 0, 'full should include test-coverage');
      assert.ok(qualityIdx >= 0, 'full should include test-quality');
      assert.ok(qualityIdx > coverageIdx, 'test-quality must run after test-coverage');
    });
  });

  describe('DEFAULT_RETENTION', () => {
    it('has expected defaults', () => {
      assert.equal(DEFAULT_RETENTION.keepCompletedRuns, 2);
      assert.equal(DEFAULT_RETENTION.deleteCompletedLogs, true);
      assert.equal(DEFAULT_RETENTION.deleteCompletedFindings, false);
      assert.equal(DEFAULT_RETENTION.maxRunAgeDays, 2);
    });
  });

  describe('loadUserConfig', () => {
    it('returns defaults when no config file exists', () => {
      const config = loadUserConfig(tmpDir);
      assert.deepEqual(config.pipelines, {});
      assert.deepEqual(config.customStages, {});
      assert.deepEqual(config.retention, { ...DEFAULT_RETENTION });
    });

    it('loads user config and merges retention', () => {
      fs.writeFileSync(path.join(tmpDir, '.claude', 'agentwright.json'), JSON.stringify({
        pipelines: { quick: ['correctness'] },
        customStages: { custom: { type: 'skill', skillId: 'custom-audit' } },
        retention: { keepCompletedRuns: 5 }
      }), 'utf8');
      const config = loadUserConfig(tmpDir);
      assert.deepEqual(config.pipelines, { quick: ['correctness'] });
      assert.deepEqual(config.customStages, { custom: { type: 'skill', skillId: 'custom-audit' } });
      assert.equal(config.retention.keepCompletedRuns, 5);
      assert.equal(config.retention.deleteCompletedLogs, true);
    });

    it('loads custom stage with skillPath instead of skillId', () => {
      const skillFile = path.join(tmpDir, 'my-audit', 'SKILL.md');
      fs.mkdirSync(path.dirname(skillFile), { recursive: true });
      fs.writeFileSync(skillFile, '# My Audit', 'utf8');
      fs.writeFileSync(path.join(tmpDir, '.claude', 'agentwright.json'), JSON.stringify({
        customStages: { custom: { type: 'skill', skillPath: 'my-audit/SKILL.md' } }
      }), 'utf8');
      const config = loadUserConfig(tmpDir);
      assert.equal(config.customStages.custom.skillPath, 'my-audit/SKILL.md');
    });

    it('rejects custom stage with neither skillId nor skillPath', () => {
      fs.writeFileSync(path.join(tmpDir, '.claude', 'agentwright.json'), JSON.stringify({
        customStages: { bad: { type: 'skill' } }
      }), 'utf8');
      assert.throws(() => loadUserConfig(tmpDir), /skillId.*skillPath|skillPath.*skillId/);
    });

    it('rejects custom stage with both skillId and skillPath', () => {
      fs.writeFileSync(path.join(tmpDir, '.claude', 'agentwright.json'), JSON.stringify({
        customStages: { ambig: { type: 'skill', skillId: 'foo', skillPath: 'bar/SKILL.md' } }
      }), 'utf8');
      assert.throws(() => loadUserConfig(tmpDir), /not multiple/);
    });

    it('accepts custom stage with skillIds array (fused stage)', () => {
      fs.writeFileSync(path.join(tmpDir, '.claude', 'agentwright.json'), JSON.stringify({
        customStages: {
          bundle: { type: 'skill', skillIds: ['correctness-audit', 'security-audit'] }
        }
      }), 'utf8');
      const config = loadUserConfig(tmpDir);
      assert.deepEqual(config.customStages.bundle.skillIds, ['correctness-audit', 'security-audit']);
    });

    it('rejects custom stage with both skillId and skillIds', () => {
      fs.writeFileSync(path.join(tmpDir, '.claude', 'agentwright.json'), JSON.stringify({
        customStages: {
          ambig: { type: 'skill', skillId: 'foo', skillIds: ['bar', 'baz'] }
        }
      }), 'utf8');
      assert.throws(() => loadUserConfig(tmpDir), /not multiple/);
    });

    it('rejects custom stage with both skillIds and skillPath', () => {
      fs.writeFileSync(path.join(tmpDir, '.claude', 'agentwright.json'), JSON.stringify({
        customStages: {
          ambig: { type: 'skill', skillIds: ['bar', 'baz'], skillPath: 'p/SKILL.md' }
        }
      }), 'utf8');
      assert.throws(() => loadUserConfig(tmpDir), /not multiple/);
    });

    it('rejects custom stage with empty skillIds array', () => {
      fs.writeFileSync(path.join(tmpDir, '.claude', 'agentwright.json'), JSON.stringify({
        customStages: { bad: { type: 'skill', skillIds: [] } }
      }), 'utf8');
      assert.throws(() => loadUserConfig(tmpDir), /at least 2/);
    });

    it('rejects custom stage with single-element skillIds (use skillId for one skill)', () => {
      fs.writeFileSync(path.join(tmpDir, '.claude', 'agentwright.json'), JSON.stringify({
        customStages: { bad: { type: 'skill', skillIds: ['correctness-audit'] } }
      }), 'utf8');
      assert.throws(() => loadUserConfig(tmpDir), /at least 2/);
    });

    it('rejects custom stage with non-string skillIds members', () => {
      fs.writeFileSync(path.join(tmpDir, '.claude', 'agentwright.json'), JSON.stringify({
        customStages: { bad: { type: 'skill', skillIds: ['ok', 42] } }
      }), 'utf8');
      assert.throws(() => loadUserConfig(tmpDir), /non-empty strings/);
    });

    it('rejects custom stage with empty-string skillIds member', () => {
      fs.writeFileSync(path.join(tmpDir, '.claude', 'agentwright.json'), JSON.stringify({
        customStages: { bad: { type: 'skill', skillIds: ['ok', ''] } }
      }), 'utf8');
      assert.throws(() => loadUserConfig(tmpDir), /non-empty strings/);
    });

    it('handles config with missing optional fields', () => {
      fs.writeFileSync(path.join(tmpDir, '.claude', 'agentwright.json'), '{}', 'utf8');
      const config = loadUserConfig(tmpDir);
      assert.deepEqual(config.pipelines, {});
      assert.deepEqual(config.customStages, {});
      assert.deepEqual(config.retention, { ...DEFAULT_RETENTION });
    });
  });

  describe('resolveStageDefinition', () => {
    it('resolves builtin stages', () => {
      const def = resolveStageDefinition('correctness', tmpDir);
      assert.equal(def.type, 'skill');
      assert.equal(def.skillId, 'correctness-audit');
    });

    it('returns null for unknown stages', () => {
      assert.equal(resolveStageDefinition('nonexistent', tmpDir), null);
    });

    it('resolves custom stages from config', () => {
      fs.writeFileSync(path.join(tmpDir, '.claude', 'agentwright.json'), JSON.stringify({
        customStages: { custom: { type: 'skill', skillId: 'custom-audit' } }
      }), 'utf8');
      const def = resolveStageDefinition('custom', tmpDir);
      assert.equal(def.skillId, 'custom-audit');
    });

    it('builtin takes precedence over custom with same name', () => {
      fs.writeFileSync(path.join(tmpDir, '.claude', 'agentwright.json'), JSON.stringify({
        customStages: { correctness: { type: 'skill', skillId: 'overridden' } }
      }), 'utf8');
      const def = resolveStageDefinition('correctness', tmpDir);
      assert.equal(def.skillId, 'correctness-audit');
    });

    it('resolves fused custom stage with skillIds intact', () => {
      fs.writeFileSync(path.join(tmpDir, '.claude', 'agentwright.json'), JSON.stringify({
        customStages: {
          bundle: { type: 'skill', skillIds: ['correctness-audit', 'security-audit'] }
        }
      }), 'utf8');
      const def = resolveStageDefinition('bundle', tmpDir);
      assert.equal(def.type, 'skill');
      assert.deepEqual(def.skillIds, ['correctness-audit', 'security-audit']);
      assert.equal(def.skillId, undefined);
    });
  });

  describe('resolveNamedPipeline', () => {
    it('resolves default pipeline', () => {
      assert.deepEqual(resolveNamedPipeline('default', tmpDir), DEFAULT_PIPELINES.default);
    });

    it('resolves full pipeline', () => {
      assert.deepEqual(resolveNamedPipeline('full', tmpDir), DEFAULT_PIPELINES.full);
    });

    it('returns null for unknown pipeline', () => {
      assert.equal(resolveNamedPipeline('nonexistent', tmpDir), null);
    });

    it('resolves user-defined pipeline', () => {
      fs.writeFileSync(path.join(tmpDir, '.claude', 'agentwright.json'), JSON.stringify({
        pipelines: { quick: ['correctness'] }
      }), 'utf8');
      assert.deepEqual(resolveNamedPipeline('quick', tmpDir), ['correctness']);
    });

    it('user pipeline takes precedence over builtin with same name', () => {
      fs.writeFileSync(path.join(tmpDir, '.claude', 'agentwright.json'), JSON.stringify({
        pipelines: { default: ['security'] }
      }), 'utf8');
      assert.deepEqual(resolveNamedPipeline('default', tmpDir), ['security']);
    });
  });

  describe('normalizePipelineGroups', () => {
    it('normalizes flat stage list into single-element groups', () => {
      const groups = normalizePipelineGroups(['correctness', 'security'], tmpDir);
      assert.deepEqual(groups, [['correctness'], ['security']]);
    });

    it('preserves nested groups', () => {
      const groups = normalizePipelineGroups(['correctness', ['migration', 'ui']], tmpDir);
      assert.deepEqual(groups, [['correctness'], ['migration', 'ui']]);
    });

    it('throws on empty pipeline', () => {
      assert.throws(() => normalizePipelineGroups([], tmpDir), /non-empty/);
    });

    it('throws on empty group', () => {
      assert.throws(() => normalizePipelineGroups([[]], tmpDir), /cannot be empty/);
    });

    it('throws on unknown stage', () => {
      assert.throws(() => normalizePipelineGroups(['nonexistent'], tmpDir), /Unknown stage/);
    });

    it('auto-suffixes duplicate stages', () => {
      const result = normalizePipelineGroups(['correctness', 'correctness'], tmpDir);
      assert.deepEqual(result, [['correctness'], ['correctness-2']]);
    });

    it('auto-suffixes duplicate stages across groups', () => {
      const result = normalizePipelineGroups(['correctness', ['correctness', 'security']], tmpDir);
      assert.deepEqual(result, [['correctness'], ['correctness-2', 'security']]);
    });

    it('handles triple duplicates', () => {
      const result = normalizePipelineGroups(['correctness', 'correctness', 'correctness'], tmpDir);
      assert.deepEqual(result, [['correctness'], ['correctness-2'], ['correctness-3']]);
    });

    it('resolves suffixed stage definitions', () => {
      const def = resolveStageDefinition('correctness-2', tmpDir);
      assert.ok(def);
      assert.equal(def.type, 'skill');
    });
  });

  describe('flattenGroups', () => {
    it('flattens nested groups', () => {
      assert.deepEqual(flattenGroups([['a'], ['b', 'c'], ['d']]), ['a', 'b', 'c', 'd']);
    });

    it('handles empty input', () => {
      assert.deepEqual(flattenGroups([]), []);
    });
  });

  describe('resolveCommandArgs', () => {
    it('returns default pipeline with --diff scope when empty', () => {
      const result = resolveCommandArgs('', tmpDir);
      assert.equal(result.pipelineName, 'default');
      assert.equal(result.scope, '--diff');
      assert.deepEqual(
        result.stages,
        ['implementation', 'correctness', 'best-practices', 'behavior', 'test-coverage']
      );
    });

    it('resolves named pipeline', () => {
      const result = resolveCommandArgs('default', tmpDir);
      assert.equal(result.pipelineName, 'default');
      assert.equal(result.scope, '--diff');
    });

    it('resolves named pipeline with scope', () => {
      const result = resolveCommandArgs('default src/', tmpDir);
      assert.equal(result.pipelineName, 'default');
      assert.equal(result.scope, 'src/');
    });

    it('resolves comma-separated stage list', () => {
      const result = resolveCommandArgs('correctness,security', tmpDir);
      assert.equal(result.pipelineName, null);
      assert.deepEqual(result.stages, ['correctness', 'security']);
      assert.equal(result.scope, '--diff');
    });

    it('resolves comma-separated stage list with scope', () => {
      const result = resolveCommandArgs('correctness,security src/lib', tmpDir);
      assert.equal(result.pipelineName, null);
      assert.deepEqual(result.stages, ['correctness', 'security']);
      assert.equal(result.scope, 'src/lib');
    });

    it('resolves single known stage', () => {
      const result = resolveCommandArgs('correctness', tmpDir);
      assert.equal(result.pipelineName, null);
      assert.deepEqual(result.stages, ['correctness']);
    });

    it('resolves single known stage with scope', () => {
      const result = resolveCommandArgs('correctness src/auth.ts', tmpDir);
      assert.equal(result.pipelineName, null);
      assert.deepEqual(result.stages, ['correctness']);
      assert.equal(result.scope, 'src/auth.ts');
    });

    it('treats unrecognized token as scope for default pipeline', () => {
      const result = resolveCommandArgs('src/auth.ts', tmpDir);
      assert.equal(result.pipelineName, 'default');
      assert.equal(result.scope, 'src/auth.ts');
      assert.deepEqual(
        result.stages,
        ['implementation', 'correctness', 'best-practices', 'behavior', 'test-coverage']
      );
    });

    it('treats multi-token unrecognized input as scope', () => {
      const result = resolveCommandArgs('src/auth.ts src/middleware.ts', tmpDir);
      assert.equal(result.pipelineName, 'default');
      assert.equal(result.scope, 'src/auth.ts src/middleware.ts');
    });

    it('does not treat partial comma list as stage list', () => {
      const result = resolveCommandArgs('correctness,nonexistent', tmpDir);
      assert.equal(result.pipelineName, 'default');
      assert.equal(result.scope, 'correctness,nonexistent');
    });

    it('handles trailing comma in stage list', () => {
      const result = resolveCommandArgs('correctness,', tmpDir);
      assert.equal(result.pipelineName, null);
      assert.deepEqual(result.stages, ['correctness']);
      assert.equal(result.scope, '--diff');
    });

    it('handles leading comma in stage list', () => {
      const result = resolveCommandArgs(',correctness', tmpDir);
      assert.equal(result.pipelineName, null);
      assert.deepEqual(result.stages, ['correctness']);
      assert.equal(result.scope, '--diff');
    });

    it('treats bare comma as default pipeline scope', () => {
      const result = resolveCommandArgs(',', tmpDir);
      assert.equal(result.pipelineName, 'default');
      assert.equal(result.scope, ',');
    });

    it('handles multiple commas between stages', () => {
      const result = resolveCommandArgs('correctness,,security', tmpDir);
      assert.equal(result.pipelineName, null);
      assert.deepEqual(result.stages, ['correctness', 'security']);
    });

    it('preserves --all as scope on the default pipeline', () => {
      const result = resolveCommandArgs('--all', tmpDir);
      assert.equal(result.pipelineName, 'default');
      assert.equal(result.scope, '--all');
    });

    it('preserves --all as scope after a named pipeline', () => {
      const result = resolveCommandArgs('default --all', tmpDir);
      assert.equal(result.pipelineName, 'default');
      assert.equal(result.scope, '--all');
    });

    it('preserves --all as scope after a single stage', () => {
      const result = resolveCommandArgs('correctness --all', tmpDir);
      assert.equal(result.pipelineName, null);
      assert.deepEqual(result.stages, ['correctness']);
      assert.equal(result.scope, '--all');
    });

    it('preserves explicit --diff as scope', () => {
      const result = resolveCommandArgs('correctness --diff', tmpDir);
      assert.equal(result.pipelineName, null);
      assert.equal(result.scope, '--diff');
    });

    const invalidScopes = [
      ['scope mixes --all with a path', '--all src/api/'],
      ['--all-foo typo', '--all-foo'],
      ['--diff-staged typo', '--diff-staged'],
      ['stage is followed by --all and a path', 'correctness --all src/'],
      ['scope mixes --all and --diff', '--all --diff']
    ];
    for (const [scenario, input] of invalidScopes) {
      it(`throws when ${scenario}`, () => {
        assert.throws(() => resolveCommandArgs(input, tmpDir), /Invalid scope/);
      });
    }
  });

  describe('validateScope', () => {
    const accepted = [
      ['--all alone', '--all'],
      ['--diff alone', '--diff'],
      ['a single path', 'src/api/'],
      ['multiple paths', 'src/api/ src/lib/'],
      ['an empty scope', '']
    ];
    for (const [scenario, input] of accepted) {
      it(`accepts ${scenario}`, () => {
        validateScope(input);
      });
    }

    const rejected = [
      ['--all with a path', '--all src/api/'],
      ['path with --all in trailing position', 'src/api/ --all'],
      ['--all-foo (hyphen-suffix typo)', '--all-foo'],
      ['an unrecognized --flag token', '--bogus'],
      ['multiple keywords together', '--all --diff']
    ];
    for (const [scenario, input] of rejected) {
      it(`rejects ${scenario}`, () => {
        assert.throws(() => validateScope(input), /Invalid scope/);
      });
    }
  });
});
