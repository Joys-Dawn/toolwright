'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const pipelinePhase = require('../../../coordinator/phases/pipeline-phase');
const { writeStubAgentwright: writeStub } = require('../../_helpers/agentwright-stub');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fw-pipe-'));
}

function writeStubAgentwright(root, version) {
  return writeStub(root, { version, runId: 'pipe-stub-run' });
}

function setupAgentwrightConfig(cwd, cli) {
  fs.mkdirSync(path.join(cwd, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.claude', 'forgewright.json'),
    JSON.stringify({ agentwright: { path: cli } }), 'utf8');
}

const SAMPLE_WORKFLOW = { workflowId: 'wf-1' };

describe('pipeline-phase', () => {
  test('TYPE constant exposed', () => {
    assert.equal(pipelinePhase.TYPE, 'pipeline');
  });

  describe('buildDescriptor', () => {
    test('returns a descriptor without spawning agentwright', async () => {
      const cwd = tmpDir();
      const stubRoot = tmpDir();
      try {
        const cli = writeStubAgentwright(stubRoot, '2.1.5');
        setupAgentwrightConfig(cwd, cli);
        const phase = { name: 'audit', index: 4, type: 'pipeline', pipelineName: 'default', scope: '--diff' };
        const d = await pipelinePhase.buildDescriptor(phase, SAMPLE_WORKFLOW, { cwd });
        assert.equal(d.kind, 'phase');
        assert.equal(d.type, 'pipeline');
        assert.equal(d.pipelineName, 'default');
        assert.equal(d.scope, '--diff');
        assert.equal(d.workflowId, 'wf-1');
        assert.equal(d.phaseIndex, 4);
        assert.equal(d.phaseName, 'audit');
        // The instruction body is LLM-facing documentation — its wording is not
        // the behavioral contract. We only verify it gets built (non-empty
        // string). The structured fields above ARE the contract.
        assert.equal(typeof d.instruction, 'string');
        assert.ok(d.instruction.length > 0);
        // No runId / cli in the descriptor — the LLM drives /agentwright:audit-run.
        assert.equal(d.agentwrightRunId, undefined);
        assert.equal(d.agentwrightCli, undefined);
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
        fs.rmSync(stubRoot, { recursive: true, force: true });
      }
    });

    test('default scope is --diff when not provided', async () => {
      const cwd = tmpDir();
      const stubRoot = tmpDir();
      try {
        const cli = writeStubAgentwright(stubRoot, '2.1.5');
        setupAgentwrightConfig(cwd, cli);
        const d = await pipelinePhase.buildDescriptor(
          { name: 'audit', index: 0, type: 'pipeline', pipelineName: 'default' },
          SAMPLE_WORKFLOW,
          { cwd },
        );
        assert.equal(d.scope, '--diff');
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
        fs.rmSync(stubRoot, { recursive: true, force: true });
      }
    });

    test('throws when pipelineName missing', async () => {
      const cwd = tmpDir();
      const stubRoot = tmpDir();
      try {
        const cli = writeStubAgentwright(stubRoot, '2.1.5');
        setupAgentwrightConfig(cwd, cli);
        await assert.rejects(
          pipelinePhase.buildDescriptor({ name: 'audit', index: 0, type: 'pipeline' }, SAMPLE_WORKFLOW, { cwd }),
          /requires "pipelineName"/
        );
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
        fs.rmSync(stubRoot, { recursive: true, force: true });
      }
    });

    test('throws when agentwright is missing entirely (fail-fast at descriptor build)', async () => {
      const cwd = tmpDir();
      const empty = tmpDir();
      const prev = process.env.CLAUDE_PLUGIN_ROOT;
      try {
        process.env.CLAUDE_PLUGIN_ROOT = empty;
        await assert.rejects(
          pipelinePhase.buildDescriptor(
            { name: 'audit', index: 0, type: 'pipeline', pipelineName: 'default' },
            SAMPLE_WORKFLOW,
            { cwd },
          ),
          /agentwright CLI not found/
        );
      } finally {
        if (prev === undefined) delete process.env.CLAUDE_PLUGIN_ROOT;
        else process.env.CLAUDE_PLUGIN_ROOT = prev;
        fs.rmSync(cwd, { recursive: true, force: true });
        fs.rmSync(empty, { recursive: true, force: true });
      }
    });
  });

  describe('validateResult', () => {
    test('accepts an empty object result', () => {
      assert.doesNotThrow(() => pipelinePhase.validateResult({}, {}));
    });

    test('accepts a result with a well-formed mcpResult delta payload', () => {
      assert.doesNotThrow(() => pipelinePhase.validateResult({
        mcpResult: {
          totalAdded: 5, totalDeleted: 2, totalDiffLines: 7, totalLoc: 100,
          ratio: 0.07, changedFiles: ['src/a.js'],
        },
      }, {}));
    });

    test('rejects a malformed mcpResult delta payload', () => {
      assert.throws(
        () => pipelinePhase.validateResult({
          mcpResult: { totalAdded: 'not a number', totalDeleted: 0, totalDiffLines: 0, totalLoc: 0, ratio: 0, changedFiles: [] },
        }, {}),
        /totalAdded must be a finite number/
      );
    });

    test('rejects non-object result', () => {
      assert.throws(() => pipelinePhase.validateResult(null, {}), /must be an object/);
    });
  });
});
