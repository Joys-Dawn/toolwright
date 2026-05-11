'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  lastPipelinePhase,
  decideReplayDeterministic,
  buildReauditDecisionPrompt,
  buildReplayPipelinePhase,
  maybeAppendReauditPhase,
} = require('../../coordinator/reaudit-applier');
const {
  createWorkflow,
  loadWorkflow,
  mutateWorkflow,
} = require('../../coordinator/workflow-ledger');
const { writeStubAgentwright: writeStub } = require('../_helpers/agentwright-stub');

function tmpDir(prefix = 'fw-reaudit-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function setupWorkflow(cwd, reaudit, lastMcpResult, opts = {}) {
  const stubRoot = tmpDir('fw-reaudit-stub-');
  const cli = writeStub(stubRoot, { version: '2.1.5', runId: 'reaudit-stub-run' });
  fs.mkdirSync(path.join(cwd, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.claude', 'forgewright.json'),
    JSON.stringify({ agentwright: { path: cli }, reaudit }), 'utf8');
  const def = {
    phases: [{
      name: 'audit',
      type: 'pipeline',
      pipelineName: 'default',
      scope: '--diff',
      loopable: opts.loopable ?? true,
    }],
  };
  const wf = createWorkflow(cwd, { workflowName: 'feature', definition: def });
  return mutateWorkflow(cwd, wf.workflowId, w => {
    w.phases[0].status = 'completed';
    if (lastMcpResult !== undefined) w.phases[0].lastMcpResult = lastMcpResult;
    if (opts.reauditCycles) w.reauditCycles = opts.reauditCycles;
    w.currentPhaseIndex = 1;
    return w;
  }).then(() => ({ wf, stubRoot }));
}

describe('reaudit-applier', () => {
  describe('lastPipelinePhase', () => {
    test('returns the last pipeline phase regardless of mcpResult', () => {
      const wf = {
        phases: [
          { type: 'skill', skillId: 's' },
          { type: 'pipeline', pipelineName: 'default' },
          { type: 'skill', skillId: 'verify' },
          { type: 'pipeline', pipelineName: 'default', lastMcpResult: { totalDiffLines: 3 } },
          { type: 'command', command: 'npm test' },
        ],
      };
      const last = lastPipelinePhase(wf);
      assert.equal(last.lastMcpResult.totalDiffLines, 3);
    });

    test('returns null when there are no pipeline phases', () => {
      assert.equal(lastPipelinePhase({ phases: [{ type: 'skill' }] }), null);
    });
  });

  describe('decideReplayDeterministic', () => {
    test('replays when delta crosses minDeltaPercent', () => {
      const r = decideReplayDeterministic(
        { totalDiffLines: 50, ratio: 0.10 },
        { reauditCycles: 0, reaudit: { maxCycles: 2, minDeltaPercent: 5, minDeltaLines: 0 } },
      );
      assert.equal(r.shouldReplay, true);
      assert.equal(r.reason, 'delta-threshold');
    });

    test('does not replay below threshold', () => {
      const r = decideReplayDeterministic(
        { totalDiffLines: 1, ratio: 0.001 },
        { reauditCycles: 0, reaudit: { maxCycles: 2, minDeltaPercent: 5, minDeltaLines: 50 } },
      );
      assert.equal(r.shouldReplay, false);
    });

    test('does not replay when at maxCycles', () => {
      const r = decideReplayDeterministic(
        { totalDiffLines: 100, ratio: 0.5 },
        { reauditCycles: 1, reaudit: { maxCycles: 1, minDeltaPercent: 5, minDeltaLines: 0 } },
      );
      assert.equal(r.shouldReplay, false);
      assert.equal(r.reason, 'max-cycles-reached');
    });

    test('both thresholds at 0 means deterministic replay is disabled', () => {
      // The natural read of "minDeltaPercent: 0, minDeltaLines: 0" is "no
      // threshold-based replay" — not "replay on any non-empty diff" (which
      // is what the old special-case branch did). Users who want
      // always-replay should switch decisionMode to "leader".
      const r = decideReplayDeterministic(
        { totalDiffLines: 1000, ratio: 0.9 },
        { reauditCycles: 0, reaudit: { maxCycles: 1, minDeltaPercent: 0, minDeltaLines: 0 } },
      );
      assert.equal(r.shouldReplay, false);
      assert.equal(r.reason, 'thresholds-disabled');
    });

    test('absolute lines threshold can trigger replay alone', () => {
      const r = decideReplayDeterministic(
        { totalDiffLines: 200, ratio: 0.001 },
        { reauditCycles: 0, reaudit: { maxCycles: 1, minDeltaPercent: 50, minDeltaLines: 100 } },
      );
      assert.equal(r.shouldReplay, true);
    });
  });

  describe('buildReauditDecisionPrompt', () => {
    test('returns a non-empty string the leader can hand to the reaudit-decision skill', () => {
      // The prompt body is LLM-facing documentation; its wording is not the
      // contract. The behavior we care about: a string is returned that the
      // caller can route to the skill verbatim. The structural fields it's
      // built from (workflow/deltas/reaudit/reauditCycles) are the contract.
      const prompt = buildReauditDecisionPrompt({
        workflow: { workflowName: 'feature', workflowId: 'wf-1' },
        deltas: { totalAdded: 50, totalDeleted: 20, totalDiffLines: 70, totalLoc: 700, ratio: 0.1, changedFiles: ['x.js'] },
        reaudit: { maxCycles: 2, loopableStages: ['correctness'] },
        reauditCycles: 0,
      });
      assert.equal(typeof prompt, 'string');
      assert.ok(prompt.length > 0);
    });

    test('handles missing changedFiles without throwing', () => {
      // Real behavior: the function tolerates an absent changedFiles field
      // (older payloads, partial mock inputs). It must not throw.
      assert.doesNotThrow(() => buildReauditDecisionPrompt({
        workflow: { workflowName: 'feature', workflowId: 'wf-1' },
        deltas: { totalAdded: 0, totalDeleted: 0, totalDiffLines: 0, totalLoc: 100, ratio: 0 },
        reaudit: { maxCycles: 2, loopableStages: [] },
        reauditCycles: 0,
      }));
    });
  });

  describe('buildReplayPipelinePhase', () => {
    test('puts the comma-separated stage list in pipelineName, not in scope', () => {
      const phase = buildReplayPipelinePhase(['correctness', 'behavior', 'security'], 0);
      assert.equal(phase.type, 'pipeline');
      assert.equal(phase.pipelineName, 'correctness,behavior,security');
      assert.equal(phase.scope, '--diff');
      assert.equal(phase.loopable, true);
      assert.equal(phase.idempotent, false);
      assert.equal(phase.reauditCycle, 1);
      assert.equal(phase.name, 'reaudit-1');
      assert.doesNotMatch(phase.scope, /--stages/);
    });

    test('falls back to "default" pipelineName when loopableStages is empty', () => {
      const phase = buildReplayPipelinePhase([], 1);
      assert.equal(phase.pipelineName, 'default');
      assert.equal(phase.scope, '--diff');
      assert.equal(phase.reauditCycle, 2);
      assert.equal(phase.name, 'reaudit-2');
    });

    test('filters non-string entries from the stages list', () => {
      const phase = buildReplayPipelinePhase(['correctness', '', null, 'security'], 0);
      assert.equal(phase.pipelineName, 'correctness,security');
      assert.equal(phase.name, 'reaudit-1');
    });
  });

  describe('maybeAppendReauditPhase', () => {
    test('returns null when last pipeline phase has no lastMcpResult', async () => {
      const cwd = tmpDir();
      try {
        const { wf, stubRoot } = await setupWorkflow(
          cwd,
          { maxCycles: 2, minDeltaPercent: 5, minDeltaLines: 0, loopableStages: ['correctness'] },
          undefined, // no deltas captured
        );
        try {
          const result = await maybeAppendReauditPhase(cwd, wf.workflowId);
          assert.equal(result, null);
        } finally {
          fs.rmSync(stubRoot, { recursive: true, force: true });
        }
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    });

    test('returns null when last pipeline phase is not loopable', async () => {
      const cwd = tmpDir();
      try {
        const { wf, stubRoot } = await setupWorkflow(
          cwd,
          { maxCycles: 2, minDeltaPercent: 5, minDeltaLines: 0, loopableStages: ['correctness'] },
          { totalAdded: 100, totalDeleted: 0, totalDiffLines: 100, totalLoc: 200, ratio: 0.5, changedFiles: ['x'] },
          { loopable: false },
        );
        try {
          const result = await maybeAppendReauditPhase(cwd, wf.workflowId);
          assert.equal(result, null);
        } finally {
          fs.rmSync(stubRoot, { recursive: true, force: true });
        }
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    });

    test('appends a replay pipeline phase when deltas cross threshold (deterministic mode)', async () => {
      const cwd = tmpDir();
      try {
        const { wf, stubRoot } = await setupWorkflow(
          cwd,
          {
            maxCycles: 2,
            minDeltaPercent: 5,
            minDeltaLines: 0,
            decisionMode: 'deterministic',
            loopableStages: ['correctness', 'behavior'],
          },
          { totalAdded: 50, totalDeleted: 20, totalDiffLines: 70, totalLoc: 700, ratio: 0.10, changedFiles: ['src/x.js'] },
        );
        try {
          const result = await maybeAppendReauditPhase(cwd, wf.workflowId);
          // reaudit-applier returns a 'replay-appended' sentinel so the
          // caller (workflow-lifecycle.buildAndPersistDescriptor) rebuilds
          // the descriptor for the freshly-appended phase. That keeps the
          // import graph one-directional.
          assert.equal(result.kind, 'replay-appended');
          assert.equal(result.workflowId, wf.workflowId);
          const reloaded = loadWorkflow(cwd, wf.workflowId);
          assert.equal(reloaded.reauditCycles, 1);
          assert.equal(reloaded.phases.length, 2);
          assert.equal(reloaded.phases[1].type, 'pipeline');
          assert.equal(reloaded.phases[1].pipelineName, 'correctness,behavior');
        } finally {
          fs.rmSync(stubRoot, { recursive: true, force: true });
        }
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    });

    test('returns a reaudit-decision prompt when leader mode is enabled', async () => {
      const cwd = tmpDir();
      try {
        const { wf, stubRoot } = await setupWorkflow(
          cwd,
          {
            maxCycles: 2,
            minDeltaPercent: 5,
            minDeltaLines: 0,
            decisionMode: 'leader',
            loopableStages: ['correctness'],
          },
          { totalAdded: 50, totalDeleted: 20, totalDiffLines: 70, totalLoc: 700, ratio: 0.10, changedFiles: ['src/x.js'] },
        );
        try {
          const result = await maybeAppendReauditPhase(cwd, wf.workflowId);
          // Behavioral contract: kind + the structured fields the caller uses
          // to route the decision. Prompt/respondInstruction wording is doc.
          assert.equal(result.kind, 'reaudit-decision');
          assert.equal(result.workflowId, wf.workflowId);
          assert.equal(result.reauditCycles, 0);
          assert.equal(result.maxCycles, 2);
          assert.deepEqual(result.loopableStages, ['correctness']);
          assert.equal(result.deltas.totalDiffLines, 70);
          assert.equal(typeof result.prompt, 'string');
          assert.ok(result.prompt.length > 0);
          assert.equal(typeof result.respondInstruction, 'string');
          assert.ok(result.respondInstruction.length > 0);
        } finally {
          fs.rmSync(stubRoot, { recursive: true, force: true });
        }
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    });

    test('suffixes the auto-generated phase name when the user already declared a phase named reaudit-N', async () => {
      // Defends the uniqueness loop in appendReplayPhaseAndBumpCycles. The
      // workflow declares its own phase named "reaudit-1" — at cycle 0,
      // buildReplayPipelinePhase tries to append a NEW "reaudit-1" → collision
      // → the loop must suffix it to "reaudit-1-r2" so unique-name invariants
      // hold.
      const cwd = tmpDir();
      try {
        const stubRoot = tmpDir('fw-reaudit-stub-');
        const cli = writeStub(stubRoot, { version: '2.1.5', runId: 'reaudit-stub-run' });
        fs.mkdirSync(path.join(cwd, '.claude'), { recursive: true });
        fs.writeFileSync(path.join(cwd, '.claude', 'forgewright.json'),
          JSON.stringify({
            agentwright: { path: cli },
            reaudit: { maxCycles: 2, minDeltaPercent: 5, minDeltaLines: 0, decisionMode: 'deterministic', loopableStages: ['correctness'] },
          }), 'utf8');
        const def = {
          phases: [
            { name: 'audit', type: 'pipeline', pipelineName: 'default', scope: '--diff', loopable: true },
            // User-declared phase that happens to collide with the auto-generated reaudit-1 name.
            // It's not a pipeline, so lastPipelinePhase still returns 'audit'.
            { name: 'reaudit-1', type: 'skill', skillId: 'verify' },
          ],
        };
        const wf = createWorkflow(cwd, { workflowName: 'feature', definition: def });
        await mutateWorkflow(cwd, wf.workflowId, w => {
          w.phases[0].status = 'completed';
          w.phases[0].lastMcpResult = { totalAdded: 50, totalDeleted: 20, totalDiffLines: 70, totalLoc: 700, ratio: 0.10, changedFiles: ['x'] };
          w.phases[1].status = 'completed';
          w.currentPhaseIndex = 2;
          return w;
        });
        try {
          const result = await maybeAppendReauditPhase(cwd, wf.workflowId);
          assert.equal(result.kind, 'replay-appended');
          const reloaded = loadWorkflow(cwd, wf.workflowId);
          assert.equal(reloaded.phases.length, 3);
          const appended = reloaded.phases[2];
          assert.equal(appended.name, 'reaudit-1-r2', 'collision must be resolved by -r2 suffix');
          assert.equal(appended.type, 'pipeline');
          // Workflow-wide name uniqueness invariant must hold.
          const names = reloaded.phases.map(p => p.name);
          assert.equal(new Set(names).size, names.length, 'phase names must be unique workflow-wide');
        } finally {
          fs.rmSync(stubRoot, { recursive: true, force: true });
        }
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    });

    test('returns null when at maxCycles in deterministic mode', async () => {
      const cwd = tmpDir();
      try {
        const { wf, stubRoot } = await setupWorkflow(
          cwd,
          { maxCycles: 1, minDeltaPercent: 5, minDeltaLines: 0, decisionMode: 'deterministic', loopableStages: ['correctness'] },
          { totalAdded: 100, totalDeleted: 0, totalDiffLines: 100, totalLoc: 200, ratio: 0.5, changedFiles: ['x'] },
          { reauditCycles: 1 },
        );
        try {
          const result = await maybeAppendReauditPhase(cwd, wf.workflowId);
          assert.equal(result, null);
        } finally {
          fs.rmSync(stubRoot, { recursive: true, force: true });
        }
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    });
  });
});
