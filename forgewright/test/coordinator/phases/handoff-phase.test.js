'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const handoffPhase = require('../../../coordinator/phases/handoff-phase');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fw-handoff-'));
}

const SAMPLE_WORKFLOW = (artifacts) => ({
  workflowId: 'wf-1',
  workflowName: 'feature',
  artifacts: artifacts || {},
});

describe('handoff-phase', () => {
  test('TYPE constant exposed', () => {
    assert.equal(handoffPhase.TYPE, 'handoff');
  });

  describe('buildDescriptor', () => {
    test('directive-only handoff returns the expected descriptor shape', () => {
      const phase = {
        name: 'implement',
        index: 3,
        type: 'handoff',
        directive: 'implement plan',
      };
      const d = handoffPhase.buildDescriptor(phase, SAMPLE_WORKFLOW(), { cwd: tmpDir() });
      assert.equal(d.kind, 'phase');
      assert.equal(d.type, 'handoff');
      assert.equal(d.directive, 'implement plan');
      assert.equal(d.consumes, null);
      // taskRefBase keys peer task_ref strings off the phase name (stable across
      // re-orderings; clearer in logs than the array index).
      assert.equal(d.taskRefBase, 'wf-1:phase-implement');
      assert.equal(d.phaseName, 'implement');
      assert.equal(d.presetItemCount, null);
    });

    test('consumes-only handoff (no directive) is allowed when the artifact exists', () => {
      const cwd = tmpDir();
      try {
        const wf = SAMPLE_WORKFLOW({ tasks: 'artifacts/tasks.json' });
        const wfDir = path.join(cwd, '.claude', 'forgewright', 'workflows', wf.workflowId, 'artifacts');
        fs.mkdirSync(wfDir, { recursive: true });
        fs.writeFileSync(path.join(wfDir, 'tasks.json'), JSON.stringify([]), 'utf8');
        const d = handoffPhase.buildDescriptor(
          { name: 'dispatch', index: 7, type: 'handoff', consumes: 'tasks' },
          wf,
          { cwd }
        );
        assert.equal(d.kind, 'phase');
        assert.equal(d.consumes, 'tasks');
        assert.equal(d.directive, null);
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    });

    test('throws when consumes is set but no upstream phase registered the artifact', () => {
      assert.throws(
        () => handoffPhase.buildDescriptor(
          { name: 'fallback-handoff', index: 3, type: 'handoff', directive: 'fallback', consumes: 'plan' },
          SAMPLE_WORKFLOW(),
          { cwd: tmpDir() }
        ),
        /artifact "plan" was never recorded/
      );
    });

    test('throws when consumes points to a path the producing phase wrote but the file is missing', () => {
      const cwd = tmpDir();
      try {
        const wf = SAMPLE_WORKFLOW({ tasks: 'artifacts/tasks.json' });
        // Path is registered but file was never written.
        assert.throws(
          () => handoffPhase.buildDescriptor(
            { name: 'dispatch', index: 7, type: 'handoff', consumes: 'tasks' },
            wf,
            { cwd }
          ),
          /the file is missing on disk/
        );
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    });

    test('rejects when both directive and consumes are missing', () => {
      assert.throws(
        () => handoffPhase.buildDescriptor({ name: 'h', index: 0, type: 'handoff' }, SAMPLE_WORKFLOW(), { cwd: tmpDir() }),
        /requires "directive" or "consumes"/
      );
    });

    test('reads JSON consumed-items array to count presetItemCount', () => {
      const cwd = tmpDir();
      try {
        const wf = SAMPLE_WORKFLOW({ tasks: 'artifacts/tasks.json' });
        const wfDir = path.join(cwd, '.claude', 'forgewright', 'workflows', wf.workflowId, 'artifacts');
        fs.mkdirSync(wfDir, { recursive: true });
        fs.writeFileSync(path.join(wfDir, 'tasks.json'),
          JSON.stringify([{ key: 'a' }, { key: 'b' }, { key: 'c' }]), 'utf8');
        const d = handoffPhase.buildDescriptor(
          { name: 'dispatch', index: 1, type: 'handoff', consumes: 'tasks' },
          wf,
          { cwd }
        );
        assert.equal(d.presetItemCount, 3);
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    });

    test('presetItemCount is null when consumes is a markdown plan (leader decomposes)', () => {
      const cwd = tmpDir();
      try {
        const wf = SAMPLE_WORKFLOW({ plan: 'artifacts/plan.md' });
        const wfDir = path.join(cwd, '.claude', 'forgewright', 'workflows', wf.workflowId, 'artifacts');
        fs.mkdirSync(wfDir, { recursive: true });
        fs.writeFileSync(path.join(wfDir, 'plan.md'), '# Plan\n', 'utf8');
        const d = handoffPhase.buildDescriptor(
          { name: 'do-it', index: 1, type: 'handoff', directive: 'do it', consumes: 'plan' },
          wf,
          { cwd }
        );
        assert.equal(d.presetItemCount, null);
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    });
  });

  describe('buildDescriptor — array-form consumes', () => {
    test('accepts an array of stems and presetItemCount stays null (leader decomposes)', () => {
      // Multi-consume on handoff: when a phase declares consumes as an array,
      // the leader is presented every upstream artifact and decomposes the
      // directive itself. There is no single "items list" to preset because
      // it's no longer obvious which artifact would supply items.
      const cwd = tmpDir();
      try {
        const wf = SAMPLE_WORKFLOW({
          research: 'artifacts/research.md',
          'peer-opinions': 'artifacts/peer-opinions.md',
        });
        const wfDir = path.join(cwd, '.claude', 'forgewright', 'workflows', wf.workflowId, 'artifacts');
        fs.mkdirSync(wfDir, { recursive: true });
        fs.writeFileSync(path.join(wfDir, 'research.md'), '# Research', 'utf8');
        fs.writeFileSync(path.join(wfDir, 'peer-opinions.md'), '# Opinions', 'utf8');
        const d = handoffPhase.buildDescriptor(
          {
            name: 'multi-consume',
            index: 4,
            type: 'handoff',
            directive: 'inform the dispatch with both upstream artifacts',
            consumes: ['research', 'peer-opinions'],
          },
          wf,
          { cwd },
        );
        assert.deepEqual(d.consumes, ['research', 'peer-opinions']);
        assert.equal(d.presetItemCount, null);
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    });

    test('throws when one of the array entries names an unregistered artifact', () => {
      // Same upstream-contract-break enforcement the single-string path
      // already has — every named stem must have an artifact registered AND
      // present on disk. Surface loudly so the leader doesn't dispatch with
      // a phantom upstream.
      const cwd = tmpDir();
      try {
        const wf = SAMPLE_WORKFLOW({ research: 'artifacts/research.md' });
        const wfDir = path.join(cwd, '.claude', 'forgewright', 'workflows', wf.workflowId, 'artifacts');
        fs.mkdirSync(wfDir, { recursive: true });
        fs.writeFileSync(path.join(wfDir, 'research.md'), '# Research', 'utf8');
        // "peer-opinions" is NOT in artifacts — should throw.
        assert.throws(
          () => handoffPhase.buildDescriptor(
            { name: 'multi-consume', index: 4, type: 'handoff', directive: 'd', consumes: ['research', 'peer-opinions'] },
            wf,
            { cwd },
          ),
          /artifact "peer-opinions" was never recorded/,
        );
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    });

    test('throws when one array entry is registered but the file is missing on disk', () => {
      const cwd = tmpDir();
      try {
        const wf = SAMPLE_WORKFLOW({
          research: 'artifacts/research.md',
          'peer-opinions': 'artifacts/peer-opinions.md',
        });
        const wfDir = path.join(cwd, '.claude', 'forgewright', 'workflows', wf.workflowId, 'artifacts');
        fs.mkdirSync(wfDir, { recursive: true });
        fs.writeFileSync(path.join(wfDir, 'research.md'), '# Research', 'utf8');
        // peer-opinions.md is missing on disk.
        assert.throws(
          () => handoffPhase.buildDescriptor(
            { name: 'multi-consume', index: 4, type: 'handoff', directive: 'd', consumes: ['research', 'peer-opinions'] },
            wf,
            { cwd },
          ),
          /the file is missing on disk/,
        );
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    });

    test('directive-only handoff with empty consumes array is rejected', () => {
      // [] should not satisfy the "directive or consumes" requirement — empty
      // means "no consumes" and we'd want the workflow author to either drop
      // the field or list real stems.
      assert.throws(
        () => handoffPhase.buildDescriptor(
          { name: 'h', index: 0, type: 'handoff', consumes: [] },
          SAMPLE_WORKFLOW(),
          { cwd: tmpDir() }
        ),
        /requires "directive" or "consumes"/,
      );
    });
  });

  describe('buildInstruction — challenge protocol', () => {
    // The leader instruction must carry both sides of the peer-↔-leader
    // challenge contract. Peers learn how to formally request a challenge
    // via [CHALLENGE-REQUEST]; the leader learns to resolve via
    // /agentwright:challenge and reply with [CHALLENGE-VERDICT]. Without
    // these markers, peer doubt either turns into silent compliance or
    // unbounded back-and-forth.
    const baseWorkflow = SAMPLE_WORKFLOW();
    const phase = { name: 'implement', index: 3, type: 'handoff', directive: 'implement plan' };
    const instruction = handoffPhase.buildInstruction(phase, baseWorkflow, null);

    test('peer-side rules tell peers to send [CHALLENGE-REQUEST] when they disagree', () => {
      assert.match(instruction, /\[CHALLENGE-REQUEST\]/,
        'peer-side rules must define the [CHALLENGE-REQUEST] marker');
      assert.match(instruction, /formally request a challenge/i,
        'peer-side rules must direct peers to formally request a challenge instead of arguing or capitulating');
    });

    test('leader-side rules tell the leader to invoke /agentwright:challenge and reply with [CHALLENGE-VERDICT]', () => {
      assert.match(instruction, /\/agentwright:challenge/,
        'leader-side rules must point at the /agentwright:challenge skill');
      assert.match(instruction, /\[CHALLENGE-VERDICT\]/,
        'leader-side rules must define the [CHALLENGE-VERDICT] reply marker');
      assert.match(instruction, /verdict is final/i,
        'peer-side rules must declare the leader verdict final so disputes do not re-litigate');
    });

    test('leader-side rules cover both peer-initiated and leader-initiated challenges', () => {
      assert.match(instruction, /When YOU doubt a peer/i,
        'leader-side rules must cover the leader-initiated path (leader challenges peer claim)');
      assert.match(instruction, /Repeated peer mistakes/i,
        'leader-side rules must tell the leader to track and call out repeated peer mistakes');
    });
  });

  describe('validateResult', () => {
    test('accepts a batch with peer + self tasks', () => {
      const phase = { index: 3, directive: 'do it' };
      const result = {
        mcpResult: {
          tasks: [
            { key: 'task-1', by: 'peer:bob-42', status: 'completed', ackId: 'ack-1' },
            { key: 'task-2', by: 'self', status: 'completed' },
          ],
        },
      };
      assert.doesNotThrow(() => handoffPhase.validateResult(result, phase));
    });

    test('rejects when mcpResult missing', () => {
      assert.throws(
        () => handoffPhase.validateResult({}, { index: 3 }),
        /requires --mcp-result/
      );
    });

    test('rejects malformed batch (bad by field)', () => {
      assert.throws(() => handoffPhase.validateResult({
        mcpResult: { tasks: [{ key: 'a', by: 'unknown', status: 'completed' }] },
      }, { index: 3 }), /by must be "self" or "peer:/);
    });

    test('rejects non-array tasks', () => {
      assert.throws(() => handoffPhase.validateResult({
        mcpResult: { tasks: 'oops' },
      }, { index: 3 }), /tasks must be an array/);
    });
  });

  describe('recordBatch', () => {
    test('appends one JSONL entry per task with phase-name-keyed taskRef', () => {
      const cwd = tmpDir();
      try {
        const wf = { workflowId: 'wf-rb-1', workflowName: 'feature' };
        const phase = { name: 'implement', index: 4 };
        const batch = {
          tasks: [
            { key: 't1', by: 'peer:bob-42', status: 'completed', ackId: 'ack-1' },
            { key: 't2', by: 'self', status: 'completed' },
          ],
        };
        handoffPhase.recordBatch(cwd, wf, phase, batch);
        const file = path.join(cwd, '.claude', 'forgewright', 'workflows', wf.workflowId, 'peer-handoffs.jsonl');
        const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
        assert.equal(lines.length, 2);
        const e1 = JSON.parse(lines[0]);
        const e2 = JSON.parse(lines[1]);
        assert.equal(e1.taskKey, 't1');
        assert.equal(e1.by, 'peer:bob-42');
        assert.equal(e1.taskRef, 'wf-rb-1:phase-implement:t1');
        assert.equal(e1.phaseName, 'implement');
        assert.equal(e2.taskKey, 't2');
        assert.equal(e2.by, 'self');
        assert.equal(e2.taskRef, 'wf-rb-1:phase-implement:t2');
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    });

    test('returns silently on missing or malformed batch (no throw)', () => {
      const cwd = tmpDir();
      try {
        const wf = { workflowId: 'wf-rb-2', workflowName: 'feature' };
        const phase = { name: 'implement', index: 4 };
        // Each of these triggers an early-return path before the try{}.
        assert.doesNotThrow(() => handoffPhase.recordBatch(cwd, wf, phase, undefined));
        assert.doesNotThrow(() => handoffPhase.recordBatch(cwd, wf, phase, null));
        assert.doesNotThrow(() => handoffPhase.recordBatch(cwd, wf, phase, {}));
        assert.doesNotThrow(() => handoffPhase.recordBatch(cwd, wf, phase, { tasks: 'oops' }));
        // None of the above should have created the workflow dir, since they all bail out.
        const wfDir = path.join(cwd, '.claude', 'forgewright', 'workflows', wf.workflowId);
        assert.equal(fs.existsSync(wfDir), false);
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    });

    test('surfaces fs errors to stderr without throwing (best-effort log contract)', () => {
      // Simulate a low-level mkdirSync/append failure by pre-creating the
      // target parent as a regular file, so mkdirSync(recursive) throws
      // ENOTDIR / EEXIST. The catch must NOT rethrow, but must emit a stderr
      // line so the operator can see that audit logging is degraded.
      const cwd = tmpDir();
      const origWrite = process.stderr.write.bind(process.stderr);
      const captured = [];
      try {
        process.stderr.write = (msg) => { captured.push(String(msg)); return true; };
        const wf = { workflowId: 'wf-rb-3', workflowName: 'feature' };
        const phase = { name: 'implement', index: 4 };
        const blocker = path.join(cwd, '.claude', 'forgewright', 'workflows', wf.workflowId);
        fs.mkdirSync(path.dirname(blocker), { recursive: true });
        fs.writeFileSync(blocker, 'i am a file, not a dir', 'utf8');
        const batch = { tasks: [{ key: 't1', by: 'self', status: 'completed' }] };
        assert.doesNotThrow(() => handoffPhase.recordBatch(cwd, wf, phase, batch));
        // The blocker file is untouched.
        assert.equal(fs.statSync(blocker).isFile(), true);
        // Operator must see that this phase's audit log is degraded.
        const joined = captured.join('');
        assert.match(joined, /failed to record peer-handoff audit/);
        assert.match(joined, /implement/);
        assert.match(joined, /\b4\b/);
      } finally {
        process.stderr.write = origWrite;
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    });
  });

  describe('readConsumedItems via buildDescriptor (JSON shape variants)', () => {
    test('JSON with .items array yields presetItemCount equal to items.length', () => {
      const cwd = tmpDir();
      try {
        const wf = SAMPLE_WORKFLOW({ batches: 'artifacts/batches.json' });
        const artDir = path.join(cwd, '.claude', 'forgewright', 'workflows', wf.workflowId, 'artifacts');
        fs.mkdirSync(artDir, { recursive: true });
        fs.writeFileSync(path.join(artDir, 'batches.json'),
          JSON.stringify({ items: [{ key: 'i1' }, { key: 'i2' }, { key: 'i3' }, { key: 'i4' }] }), 'utf8');
        const d = handoffPhase.buildDescriptor(
          { name: 'batch-dispatch', index: 2, type: 'handoff', consumes: 'batches' },
          wf,
          { cwd },
        );
        assert.equal(d.presetItemCount, 4);
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    });

    test('consumes with extension resolves to the registry stem (so "tasks.json" finds artifacts.tasks)', () => {
      const cwd = tmpDir();
      try {
        const wf = SAMPLE_WORKFLOW({ tasks: 'artifacts/tasks.json' });
        const artDir = path.join(cwd, '.claude', 'forgewright', 'workflows', wf.workflowId, 'artifacts');
        fs.mkdirSync(artDir, { recursive: true });
        fs.writeFileSync(path.join(artDir, 'tasks.json'), JSON.stringify([{ key: 'a' }, { key: 'b' }]), 'utf8');
        const d = handoffPhase.buildDescriptor(
          // Note: consumes uses the file form, registry uses the stem form.
          { name: 'tasks-dispatch', index: 2, type: 'handoff', consumes: 'tasks.json' },
          wf,
          { cwd },
        );
        assert.equal(d.presetItemCount, 2);
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    });

    test('JSON object that is not an items array yields presetItemCount=0', () => {
      const cwd = tmpDir();
      try {
        const wf = SAMPLE_WORKFLOW({ batches: 'artifacts/batches.json' });
        const artDir = path.join(cwd, '.claude', 'forgewright', 'workflows', wf.workflowId, 'artifacts');
        fs.mkdirSync(artDir, { recursive: true });
        fs.writeFileSync(path.join(artDir, 'batches.json'),
          JSON.stringify({ unrelated: 'shape' }), 'utf8');
        const d = handoffPhase.buildDescriptor(
          { name: 'batch-dispatch-2', index: 6, type: 'handoff', consumes: 'batches' },
          wf,
          { cwd },
        );
        assert.equal(d.presetItemCount, 0);
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    });
  });
});
