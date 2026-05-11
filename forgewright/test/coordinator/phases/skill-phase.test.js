'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const skillPhase = require('../../../coordinator/phases/skill-phase');

const SAMPLE_WORKFLOW = { workflowId: 'wf-1' };

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
});
