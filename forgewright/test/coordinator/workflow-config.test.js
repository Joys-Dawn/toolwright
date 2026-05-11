'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  loadUserConfig,
  resolveWorkflowDefinition,
  resolveReaudit,
  resolveTests,
  validateWorkflowDefinition,
  loadBuiltinWorkflows,
  listAvailableWorkflows,
  DEFAULT_RETENTION,
  DEFAULT_REAUDIT,
} = require('../../coordinator/workflow-config');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fw-config-'));
}

function writeConfig(cwd, content) {
  const dir = path.join(cwd, '.claude');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'forgewright.json'), JSON.stringify(content, null, 2), 'utf8');
}

describe('workflow-config', () => {
  describe('loadUserConfig', () => {
    test('returns defaults when no config exists', () => {
      const cwd = tmpDir();
      try {
        const cfg = loadUserConfig(cwd);
        assert.deepEqual(cfg.workflows, {});
        assert.deepEqual(cfg.retention, DEFAULT_RETENTION);
        assert.deepEqual(cfg.reaudit, DEFAULT_REAUDIT);
        assert.deepEqual(cfg.tests, { command: null });
        assert.deepEqual(cfg.agentwright, { path: null });
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    });

    test('merges user retention with defaults', () => {
      const cwd = tmpDir();
      try {
        writeConfig(cwd, { retention: { keepCompletedWorkflows: 5 } });
        const cfg = loadUserConfig(cwd);
        assert.equal(cfg.retention.keepCompletedWorkflows, 5);
        assert.equal(cfg.retention.maxWorkflowAgeDays, DEFAULT_RETENTION.maxWorkflowAgeDays);
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    });

    test('rejects "workflows" that is not an object', () => {
      const cwd = tmpDir();
      try {
        writeConfig(cwd, { workflows: 'bad' });
        assert.throws(() => loadUserConfig(cwd), /"workflows" must be an object/);
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    });

    test('rejects bad reaudit field types in top-level config block', () => {
      const cwd = tmpDir();
      try {
        writeConfig(cwd, { reaudit: { maxCycles: 'five' } });
        assert.throws(() => loadUserConfig(cwd), /"reaudit\.maxCycles" must be a finite number/);
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    });

    test('rejects invalid phase types in user-defined workflows', () => {
      const cwd = tmpDir();
      try {
        writeConfig(cwd, {
          workflows: {
            mine: { phases: [{ name: 'p', type: 'unknown' }] },
          },
        });
        assert.throws(() => loadUserConfig(cwd), /unknown type: unknown/);
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    });
  });

  describe('validateWorkflowDefinition', () => {
    test('accepts a feature-shaped workflow', () => {
      const def = {
        phases: [
          { name: 'plan', type: 'skill', skillId: 'agentwright:feature-planning' },
          { name: 'plan-review', type: 'checkpoint', summary: '...' },
          { name: 'audit', type: 'pipeline', pipelineName: 'default' },
          { name: 'tests', type: 'command', command: 'npm test' },
        ],
      };
      assert.doesNotThrow(() => validateWorkflowDefinition('feature', def));
    });

    test('rejects skill phase without skillId', () => {
      assert.throws(() => validateWorkflowDefinition('bad', {
        phases: [{ name: 'p', type: 'skill' }],
      }), /requires a "skillId"/);
    });

    test('rejects pipeline phase without pipelineName', () => {
      assert.throws(() => validateWorkflowDefinition('bad', {
        phases: [{ name: 'p', type: 'pipeline' }],
      }), /requires a "pipelineName"/);
    });

    test('rejects command phase without command', () => {
      assert.throws(() => validateWorkflowDefinition('bad', {
        phases: [{ name: 'p', type: 'command' }],
      }), /requires a "command"/);
    });

    test('accepts command phase with consumes as a non-empty string', () => {
      assert.doesNotThrow(() => validateWorkflowDefinition('w', {
        phases: [{ name: 'p', type: 'command', command: 'echo done', consumes: 'plan' }],
      }));
    });

    test('accepts command phase with consumes as an array of strings', () => {
      assert.doesNotThrow(() => validateWorkflowDefinition('w', {
        phases: [{ name: 'p', type: 'command', command: 'echo done', consumes: ['plan', 'model'] }],
      }));
    });

    test('rejects command phase whose consumes is an empty string', () => {
      assert.throws(() => validateWorkflowDefinition('w', {
        phases: [{ name: 'p', type: 'command', command: 'echo done', consumes: '' }],
      }), /"consumes" must be a non-empty string or an array of non-empty strings/);
    });

    test('rejects command phase whose consumes contains non-string entries', () => {
      assert.throws(() => validateWorkflowDefinition('w', {
        phases: [{ name: 'p', type: 'command', command: 'echo done', consumes: ['plan', 42] }],
      }), /"consumes" must be a non-empty string or an array of non-empty strings/);
    });

    test('rejects command phase whose consumes is an object map', () => {
      assert.throws(() => validateWorkflowDefinition('w', {
        phases: [{ name: 'p', type: 'command', command: 'echo done', consumes: { plan: 'plan.md' } }],
      }), /"consumes" must be a non-empty string or an array of non-empty strings/);
    });

    test('rejects skill phase whose produces is a number', () => {
      assert.throws(() => validateWorkflowDefinition('w', {
        phases: [{ name: 'p', type: 'skill', skillId: 'agentwright:feature-planning', produces: 42 }],
      }), /malformed "produces"/);
    });

    test('rejects skill phase whose produces is an empty string', () => {
      assert.throws(() => validateWorkflowDefinition('w', {
        phases: [{ name: 'p', type: 'skill', skillId: 'agentwright:feature-planning', produces: '' }],
      }), /malformed "produces"/);
    });

    test('rejects command phase whose produces is an empty object', () => {
      assert.throws(() => validateWorkflowDefinition('w', {
        phases: [{ name: 'p', type: 'command', command: 'echo', produces: {} }],
      }), /malformed "produces"/);
    });

    test('rejects command phase whose produces is an object with all-invalid entries', () => {
      assert.throws(() => validateWorkflowDefinition('w', {
        phases: [{ name: 'p', type: 'command', command: 'echo', produces: { x: '', y: 0 } }],
      }), /malformed "produces"/);
    });

    test('rejects command phase whose produces is an array', () => {
      assert.throws(() => validateWorkflowDefinition('w', {
        phases: [{ name: 'p', type: 'command', command: 'echo', produces: ['plan.md', 'tasks.json'] }],
      }), /malformed "produces"/);
    });

    test('accepts a bare-name produces string', () => {
      assert.doesNotThrow(() => validateWorkflowDefinition('w', {
        phases: [{ name: 'p', type: 'skill', skillId: 'agentwright:feature-planning', produces: 'plan' }],
      }));
    });

    test('accepts an extension-form produces string', () => {
      assert.doesNotThrow(() => validateWorkflowDefinition('w', {
        phases: [{ name: 'p', type: 'skill', skillId: 'agentwright:feature-planning', produces: 'plan.md' }],
      }));
    });

    test('accepts a multi-output produces map', () => {
      assert.doesNotThrow(() => validateWorkflowDefinition('w', {
        phases: [{ name: 'p', type: 'command', command: 'echo', produces: { metrics: 'metrics.json', model: 'model.bin' } }],
      }));
    });

    test('rejects phase missing the name field', () => {
      assert.throws(() => validateWorkflowDefinition('bad', {
        phases: [{ type: 'skill', skillId: 'x' }],
      }), /requires a "name" string/);
    });

    test('rejects phase whose name is empty / wrong type / wrong shape', async (t) => {
      // Sub-tests give every invalid input its own named case so a failure
      // reports e.g. `name=null` rather than "something in this loop failed".
      const cases = ['', 'has space', '1starts-with-digit', '-leading-dash', null, 42];
      for (const bad of cases) {
        await t.test(`name=${JSON.stringify(bad)}`, () => {
          assert.throws(() => validateWorkflowDefinition('bad', {
            phases: [{ name: bad, type: 'skill', skillId: 'x' }],
          }), /requires a "name"/);
        });
      }
    });

    test('rejects duplicate phase names within a workflow', () => {
      assert.throws(() => validateWorkflowDefinition('bad', {
        phases: [
          { name: 'plan', type: 'skill', skillId: 'agentwright:feature-planning' },
          { name: 'plan', type: 'pipeline', pipelineName: 'default' },
        ],
      }), /duplicate phase name "plan"/);
    });

    test('accepts handoff phase with a directive', () => {
      assert.doesNotThrow(() => validateWorkflowDefinition('w', {
        phases: [{ name: 'p', type: 'handoff', directive: 'implement plan' }],
      }));
    });

    test('accepts handoff phase with consumes only (no directive)', () => {
      assert.doesNotThrow(() => validateWorkflowDefinition('w', {
        phases: [{ name: 'p', type: 'handoff', consumes: 'tasks' }],
      }));
    });

    test('rejects handoff phase without directive AND without consumes', () => {
      assert.throws(() => validateWorkflowDefinition('w', {
        phases: [{ name: 'p', type: 'handoff' }],
      }), /requires "directive" or "consumes"/);
    });

    test('rejects fanout phase type (removed)', () => {
      assert.throws(() => validateWorkflowDefinition('w', {
        phases: [{ name: 'p', type: 'fanout', consumes: 'tasks' }],
      }), /unknown type: fanout/);
    });

    test('rejects empty phases array', () => {
      assert.throws(() => validateWorkflowDefinition('empty', { phases: [] }), /non-empty "phases"/);
    });

    test('rejects phase missing the type field entirely', () => {
      assert.throws(() => validateWorkflowDefinition('bad', {
        phases: [{ name: 'p', skillId: 'x' }],
      }), /unknown type: undefined/);
    });

    test('rejects phase that is not an object', () => {
      assert.throws(() => validateWorkflowDefinition('bad', {
        phases: [42],
      }), /must be an object/);
    });

    test('accepts a workflow with a per-workflow reaudit override', () => {
      assert.doesNotThrow(() => validateWorkflowDefinition('w', {
        reaudit: { decisionMode: 'leader', maxCycles: 3 },
        phases: [{ name: 'p', type: 'pipeline', pipelineName: 'default' }],
      }));
    });

    test('rejects a workflow whose reaudit is not an object', () => {
      assert.throws(() => validateWorkflowDefinition('w', {
        reaudit: 'leader',
        phases: [{ name: 'p', type: 'pipeline', pipelineName: 'default' }],
      }), /"reaudit" must be an object/);
    });

    test('rejects a workflow whose reaudit is an array', () => {
      assert.throws(() => validateWorkflowDefinition('w', {
        reaudit: ['leader'],
        phases: [{ name: 'p', type: 'pipeline', pipelineName: 'default' }],
      }), /"reaudit" must be an object/);
    });

    test('rejects reaudit.maxCycles when not a finite number', async (t) => {
      // JSON.stringify collapses NaN / Infinity to "null", so use a custom
      // labeller that distinguishes them — otherwise three sub-tests would
      // all be named "maxCycles=null" and a failure couldn't be localized.
      const label = v => {
        if (v === null) return 'null';
        if (typeof v === 'number') {
          if (Number.isNaN(v)) return 'NaN';
          if (!Number.isFinite(v)) return v > 0 ? 'Infinity' : '-Infinity';
        }
        return JSON.stringify(v);
      };
      const cases = ['five', null, NaN, Infinity, []];
      for (const bad of cases) {
        await t.test(`maxCycles=${label(bad)}`, () => {
          assert.throws(() => validateWorkflowDefinition('w', {
            reaudit: { maxCycles: bad },
            phases: [{ name: 'p', type: 'pipeline', pipelineName: 'default' }],
          }), /"reaudit\.maxCycles" must be a finite number/);
        });
      }
    });

    test('rejects reaudit.minDeltaPercent / minDeltaLines when not numeric', () => {
      assert.throws(() => validateWorkflowDefinition('w', {
        reaudit: { minDeltaPercent: '5%' },
        phases: [{ name: 'p', type: 'pipeline', pipelineName: 'default' }],
      }), /"reaudit\.minDeltaPercent" must be a finite number/);
      assert.throws(() => validateWorkflowDefinition('w', {
        reaudit: { minDeltaLines: '100' },
        phases: [{ name: 'p', type: 'pipeline', pipelineName: 'default' }],
      }), /"reaudit\.minDeltaLines" must be a finite number/);
    });

    test('rejects reaudit.decisionMode that is not deterministic or leader', () => {
      assert.throws(() => validateWorkflowDefinition('w', {
        reaudit: { decisionMode: 'magic' },
        phases: [{ name: 'p', type: 'pipeline', pipelineName: 'default' }],
      }), /"reaudit\.decisionMode" must be "deterministic" or "leader"/);
    });

    test('rejects reaudit.loopableStages that is not an array of non-empty strings', () => {
      assert.throws(() => validateWorkflowDefinition('w', {
        reaudit: { loopableStages: 'correctness' },
        phases: [{ name: 'p', type: 'pipeline', pipelineName: 'default' }],
      }), /"reaudit\.loopableStages" must be an array of non-empty strings/);
      assert.throws(() => validateWorkflowDefinition('w', {
        reaudit: { loopableStages: ['correctness', ''] },
        phases: [{ name: 'p', type: 'pipeline', pipelineName: 'default' }],
      }), /"reaudit\.loopableStages" must be an array of non-empty strings/);
    });

    test('accepts a workflow with a per-workflow tests override', () => {
      assert.doesNotThrow(() => validateWorkflowDefinition('w', {
        tests: { command: 'npm run test:smoke' },
        phases: [{ name: 'p', type: 'command', command: '${TEST_CMD}' }],
      }));
    });

    test('rejects a workflow whose tests is not an object', () => {
      assert.throws(() => validateWorkflowDefinition('w', {
        tests: 'npm test',
        phases: [{ name: 'p', type: 'command', command: '${TEST_CMD}' }],
      }), /"tests" must be an object/);
    });
  });

  describe('resolveReaudit', () => {
    test('returns top-level config when the definition has no override', () => {
      const merged = resolveReaudit({ phases: [] }, { reaudit: { maxCycles: 4, decisionMode: 'deterministic' } });
      assert.equal(merged.maxCycles, 4);
      assert.equal(merged.decisionMode, 'deterministic');
    });

    test('falls back to DEFAULT_REAUDIT when neither config nor override is set', () => {
      const merged = resolveReaudit({ phases: [] }, {});
      assert.deepEqual(merged, DEFAULT_REAUDIT);
    });

    test('per-workflow override wins on every key (shallow merge)', () => {
      const merged = resolveReaudit(
        { reaudit: { maxCycles: 5, minDeltaPercent: 1, minDeltaLines: 100, decisionMode: 'leader', loopableStages: ['security'] }, phases: [] },
        { reaudit: { maxCycles: 1, minDeltaPercent: 5, minDeltaLines: 0, decisionMode: 'deterministic', loopableStages: ['correctness', 'behavior'] } },
      );
      assert.equal(merged.maxCycles, 5);
      assert.equal(merged.minDeltaPercent, 1);
      assert.equal(merged.minDeltaLines, 100);
      assert.equal(merged.decisionMode, 'leader');
      assert.deepEqual(merged.loopableStages, ['security']);
    });

    test('partial override: only overridden keys win, the rest fall through', () => {
      const merged = resolveReaudit(
        { reaudit: { decisionMode: 'leader' }, phases: [] },
        { reaudit: { maxCycles: 1, minDeltaPercent: 5, decisionMode: 'deterministic', loopableStages: ['correctness'] } },
      );
      assert.equal(merged.decisionMode, 'leader');
      assert.equal(merged.maxCycles, 1);
      assert.equal(merged.minDeltaPercent, 5);
      assert.deepEqual(merged.loopableStages, ['correctness']);
    });

    test('ignores a malformed override (string) and uses the global', () => {
      const merged = resolveReaudit(
        { reaudit: 'leader', phases: [] },
        { reaudit: { maxCycles: 2, decisionMode: 'deterministic' } },
      );
      assert.equal(merged.maxCycles, 2);
      assert.equal(merged.decisionMode, 'deterministic');
    });

    test('ignores a malformed override (array) and uses the global', () => {
      const merged = resolveReaudit(
        { reaudit: ['x'], phases: [] },
        { reaudit: { maxCycles: 2 } },
      );
      assert.equal(merged.maxCycles, 2);
    });
  });

  describe('resolveTests', () => {
    test('returns top-level tests when the definition has no override', () => {
      const merged = resolveTests({ phases: [] }, { tests: { command: 'npm test' } });
      assert.equal(merged.command, 'npm test');
    });

    test('falls back to { command: null } when neither config nor override is set', () => {
      const merged = resolveTests({ phases: [] }, {});
      assert.deepEqual(merged, { command: null });
    });

    test('per-workflow override wins on the command key', () => {
      const merged = resolveTests(
        { tests: { command: 'npm run test:smoke' }, phases: [] },
        { tests: { command: 'npm test' } },
      );
      assert.equal(merged.command, 'npm run test:smoke');
    });

    test('partial override: extra workflow keys merge with global (forward-compat)', () => {
      // The merge is shallow over the entire `tests` block — when the global
      // grows new keys (timeout, env, ...) and a workflow only overrides
      // `command`, the new global keys must still be present.
      const merged = resolveTests(
        { tests: { command: 'npm run test:smoke' }, phases: [] },
        { tests: { command: 'npm test', timeout: 600 } },
      );
      assert.equal(merged.command, 'npm run test:smoke');
      assert.equal(merged.timeout, 600);
    });

    test('ignores a malformed override (string) and uses the global', () => {
      const merged = resolveTests(
        { tests: 'npm test', phases: [] },
        { tests: { command: 'npm run test:integration' } },
      );
      assert.equal(merged.command, 'npm run test:integration');
    });
  });

  describe('loadBuiltinWorkflows + resolveWorkflowDefinition', () => {
    test('feature workflow ships built-in', () => {
      const builtins = loadBuiltinWorkflows();
      assert.ok(builtins.feature, 'expected built-in "feature" workflow');
      assert.ok(Array.isArray(builtins.feature.phases));
      assert.ok(builtins.feature.phases.length >= 3);
    });

    test('resolveWorkflowDefinition prefers user-defined over built-in', () => {
      const cwd = tmpDir();
      try {
        writeConfig(cwd, {
          workflows: {
            feature: { phases: [{ name: 'plan', type: 'skill', skillId: 'agentwright:feature-planning' }] },
          },
        });
        const def = resolveWorkflowDefinition('feature', cwd);
        assert.equal(def.phases.length, 1);
        assert.equal(def.phases[0].skillId, 'agentwright:feature-planning');
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    });

    test('returns null for unknown workflow', () => {
      const cwd = tmpDir();
      try {
        assert.equal(resolveWorkflowDefinition('does-not-exist', cwd), null);
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    });

    test('built-in feature / bug-fix / refactor / idea-exploration / greenfield workflows validate cleanly', () => {
      const cwd = tmpDir();
      try {
        for (const name of ['feature', 'bug-fix', 'refactor', 'idea-exploration', 'greenfield']) {
          const def = resolveWorkflowDefinition(name, cwd);
          assert.ok(def, `expected built-in "${name}" workflow`);
          assert.ok(Array.isArray(def.phases) && def.phases.length > 0);
        }
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    });
  });

  describe('listAvailableWorkflows', () => {
    test('combines built-in and user-defined names, sorted', () => {
      const cwd = tmpDir();
      try {
        writeConfig(cwd, {
          workflows: { custom: { phases: [{ name: 'plan', type: 'skill', skillId: 'agentwright:feature-planning' }] } },
        });
        const list = listAvailableWorkflows(cwd);
        assert.ok(list.includes('feature'));
        assert.ok(list.includes('custom'));
        const sorted = [...list].sort();
        assert.deepEqual(list, sorted);
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    });
  });
});
