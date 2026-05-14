'use strict';

const path = require('node:path');
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const skillPhase = require('../../../coordinator/phases/skill-phase');
const { artifactsDir } = require('../../../coordinator/paths');

const SAMPLE_WORKFLOW = { workflowId: 'wf-1' };
const TEST_CWD = process.platform === 'win32' ? 'C:\\test-cwd' : '/test-cwd';

describe('skill-phase', () => {
  test('TYPE constant exposed', () => {
    assert.equal(skillPhase.TYPE, 'skill');
  });

  describe('buildDescriptor', () => {
    test('returns kind:phase descriptor with skillId, produces, and phaseName', () => {
      const phase = { name: 'plan', index: 0, type: 'skill', skillId: 'agentwright:feature-planning', produces: 'plan' };
      const d = skillPhase.buildDescriptor(phase, SAMPLE_WORKFLOW);
      assert.equal(d.kind, 'phase');
      assert.equal(d.type, 'skill');
      assert.equal(d.skillId, 'agentwright:feature-planning');
      assert.equal(d.produces, 'plan');
      assert.equal(d.workflowId, 'wf-1');
      assert.equal(d.phaseIndex, 0);
      assert.equal(d.phaseName, 'plan');
    });

    test('uses custom instruction verbatim when phase.instruction is set', () => {
      // Real branch: the function returns the custom instruction unchanged
      // instead of rendering its built-in template. This is a behavioral
      // pass-through assertion, not a prompt-content grep.
      const phase = { name: 'p', index: 0, type: 'skill', skillId: 'x', instruction: 'CUSTOM' };
      const d = skillPhase.buildDescriptor(phase, SAMPLE_WORKFLOW);
      assert.equal(d.instruction, 'CUSTOM');
    });

    test('throws when skillId missing', () => {
      assert.throws(() => skillPhase.buildDescriptor({ name: 'p', index: 0, type: 'skill' }, SAMPLE_WORKFLOW),
        /requires a "skillId"/);
    });

    test('forwards array-form consumes through the descriptor', () => {
      // Multi-consume: a skill phase can declare `consumes: ["research", "peer-opinions"]`
      // and the descriptor must preserve the raw array. Downstream callers
      // (workflow-lifecycle's consumeStemsOf, handoff dispatch) read the
      // array directly — the rendered instruction is LLM-facing docs that
      // we don't pin via regex, per the prompt-content-not-behavior rule.
      const phase = {
        name: 'plan',
        index: 1,
        type: 'skill',
        skillId: 'agentwright:project-planning',
        consumes: ['research', 'peer-opinions'],
      };
      const d = skillPhase.buildDescriptor(phase, SAMPLE_WORKFLOW);
      assert.deepEqual(d.consumes, ['research', 'peer-opinions']);
      assert.equal(typeof d.instruction, 'string');
      assert.ok(d.instruction.length > 0);
    });

    test('forwards produces and consumes through the descriptor (consumed by downstream phases)', () => {
      // The descriptor fields ARE the contract — workflow-lifecycle, handoff
      // dispatch, and validateResult all read `produces`/`consumes` directly,
      // not the rendered instruction. The instruction is LLM-facing
      // documentation and its wording is not part of the contract.
      const phase = {
        name: 'verify',
        index: 0,
        type: 'skill',
        skillId: 'agentwright:verify-plan',
        produces: 'report.md',
        consumes: 'plan.md',
      };
      const d = skillPhase.buildDescriptor(phase, SAMPLE_WORKFLOW);
      assert.equal(d.produces, 'report.md');
      assert.equal(d.consumes, 'plan.md');
      assert.equal(typeof d.instruction, 'string');
      assert.ok(d.instruction.length > 0);
    });
  });

  describe('validateResult', () => {
    test('passes with empty result when no produces', () => {
      const phase = { name: 'verify', index: 0, type: 'skill', skillId: 'agentwright:verify-plan' };
      assert.doesNotThrow(() => skillPhase.validateResult({}, phase));
    });

    test('bare-form produces still requires --artifact-path (skill picks extension)', () => {
      // Bare form "plan" means the skill decides "plan.md" vs "plan.json" at
      // write time, so the leader-supplied path is the only authoritative
      // record of where the file landed.
      const phase = { name: 'plan', index: 0, type: 'skill', skillId: 'agentwright:feature-planning', produces: 'plan' };
      assert.throws(() => skillPhase.validateResult({}, phase), /--artifact-path is required/);
    });

    test('bare-form produces with artifactPath passes', () => {
      const phase = { name: 'plan', index: 0, type: 'skill', skillId: 'agentwright:feature-planning', produces: 'plan' };
      assert.doesNotThrow(() => skillPhase.validateResult({ artifactPath: 'artifacts/plan.md' }, phase));
    });

    test('extension-form produces does NOT require --artifact-path', () => {
      // Extension form "plan.md" means forgewright already knows the canonical
      // filename — auto-registration in workflow-lifecycle.js:171-178 stamps
      // phase.artifactPath and w.artifacts[stem] from the produces config
      // alone. Mirrors command-phase semantics (which never enforces
      // artifactPath); see audit finding implementation-1.
      const phase = { name: 'plan', index: 0, type: 'skill', skillId: 'agentwright:feature-planning', produces: 'plan.md' };
      assert.doesNotThrow(() => skillPhase.validateResult({}, phase));
    });

    test('extension-form produces with artifactPath also passes (leader override)', () => {
      // Leader-supplied path takes precedence in workflow-lifecycle.js:181-184;
      // validateResult should not block this case.
      const phase = { name: 'plan', index: 0, type: 'skill', skillId: 'agentwright:feature-planning', produces: 'plan.md' };
      assert.doesNotThrow(() => skillPhase.validateResult({ artifactPath: 'artifacts/custom.md' }, phase));
    });

    test('rejects non-object result', () => {
      const phase = { name: 'verify', index: 0, type: 'skill', skillId: 'agentwright:verify-plan' };
      assert.throws(() => skillPhase.validateResult(null, phase), /must be an object/);
    });
  });

  describe('planning-mode regression guard', () => {
    // These checks pin literal tool names (EnterPlanMode / ExitPlanMode) because
    // those tokens ARE the behavioral contract — the agent needs to see the
    // exact tool name to call it. Workflow 2026-05-13T18-19-49-186Z-feature-2b9d915f
    // failed precisely because the descriptor didn't name EnterPlanMode and the
    // agent treated the SKILL.md cue as advisory.
    test('feature-planning instruction names EnterPlanMode, ExitPlanMode, and artifacts/plan.md', () => {
      const phase = { name: 'plan', index: 0, type: 'skill', skillId: 'agentwright:feature-planning', produces: 'plan.md' };
      const instr = skillPhase.defaultInstruction(phase);
      assert.ok(instr.includes('EnterPlanMode'), 'planning instruction must name EnterPlanMode');
      assert.ok(instr.includes('ExitPlanMode'), 'planning instruction must name ExitPlanMode');
      assert.ok(instr.includes('artifacts/plan.md'), 'planning instruction must reference artifacts/plan.md');
    });

    test('bug-fix-planning instruction names EnterPlanMode', () => {
      const phase = { name: 'plan', index: 0, type: 'skill', skillId: 'agentwright:bug-fix-planning', produces: 'plan.md' };
      const instr = skillPhase.defaultInstruction(phase);
      assert.ok(instr.includes('EnterPlanMode'));
    });

    test('refactor-planning instruction names EnterPlanMode', () => {
      const phase = { name: 'plan', index: 0, type: 'skill', skillId: 'agentwright:refactor-planning', produces: 'plan.md' };
      const instr = skillPhase.defaultInstruction(phase);
      assert.ok(instr.includes('EnterPlanMode'));
    });

    test('non-planning skill (research) does not mention EnterPlanMode', () => {
      // Plan-mode directive must be scoped to planning skills. Non-planning
      // skills write their output directly; emitting EnterPlanMode here would
      // be a regression.
      const phase = { name: 'research', index: 0, type: 'skill', skillId: 'agentwright:research', produces: 'research.md' };
      const instr = skillPhase.defaultInstruction(phase);
      assert.ok(!instr.includes('EnterPlanMode'), 'non-planning instruction must not mention EnterPlanMode');
      assert.ok(instr.includes('artifacts/research.md'), 'non-planning produces line must still reference the produced filename');
    });
  });

  describe('verify-plan --plan-path injection', () => {
    test('verify-plan with consumes:"plan" embeds the absolute artifacts/plan.md path', () => {
      // Production code computes the absolute path via artifactsDir(cwd, workflowId).
      // The instruction must embed that exact absolute path so the agent can pass
      // it through to extract-plan-context.js as Tier-1 input — bypassing the
      // session-wide JSONL heuristic that latched onto the wrong workflow's plan
      // in the original failure.
      const phase = { name: 'verify', index: 0, type: 'skill', skillId: 'agentwright:verify-plan', consumes: 'plan' };
      const instr = skillPhase.defaultInstruction(phase, { cwd: TEST_CWD, workflowId: 'wf-1' });
      const expectedPath = path.join(artifactsDir(TEST_CWD, 'wf-1'), 'plan.md');
      assert.ok(path.isAbsolute(expectedPath), 'test setup must yield an absolute expected path');
      assert.ok(instr.includes('--plan-path'), 'instruction must reference --plan-path');
      assert.ok(instr.includes(expectedPath), `instruction must embed the absolute path: ${expectedPath}`);
    });

    test('buildDescriptor threads cwd from opts into the verify-plan --plan-path argument', () => {
      // The third opts arg is the only path by which cwd reaches defaultInstruction;
      // a refactor that drops it (the bug we're guarding against) would silently
      // disable --plan-path injection.
      const phase = { name: 'verify', index: 0, type: 'skill', skillId: 'agentwright:verify-plan', consumes: 'plan' };
      const d = skillPhase.buildDescriptor(phase, { workflowId: 'wf-99' }, { cwd: TEST_CWD });
      const expectedPath = path.join(artifactsDir(TEST_CWD, 'wf-99'), 'plan.md');
      assert.ok(d.instruction.includes(expectedPath), `descriptor instruction must embed the absolute path for wf-99: ${expectedPath}`);
    });

    test('verify-plan without cwd does not inject --plan-path (legacy / backward-compat)', () => {
      // If a caller doesn't pass cwd, the agent falls back to the pre-fix JSONL
      // heuristic — strictly no worse than legacy. Asserting absence here
      // guards against a refactor that injects a relative/empty path.
      const phase = { name: 'verify', index: 0, type: 'skill', skillId: 'agentwright:verify-plan', consumes: 'plan' };
      const instr = skillPhase.defaultInstruction(phase);
      assert.ok(!instr.includes('--plan-path'));
    });

    test('verify-plan with consumes as array including "plan" still injects --plan-path', () => {
      // Array-form consumes is a supported shape; the plan-path injection must
      // detect "plan" in array entries as well as in the single-string form.
      const phase = { name: 'verify', index: 0, type: 'skill', skillId: 'agentwright:verify-plan', consumes: ['plan', 'research'] };
      const instr = skillPhase.defaultInstruction(phase, { cwd: TEST_CWD, workflowId: 'wf-1' });
      const expectedPath = path.join(artifactsDir(TEST_CWD, 'wf-1'), 'plan.md');
      assert.ok(instr.includes(expectedPath));
    });
  });
});
