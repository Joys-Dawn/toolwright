'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const checkpointPhase = require('../../../coordinator/phases/checkpoint-phase');

const SAMPLE_WORKFLOW = { workflowId: 'wf-1', workflowName: 'feature' };

describe('checkpoint-phase', () => {
  test('TYPE constant exposed', () => {
    assert.equal(checkpointPhase.TYPE, 'checkpoint');
  });

  describe('buildDescriptor', () => {
    test('returns kind:checkpoint with summary and resume command', () => {
      const phase = { index: 2, type: 'checkpoint', name: 'plan-review', summary: 'Review the plan.' };
      const d = checkpointPhase.buildDescriptor(phase, SAMPLE_WORKFLOW);
      assert.equal(d.kind, 'checkpoint');
      assert.equal(d.name, 'plan-review');
      assert.equal(d.summary, 'Review the plan.');
      assert.equal(d.workflowId, 'wf-1');
      assert.equal(d.phaseIndex, 2);
      assert.equal(d.resumeCommand, '/forgewright:workflow-resume wf-1');
      assert.equal(d.stopCommand, '/forgewright:workflow-stop wf-1');
      assert.equal(d.discordAudience, 'user');
    });

    test('throws when name is missing', () => {
      assert.throws(() => checkpointPhase.buildDescriptor({ index: 0, type: 'checkpoint' }, SAMPLE_WORKFLOW),
        /requires a "name"/);
    });
  });

  describe('validateResult', () => {
    test('always returns true (no-op)', () => {
      assert.equal(checkpointPhase.validateResult(), true);
    });
  });
});
