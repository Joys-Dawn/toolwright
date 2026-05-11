'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createWorkflow,
  loadWorkflow,
  mutateWorkflow,
} = require('../../coordinator/workflow-ledger');
const {
  buildAndPersistDescriptor,
  advanceWorkflow,
  resumeWorkflow,
  buildIdempotencePrompt,
  findDownstreamConsumers,
  buildReplayPipelinePhase,
  handleReauditDecision,
  maybeAppendReauditPhase,
} = require('../../coordinator/workflow-lifecycle');

const { writeStubAgentwright: writeStub } = require('../_helpers/agentwright-stub');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fw-life-'));
}

function writeStubAgentwright(root, version) {
  return writeStub(root, { version, runId: 'lifecycle-run' });
}

async function withStubAgentwright(cwd, fn) {
  // The cleanup MUST be inside an async finally — a sync try/finally returning
  // the Promise from fn() would tear down stubRoot before the awaits complete.
  const stubRoot = tmpDir();
  try {
    const cli = writeStubAgentwright(stubRoot, '2.1.5');
    fs.mkdirSync(path.join(cwd, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.claude', 'forgewright.json'),
      JSON.stringify({ agentwright: { path: cli } }), 'utf8');
    return await fn();
  } finally {
    fs.rmSync(stubRoot, { recursive: true, force: true });
  }
}

const SIMPLE_DEF = {
  phases: [
    { name: 'plan', type: 'skill', skillId: 'agentwright:feature-planning', produces: 'plan' },
    { name: 'plan-review', type: 'checkpoint', summary: 'review' },
    { name: 'verify', type: 'skill', skillId: 'agentwright:verify-plan', consumes: 'plan', idempotent: true },
    { name: 'tests', type: 'command', command: 'echo done' },
  ],
};

describe('workflow-lifecycle', () => {
  describe('buildAndPersistDescriptor', () => {
    test('returns first skill phase descriptor and marks it running', async () => {
      const cwd = tmpDir();
      try {
        await withStubAgentwright(cwd, async () => {
          const wf = createWorkflow(cwd, { workflowName: 'feature', definition: SIMPLE_DEF });
          const d = await buildAndPersistDescriptor(cwd, wf.workflowId);
          assert.equal(d.kind, 'phase');
          assert.equal(d.type, 'skill');
          assert.equal(d.skillId, 'agentwright:feature-planning');
          const reloaded = loadWorkflow(cwd, wf.workflowId);
          assert.equal(reloaded.status, 'running');
          assert.equal(reloaded.phases[0].status, 'running');
          assert.ok(reloaded.phases[0].startedAt);
        });
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    });

    test('returns done when index is past last phase', async () => {
      const cwd = tmpDir();
      try {
        await withStubAgentwright(cwd, async () => {
          const wf = createWorkflow(cwd, { workflowName: 'feature', definition: SIMPLE_DEF });
          await mutateWorkflow(cwd, wf.workflowId, w => { w.currentPhaseIndex = w.phases.length; });
          const d = await buildAndPersistDescriptor(cwd, wf.workflowId);
          assert.equal(d.kind, 'done');
          const reloaded = loadWorkflow(cwd, wf.workflowId);
          assert.equal(reloaded.status, 'completed');
        });
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    });

    test('returns terminalDescriptor when the workflow is already in a terminal state', async () => {
      // Re-entry on a terminal workflow short-circuits before any phase work.
      // Pins the mapping in terminalDescriptor so a future regression that, e.g.,
      // dropped the 'workflow-failed' code or changed 'cancelled' → 'canceled'
      // would fail here instead of silently mis-routing the leader.
      const cwd = tmpDir();
      try {
        await withStubAgentwright(cwd, async () => {
          const a = createWorkflow(cwd, { workflowName: 'feature', definition: SIMPLE_DEF });
          await mutateWorkflow(cwd, a.workflowId, w => { w.status = 'cancelled'; });
          const dC = await buildAndPersistDescriptor(cwd, a.workflowId);
          assert.equal(dC.kind, 'cancelled');
          assert.equal(dC.workflowId, a.workflowId);

          const b = createWorkflow(cwd, { workflowName: 'feature', definition: SIMPLE_DEF });
          await mutateWorkflow(cwd, b.workflowId, w => { w.status = 'failed'; });
          const dF = await buildAndPersistDescriptor(cwd, b.workflowId);
          assert.equal(dF.kind, 'error');
          assert.equal(dF.code, 'workflow-failed');
          assert.equal(dF.workflowId, b.workflowId);
        });
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    });
  });

  describe('advanceWorkflow', () => {
    test('records skill phase result and returns next descriptor', async () => {
      const cwd = tmpDir();
      try {
        await withStubAgentwright(cwd, async () => {
          const wf = createWorkflow(cwd, { workflowName: 'feature', definition: SIMPLE_DEF });
          await buildAndPersistDescriptor(cwd, wf.workflowId);
          const next = await advanceWorkflow(cwd, wf.workflowId, {
            result: 'completed',
            artifactPath: 'artifacts/plan.md',
          });
          // Phase 1 (checkpoint) is next
          assert.equal(next.kind, 'checkpoint');
          assert.equal(next.name, 'plan-review');
          const reloaded = loadWorkflow(cwd, wf.workflowId);
          assert.equal(reloaded.phases[0].status, 'completed');
          assert.equal(reloaded.phases[0].artifactPath, 'artifacts/plan.md');
          assert.equal(reloaded.artifacts.plan, 'artifacts/plan.md');
          assert.equal(reloaded.status, 'paused');
          assert.equal(reloaded.currentPhaseIndex, 1);
        });
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    });

    test('rejects skill phase completed result without artifactPath when produces is set', async () => {
      const cwd = tmpDir();
      try {
        await withStubAgentwright(cwd, async () => {
          const wf = createWorkflow(cwd, { workflowName: 'feature', definition: SIMPLE_DEF });
          await buildAndPersistDescriptor(cwd, wf.workflowId);
          await assert.rejects(
            advanceWorkflow(cwd, wf.workflowId, { result: 'completed' }),
            /--artifact-path is required/
          );
        });
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    });

    test('rejects advancing past a checkpoint', async () => {
      const cwd = tmpDir();
      try {
        await withStubAgentwright(cwd, async () => {
          const wf = createWorkflow(cwd, { workflowName: 'feature', definition: SIMPLE_DEF });
          await mutateWorkflow(cwd, wf.workflowId, w => { w.currentPhaseIndex = 1; });
          await assert.rejects(
            advanceWorkflow(cwd, wf.workflowId, { result: 'completed' }),
            /Cannot advance past a checkpoint/
          );
        });
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    });

    test('--skip marks phase skipped and advances', async () => {
      const cwd = tmpDir();
      try {
        await withStubAgentwright(cwd, async () => {
          const wf = createWorkflow(cwd, { workflowName: 'feature', definition: SIMPLE_DEF });
          await buildAndPersistDescriptor(cwd, wf.workflowId);
          const next = await advanceWorkflow(cwd, wf.workflowId, { skip: true });
          assert.equal(next.kind, 'checkpoint');
          const reloaded = loadWorkflow(cwd, wf.workflowId);
          assert.equal(reloaded.phases[0].status, 'skipped');
        });
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    });

    test('skill produces with extension auto-registers under the stem (no --artifact-path needed)', async () => {
      const cwd = tmpDir();
      try {
        await withStubAgentwright(cwd, async () => {
          const def = {
            phases: [
              { name: 'plan', type: 'skill', skillId: 'agentwright:feature-planning', produces: 'plan.md' },
              { name: 'tests', type: 'command', command: 'echo done' },
            ],
          };
          const wf = createWorkflow(cwd, { workflowName: 'feature', definition: def });
          await buildAndPersistDescriptor(cwd, wf.workflowId);
          // Extension-form produces is fully determined by the workflow def —
          // the leader does NOT need to pass --artifact-path. validateResult
          // only enforces the flag for bare-form produces (where the skill
          // picks the extension at write time). The auto-registration below
          // stamps phase.artifactPath and w.artifacts[stem] from the produces
          // config alone.
          const next = await advanceWorkflow(cwd, wf.workflowId, {
            result: 'completed',
          });
          assert.equal(next.kind, 'phase');
          const reloaded = loadWorkflow(cwd, wf.workflowId);
          assert.equal(reloaded.artifacts.plan, 'artifacts/plan.md');
          assert.equal(reloaded.phases[0].artifactPath, 'artifacts/plan.md');
        });
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    });

    test('command produces with extension auto-registers under the stem without --artifact-path', async () => {
      const cwd = tmpDir();
      try {
        await withStubAgentwright(cwd, async () => {
          const def = {
            phases: [
              { name: 'eval', type: 'command', command: 'python eval.py --out-dir ${ARTIFACTS}', produces: 'metrics.json' },
            ],
          };
          const wf = createWorkflow(cwd, { workflowName: 'feature', definition: def });
          await buildAndPersistDescriptor(cwd, wf.workflowId);
          const next = await advanceWorkflow(cwd, wf.workflowId, {
            result: 'completed',
            // No --artifact-path — forgewright derives the path from produces.
            mcpResult: { command: 'python eval.py', exitCode: 0, summary: 'ok' },
          });
          assert.equal(next.kind, 'done');
          const reloaded = loadWorkflow(cwd, wf.workflowId);
          assert.equal(reloaded.artifacts.metrics, 'artifacts/metrics.json');
          assert.equal(reloaded.phases[0].artifactPath, 'artifacts/metrics.json');
        });
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    });

    test('command produces map auto-registers every entry under its stem', async () => {
      const cwd = tmpDir();
      try {
        await withStubAgentwright(cwd, async () => {
          const def = {
            phases: [
              {
                name: 'train',
                type: 'command',
                command: 'python train.py --output-dir ${ARTIFACTS}',
                produces: { metrics: 'metrics.json', model: 'model.bin', log: 'train.log' },
              },
            ],
          };
          const wf = createWorkflow(cwd, { workflowName: 'feature', definition: def });
          await buildAndPersistDescriptor(cwd, wf.workflowId);
          const next = await advanceWorkflow(cwd, wf.workflowId, {
            result: 'completed',
            mcpResult: { command: 'python train.py', exitCode: 0, summary: 'ok' },
          });
          assert.equal(next.kind, 'done');
          const reloaded = loadWorkflow(cwd, wf.workflowId);
          assert.equal(reloaded.artifacts.metrics, 'artifacts/metrics.json');
          assert.equal(reloaded.artifacts.model, 'artifacts/model.bin');
          assert.equal(reloaded.artifacts.log, 'artifacts/train.log');
          // Multi-output: phase.artifactPath stays null (no canonical single path).
          assert.equal(reloaded.phases[0].artifactPath, undefined);
        });
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    });

    test('result=failed marks workflow failed', async () => {
      const cwd = tmpDir();
      try {
        await withStubAgentwright(cwd, async () => {
          const wf = createWorkflow(cwd, { workflowName: 'feature', definition: SIMPLE_DEF });
          await buildAndPersistDescriptor(cwd, wf.workflowId);
          const next = await advanceWorkflow(cwd, wf.workflowId, { result: 'failed' });
          assert.equal(next.kind, 'error');
          const reloaded = loadWorkflow(cwd, wf.workflowId);
          assert.equal(reloaded.status, 'failed');
          assert.equal(reloaded.phases[0].status, 'failed');
        });
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    });

    describe('handoff phase batch recording (advanceWorkflow integration)', () => {
      const HANDOFF_DEF = {
        phases: [
          { name: 'implement', type: 'handoff', directive: 'do the work' },
        ],
      };

      test('valid batch result is written to peer-handoffs.jsonl', async () => {
        const cwd = tmpDir();
        try {
          await withStubAgentwright(cwd, async () => {
            const wf = createWorkflow(cwd, { workflowName: 'feature', definition: HANDOFF_DEF });
            await buildAndPersistDescriptor(cwd, wf.workflowId);
            const batch = {
              tasks: [
                { key: 'task-1', by: 'peer:alice-42', status: 'completed', ackId: 'ack-1' },
                { key: 'task-2', by: 'self', status: 'completed' },
              ],
            };
            const next = await advanceWorkflow(cwd, wf.workflowId, {
              result: 'completed', mcpResult: batch,
            });
            assert.equal(next.kind, 'done');
            const file = path.join(cwd, '.claude', 'forgewright', 'workflows', wf.workflowId, 'peer-handoffs.jsonl');
            assert.ok(fs.existsSync(file), 'peer-handoffs.jsonl must be written on handoff advance');
            const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
            assert.equal(lines.length, 2);
            const entries = lines.map(l => JSON.parse(l));
            assert.deepEqual(entries.map(e => e.taskKey), ['task-1', 'task-2']);
            assert.equal(entries[0].by, 'peer:alice-42');
            assert.equal(entries[1].by, 'self');
          });
        } finally {
          fs.rmSync(cwd, { recursive: true, force: true });
        }
      });

      test('fs failure during peer-handoffs.jsonl write surfaces to stderr without aborting the advance', async () => {
        // recordBatch is best-effort by contract: if the workflow audit log
        // can't be written (disk full, permission denied, EBUSY on Windows),
        // the advance must still mark the phase completed. The operator sees
        // a stderr line so degraded auditability isn't silent.
        const cwd = tmpDir();
        const origAppend = fs.appendFileSync;
        const origWrite = process.stderr.write.bind(process.stderr);
        const captured = [];
        try {
          await withStubAgentwright(cwd, async () => {
            const wf = createWorkflow(cwd, { workflowName: 'feature', definition: HANDOFF_DEF });
            await buildAndPersistDescriptor(cwd, wf.workflowId);
            // Block only appendFileSync targeting peer-handoffs.jsonl. The
            // workflow.json writes through writeJson use renameSync — they're
            // unaffected, so mutateWorkflow still lands.
            fs.appendFileSync = function (target, ...rest) {
              if (typeof target === 'string' && target.endsWith('peer-handoffs.jsonl')) {
                const err = new Error('simulated EACCES');
                err.code = 'EACCES';
                throw err;
              }
              return origAppend.call(this, target, ...rest);
            };
            process.stderr.write = (msg) => { captured.push(String(msg)); return true; };
            const result = await advanceWorkflow(cwd, wf.workflowId, {
              result: 'completed',
              mcpResult: { tasks: [{ key: 't1', by: 'self', status: 'completed' }] },
            });
            // Advance still succeeds — workflow done, phase completed.
            assert.equal(result.kind, 'done');
            const reloaded = loadWorkflow(cwd, wf.workflowId);
            assert.equal(reloaded.phases[0].status, 'completed');
            // Operator must see degraded auditability.
            const joined = captured.join('');
            assert.match(joined, /failed to record peer-handoff audit/);
            assert.match(joined, /implement/);
            assert.match(joined, /simulated EACCES/);
          });
        } finally {
          fs.appendFileSync = origAppend;
          process.stderr.write = origWrite;
          fs.rmSync(cwd, { recursive: true, force: true });
        }
      });
    });
  });

  describe('resumeWorkflow', () => {
    test('advances past checkpoint and returns next descriptor', async () => {
      const cwd = tmpDir();
      try {
        await withStubAgentwright(cwd, async () => {
          const wf = createWorkflow(cwd, { workflowName: 'feature', definition: SIMPLE_DEF });
          // Advance to the checkpoint
          await buildAndPersistDescriptor(cwd, wf.workflowId);
          await advanceWorkflow(cwd, wf.workflowId, {
            result: 'completed',
            artifactPath: 'artifacts/plan.md',
          });
          // Now at checkpoint (paused). Resume.
          const next = await resumeWorkflow(cwd, wf.workflowId);
          assert.equal(next.kind, 'phase');
          assert.equal(next.skillId, 'agentwright:verify-plan');
          const reloaded = loadWorkflow(cwd, wf.workflowId);
          assert.equal(reloaded.phases[1].status, 'completed');
          assert.equal(reloaded.currentPhaseIndex, 2);
        });
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    });

    test('returns paused prompt for non-idempotent phase that previously started', async () => {
      const cwd = tmpDir();
      try {
        await withStubAgentwright(cwd, async () => {
          const wf = createWorkflow(cwd, { workflowName: 'feature', definition: SIMPLE_DEF });
          // Mark phase 0 (skill, idempotent: false) as previously started
          await mutateWorkflow(cwd, wf.workflowId, w => {
            w.phases[0].startedAt = new Date().toISOString();
            w.phases[0].status = 'running';
            w.status = 'paused';
          });
          const result = await resumeWorkflow(cwd, wf.workflowId);
          // Behavioral contract: paused descriptor with the right phase
          // identity. Prompt/respondInstruction wording is documentation —
          // the --force / --skip flag mechanisms are exercised in the tests
          // immediately below.
          assert.equal(result.kind, 'paused');
          assert.equal(result.workflowId, wf.workflowId);
          assert.equal(result.phaseIndex, 0);
          assert.equal(result.phaseType, 'skill');
          assert.equal(typeof result.prompt, 'string');
          assert.ok(result.prompt.length > 0);
          assert.equal(typeof result.respondInstruction, 'string');
          assert.ok(result.respondInstruction.length > 0);
        });
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    });

    test('--force bypasses idempotence prompt', async () => {
      const cwd = tmpDir();
      try {
        await withStubAgentwright(cwd, async () => {
          const wf = createWorkflow(cwd, { workflowName: 'feature', definition: SIMPLE_DEF });
          await mutateWorkflow(cwd, wf.workflowId, w => {
            w.phases[0].startedAt = new Date().toISOString();
            w.phases[0].status = 'running';
            w.status = 'paused';
          });
          const result = await resumeWorkflow(cwd, wf.workflowId, { force: true });
          assert.equal(result.kind, 'phase');
          assert.equal(result.skillId, 'agentwright:feature-planning');
        });
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    });

    test('--force on a started pipeline phase resets it to pending so the LLM re-invokes /agentwright:audit-run fresh', async () => {
      const cwd = tmpDir();
      try {
        await withStubAgentwright(cwd, async () => {
          const wf = createWorkflow(cwd, {
            workflowName: 'feature',
            definition: { phases: [{ name: 'audit', type: 'pipeline', pipelineName: 'default' }] },
          });
          await mutateWorkflow(cwd, wf.workflowId, w => {
            w.phases[0].status = 'running';
            w.phases[0].startedAt = new Date().toISOString();
            w.status = 'paused';
          });
          const result = await resumeWorkflow(cwd, wf.workflowId, { force: true });
          assert.equal(result.kind, 'phase');
          assert.equal(result.type, 'pipeline');
          // Forgewright no longer tracks an agentwright runId — pipeline phases
          // are atomic from forgewright's POV. The LLM (driven by the
          // descriptor instruction) invokes /agentwright:audit-run, which
          // spawns its own fresh run with a runId only the LLM sees.
          assert.equal(result.agentwrightRunId, undefined);
          assert.match(result.instruction, /\/agentwright:audit-run/);
          const reloaded = loadWorkflow(cwd, wf.workflowId);
          // The phase is now back to running with a freshly-set startedAt
          // (the previous startedAt was cleared by resetPhaseForRerun before
          // buildAndPersistDescriptor stamped a new one).
          assert.equal(reloaded.phases[0].status, 'running');
          assert.equal(reloaded.phases[0].agentwrightRunId, undefined);
        });
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    });

    test('idempotent phase resumes without prompt', async () => {
      const cwd = tmpDir();
      try {
        await withStubAgentwright(cwd, async () => {
          const wf = createWorkflow(cwd, { workflowName: 'feature', definition: SIMPLE_DEF });
          // Move to phase 2 (verify-plan, idempotent: true) and mark started
          await mutateWorkflow(cwd, wf.workflowId, w => {
            w.currentPhaseIndex = 2;
            w.phases[0].status = 'completed';
            w.phases[1].status = 'completed';
            w.phases[2].startedAt = new Date().toISOString();
          });
          const result = await resumeWorkflow(cwd, wf.workflowId);
          assert.equal(result.kind, 'phase');
          assert.equal(result.skillId, 'agentwright:verify-plan');
        });
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    });

    test('returns terminalDescriptor when the workflow is already in a terminal state', async () => {
      // Mirrors the buildAndPersistDescriptor terminal-state test: resume on a
      // cancelled / failed workflow must short-circuit through the same
      // terminalDescriptor helper, not advance into phase work.
      const cwd = tmpDir();
      try {
        await withStubAgentwright(cwd, async () => {
          const a = createWorkflow(cwd, { workflowName: 'feature', definition: SIMPLE_DEF });
          await mutateWorkflow(cwd, a.workflowId, w => { w.status = 'cancelled'; });
          const dC = await resumeWorkflow(cwd, a.workflowId);
          assert.equal(dC.kind, 'cancelled');
          assert.equal(dC.workflowId, a.workflowId);

          const b = createWorkflow(cwd, { workflowName: 'feature', definition: SIMPLE_DEF });
          await mutateWorkflow(cwd, b.workflowId, w => { w.status = 'failed'; });
          const dF = await resumeWorkflow(cwd, b.workflowId);
          assert.equal(dF.kind, 'error');
          assert.equal(dF.code, 'workflow-failed');
          assert.equal(dF.workflowId, b.workflowId);
        });
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    });
  });

  // The downstream-impact warning logic is owned by findDownstreamConsumers
  // (pure function, structured return). That's what we assert behaviorally —
  // the buildIdempotencePrompt rendering is documentation built ON TOP of this
  // analysis and its wording is not the contract. One smoke test confirms the
  // prompt is non-empty so a future regression that returns "" still fails.
  test('buildIdempotencePrompt returns a non-empty string', () => {
    const prompt = buildIdempotencePrompt(
      { index: 4, type: 'pipeline', name: 'audit', pipelineName: 'default' },
    );
    assert.equal(typeof prompt, 'string');
    assert.ok(prompt.length > 0);
  });

  test('buildIdempotencePrompt without workflow argument still works (back-compat)', () => {
    // Single-arg form is used by tests / external callers that don't need the
    // downstream-consumer warning. Must not throw and must produce a prompt.
    assert.doesNotThrow(() => {
      const prompt = buildIdempotencePrompt(
        { index: 0, type: 'skill', name: 'plan', produces: 'plan.md' },
      );
      assert.ok(prompt.length > 0);
    });
  });

  describe('findDownstreamConsumers (pure)', () => {
    test('finds a consumer when a later skill→handoff phase depends on a stem', () => {
      const phases = [
        { index: 0, type: 'skill', name: 'plan', produces: 'plan.md' },
        { index: 1, type: 'handoff', name: 'implement', consumes: 'plan' },
      ];
      const consumers = findDownstreamConsumers(['plan'], phases, 0);
      assert.deepEqual(consumers, [
        { stem: 'plan', phaseName: 'implement', phaseIndex: 1 },
      ]);
    });

    test('resolves array-form consumes (command phase)', () => {
      const phases = [
        { index: 0, type: 'command', name: 'train', produces: { model: 'model.bin' } },
        { index: 1, type: 'command', name: 'backtest', consumes: ['model'] },
      ];
      const consumers = findDownstreamConsumers(['model'], phases, 0);
      assert.equal(consumers.length, 1);
      assert.equal(consumers[0].phaseName, 'backtest');
      assert.equal(consumers[0].phaseIndex, 1);
      assert.equal(consumers[0].stem, 'model');
    });

    test('returns [] when no later phase consumes the produce stems', () => {
      const phases = [
        { index: 0, type: 'skill', name: 'plan', produces: 'plan.md' },
        { index: 1, type: 'command', name: 'tests', command: '${TEST_CMD}' },
      ];
      const consumers = findDownstreamConsumers(['plan'], phases, 0);
      assert.deepEqual(consumers, []);
    });

    test('returns [] for empty produce stems input', () => {
      const phases = [
        { index: 0, type: 'pipeline', name: 'audit', pipelineName: 'default' },
        { index: 1, type: 'command', name: 'tests', command: '${TEST_CMD}' },
      ];
      const consumers = findDownstreamConsumers([], phases, 0);
      assert.deepEqual(consumers, []);
    });

    test('returns one entry per (stem, consumer) pair for multi-output producers', () => {
      const phases = [
        { index: 0, type: 'command', name: 'pipeline', produces: { metrics: 'metrics.json', model: 'model.bin' } },
        { index: 1, type: 'command', name: 'eval', consumes: 'metrics' },
        { index: 2, type: 'command', name: 'predict', consumes: ['model'] },
      ];
      const consumers = findDownstreamConsumers(['metrics', 'model'], phases, 0);
      assert.equal(consumers.length, 2);
      assert.ok(consumers.some(c => c.stem === 'metrics' && c.phaseName === 'eval' && c.phaseIndex === 1));
      assert.ok(consumers.some(c => c.stem === 'model' && c.phaseName === 'predict' && c.phaseIndex === 2));
    });
  });

  // buildReplayPipelinePhase's behavior is exhaustively tested in
  // reaudit-applier.test.js (where the function actually lives). The lifecycle
  // module re-exports it for convenience, so the only thing to verify here is
  // that the re-export wires up to the same function identity — preventing a
  // future split where lifecycle silently exports a stale copy.
  test('buildReplayPipelinePhase is re-exported (same identity as reaudit-applier)', () => {
    const fromApplier = require('../../coordinator/reaudit-applier').buildReplayPipelinePhase;
    assert.equal(buildReplayPipelinePhase, fromApplier);
  });

  describe('handleReauditDecision', () => {
    function setupCompletedWorkflow(cwd, opts = {}) {
      // Build a workflow already at end-of-phases, with a loopable pipeline phase recorded.
      fs.mkdirSync(path.join(cwd, '.claude'), { recursive: true });
      fs.writeFileSync(path.join(cwd, '.claude', 'forgewright.json'),
        JSON.stringify({
          agentwright: { path: opts.agentwrightCli || '' },
          reaudit: opts.reaudit || {
            maxCycles: 2,
            loopableStages: ['correctness', 'behavior', 'security'],
            decisionMode: 'leader',
          },
        }), 'utf8');
      const def = {
        phases: [
          { name: 'audit', type: 'pipeline', pipelineName: 'default', scope: '--diff', loopable: true },
        ],
      };
      const wf = createWorkflow(cwd, { workflowName: 'feature', definition: def });
      // Mark the phase complete with a delta payload (as if the LLM passed
      // check-deltas JSON via --mcp-result on workflow-advance).
      return mutateWorkflow(cwd, wf.workflowId, w => {
        w.phases[0].status = 'completed';
        w.phases[0].lastMcpResult = opts.lastMcpResult || {
          totalAdded: 50, totalDeleted: 20, totalDiffLines: 70,
          totalLoc: 700, ratio: 0.1, changedFiles: ['src/x.js'],
        };
        w.currentPhaseIndex = 1; // past the last phase
        return w;
      }).then(() => wf);
    }

    test('decision=clean marks workflow completed and returns done', async () => {
      const cwd = tmpDir();
      try {
        const stubRoot = tmpDir();
        const cli = writeStubAgentwright(stubRoot, '2.1.5');
        try {
          const wf = await setupCompletedWorkflow(cwd, { agentwrightCli: cli });
          const next = await handleReauditDecision(cwd, wf.workflowId, { decision: 'clean' });
          assert.equal(next.kind, 'done');
          const reloaded = loadWorkflow(cwd, wf.workflowId);
          assert.equal(reloaded.status, 'completed');
          assert.equal(reloaded.lastReauditDecision.decision, 'clean');
        } finally {
          fs.rmSync(stubRoot, { recursive: true, force: true });
        }
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    });

    test('decision=escalate pauses the workflow with the reason', async () => {
      const cwd = tmpDir();
      try {
        const stubRoot = tmpDir();
        const cli = writeStubAgentwright(stubRoot, '2.1.5');
        try {
          const wf = await setupCompletedWorkflow(cwd, { agentwrightCli: cli });
          const next = await handleReauditDecision(cwd, wf.workflowId, {
            decision: 'escalate',
            reason: 'cycles spinning without convergence',
          });
          assert.equal(next.kind, 'paused');
          const reloaded = loadWorkflow(cwd, wf.workflowId);
          assert.equal(reloaded.status, 'paused');
          // The reason is the structured contract — stored on the workflow
          // and consumed by callers programmatically. Prompt wording is doc.
          assert.equal(reloaded.escalationReason, 'cycles spinning without convergence');
        } finally {
          fs.rmSync(stubRoot, { recursive: true, force: true });
        }
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    });

    test('decision=replay appends a pipeline phase using stages as pipelineName', async () => {
      const cwd = tmpDir();
      try {
        const stubRoot = tmpDir();
        const cli = writeStubAgentwright(stubRoot, '2.1.5');
        try {
          const wf = await setupCompletedWorkflow(cwd, { agentwrightCli: cli });
          const next = await handleReauditDecision(cwd, wf.workflowId, {
            decision: 'replay',
            stages: ['correctness', 'behavior'],
          });
          // handleReauditDecision now signals "phase appended, please rebuild"
          // to its caller (advanceWorkflow). The rebuild happens at the
          // lifecycle layer — keeps reaudit-applier free of an import cycle.
          assert.equal(next.kind, 'replay-appended');
          assert.equal(next.workflowId, wf.workflowId);
          const reloaded = loadWorkflow(cwd, wf.workflowId);
          assert.equal(reloaded.reauditCycles, 1);
          assert.equal(reloaded.phases.length, 2);
          assert.equal(reloaded.phases[1].type, 'pipeline');
          // CRITICAL: stages must be on pipelineName positional, not via --stages flag.
          assert.equal(reloaded.phases[1].pipelineName, 'correctness,behavior');
          assert.equal(reloaded.phases[1].scope, '--diff');
        } finally {
          fs.rmSync(stubRoot, { recursive: true, force: true });
        }
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    });

    test('decision=replay-full uses default pipelineName, ignores stages', async () => {
      const cwd = tmpDir();
      try {
        const stubRoot = tmpDir();
        const cli = writeStubAgentwright(stubRoot, '2.1.5');
        try {
          const wf = await setupCompletedWorkflow(cwd, { agentwrightCli: cli });
          const next = await handleReauditDecision(cwd, wf.workflowId, {
            decision: 'replay-full',
            stages: ['correctness'], // should be ignored for replay-full
          });
          assert.equal(next.kind, 'replay-appended');
          const reloaded = loadWorkflow(cwd, wf.workflowId);
          assert.equal(reloaded.phases[1].pipelineName, 'default');
        } finally {
          fs.rmSync(stubRoot, { recursive: true, force: true });
        }
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    });

    test('decision=replay at maxCycles cap escalates to paused (does NOT silently complete)', async () => {
      const cwd = tmpDir();
      try {
        const stubRoot = tmpDir();
        const cli = writeStubAgentwright(stubRoot, '2.1.5');
        try {
          const wf = await setupCompletedWorkflow(cwd, {
            agentwrightCli: cli,
            reaudit: { maxCycles: 1, loopableStages: ['correctness'], decisionMode: 'leader' },
          });
          await mutateWorkflow(cwd, wf.workflowId, w => { w.reauditCycles = 1; });
          const next = await handleReauditDecision(cwd, wf.workflowId, {
            decision: 'replay', stages: ['correctness'], reason: 'still finding regressions',
          });
          // Suppressing the leader's replay must surface, not silently
          // complete. The behavioral contract: paused descriptor, the
          // suppressed decision preserved verbatim for the user, and the
          // cap-related state stored on the workflow. Prompt/respondInstruction
          // wording is documentation.
          assert.equal(next.kind, 'paused');
          assert.equal(next.suppressedDecision.decision, 'replay');
          assert.equal(next.suppressedDecision.reason, 'still finding regressions');
          assert.equal(next.reauditCycles, 1);
          assert.equal(next.maxCycles, 1);
          assert.equal(typeof next.prompt, 'string');
          assert.ok(next.prompt.length > 0);
          assert.equal(typeof next.respondInstruction, 'string');
          assert.ok(next.respondInstruction.length > 0);
          const reloaded = loadWorkflow(cwd, wf.workflowId);
          assert.equal(reloaded.status, 'paused');
          assert.equal(reloaded.phases.length, 1, 'no new phase appended at cap');
          // escalationReason is a stored workflow field (programmatic, not
          // LLM-only) — keep an assertion that the cap value lands in it so
          // a user querying workflow state can correlate.
          assert.ok(typeof reloaded.escalationReason === 'string'
            && reloaded.escalationReason.includes('maxCycles=1'));
        } finally {
          fs.rmSync(stubRoot, { recursive: true, force: true });
        }
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    });

    test('per-workflow reaudit override wins over the global config (decisionMode flip)', async () => {
      // Global config says deterministic with maxCycles=0 (no reaudit). The
      // workflow-level override flips to leader mode with maxCycles=2. The
      // override must drive the decision — otherwise no reaudit would fire.
      const cwd = tmpDir();
      try {
        const stubRoot = tmpDir();
        const cli = writeStubAgentwright(stubRoot, '2.1.5');
        try {
          fs.mkdirSync(path.join(cwd, '.claude'), { recursive: true });
          fs.writeFileSync(path.join(cwd, '.claude', 'forgewright.json'),
            JSON.stringify({
              agentwright: { path: cli },
              reaudit: { maxCycles: 0, decisionMode: 'deterministic', loopableStages: [] },
            }), 'utf8');
          const def = {
            phases: [{ name: 'audit', type: 'pipeline', pipelineName: 'default', scope: '--diff', loopable: true }],
          };
          // Mimic what index.js does: pass the merged reaudit alongside the definition.
          const wf = createWorkflow(cwd, {
            workflowName: 'feature',
            definition: def,
            reaudit: { maxCycles: 2, decisionMode: 'leader', loopableStages: ['correctness'] },
          });
          await mutateWorkflow(cwd, wf.workflowId, w => {
            w.phases[0].status = 'completed';
            w.phases[0].lastMcpResult = {
              totalAdded: 50, totalDeleted: 20, totalDiffLines: 70,
              totalLoc: 700, ratio: 0.1, changedFiles: ['src/x.js'],
            };
            w.currentPhaseIndex = 1;
          });
          const result = await maybeAppendReauditPhase(cwd, wf.workflowId);
          // Override drove leader mode → reaudit-decision descriptor returned.
          assert.equal(result.kind, 'reaudit-decision');
          assert.equal(result.maxCycles, 2);
          assert.deepEqual(result.loopableStages, ['correctness']);
        } finally {
          fs.rmSync(stubRoot, { recursive: true, force: true });
        }
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    });

    test('per-workflow reaudit is frozen — editing the global config mid-run does NOT change behavior', async () => {
      const cwd = tmpDir();
      try {
        const stubRoot = tmpDir();
        const cli = writeStubAgentwright(stubRoot, '2.1.5');
        try {
          fs.mkdirSync(path.join(cwd, '.claude'), { recursive: true });
          // Initial config: leader mode, maxCycles=2.
          fs.writeFileSync(path.join(cwd, '.claude', 'forgewright.json'),
            JSON.stringify({ agentwright: { path: cli }, reaudit: { maxCycles: 2, decisionMode: 'leader' } }),
            'utf8');
          const def = { phases: [{ name: 'audit', type: 'pipeline', pipelineName: 'default', scope: '--diff', loopable: true }] };
          const wf = createWorkflow(cwd, {
            workflowName: 'feature',
            definition: def,
            reaudit: { maxCycles: 2, decisionMode: 'leader', loopableStages: [] },
          });
          await mutateWorkflow(cwd, wf.workflowId, w => {
            w.phases[0].status = 'completed';
            w.phases[0].lastMcpResult = {
              totalAdded: 50, totalDeleted: 20, totalDiffLines: 70,
              totalLoc: 700, ratio: 0.1, changedFiles: ['src/x.js'],
            };
            w.currentPhaseIndex = 1;
          });
          // Edit the global config to disable reaudit entirely AFTER the workflow started.
          fs.writeFileSync(path.join(cwd, '.claude', 'forgewright.json'),
            JSON.stringify({ agentwright: { path: cli }, reaudit: { maxCycles: 0 } }),
            'utf8');
          // Reaudit should still fire — the workflow snapshot's frozen reaudit wins.
          const result = await maybeAppendReauditPhase(cwd, wf.workflowId);
          assert.equal(result.kind, 'reaudit-decision');
          assert.equal(result.maxCycles, 2);
        } finally {
          fs.rmSync(stubRoot, { recursive: true, force: true });
        }
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    });

    test('unknown decision returns error descriptor', async () => {
      const cwd = tmpDir();
      try {
        const stubRoot = tmpDir();
        const cli = writeStubAgentwright(stubRoot, '2.1.5');
        try {
          const wf = await setupCompletedWorkflow(cwd, { agentwrightCli: cli });
          const next = await handleReauditDecision(cwd, wf.workflowId, { decision: 'maybe' });
          assert.equal(next.kind, 'error');
          assert.equal(next.code, 'invalid-reaudit-decision');
        } finally {
          fs.rmSync(stubRoot, { recursive: true, force: true });
        }
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    });
  });

  describe('advanceWorkflow at end-of-phases with leader-mode decision', () => {
    test('routes mcpResult.decision through handleReauditDecision (no infinite loop)', async () => {
      const cwd = tmpDir();
      try {
        const stubRoot = tmpDir();
        const cli = writeStubAgentwright(stubRoot, '2.1.5');
        try {
          fs.mkdirSync(path.join(cwd, '.claude'), { recursive: true });
          fs.writeFileSync(path.join(cwd, '.claude', 'forgewright.json'),
            JSON.stringify({
              agentwright: { path: cli },
              reaudit: { maxCycles: 2, loopableStages: ['correctness'], decisionMode: 'leader' },
            }), 'utf8');
          const def = { phases: [{ name: 'audit', type: 'pipeline', pipelineName: 'default', scope: '--diff', loopable: true }] };
          const wf = createWorkflow(cwd, { workflowName: 'feature', definition: def });
          await mutateWorkflow(cwd, wf.workflowId, w => {
            w.phases[0].status = 'completed';
            w.phases[0].lastMcpResult = {
              totalAdded: 10, totalDeleted: 0, totalDiffLines: 10,
              totalLoc: 100, ratio: 0.1, changedFiles: ['src/x.js'],
            };
            w.currentPhaseIndex = 1;
          });
          // Advance with a leader decision while past end-of-phases.
          // Pre-fix this was a no-op (infinite reaudit-decision loop).
          const next = await advanceWorkflow(cwd, wf.workflowId, {
            result: 'completed',
            mcpResult: { decision: 'clean' },
          });
          assert.equal(next.kind, 'done');
        } finally {
          fs.rmSync(stubRoot, { recursive: true, force: true });
        }
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    });
  });
});
