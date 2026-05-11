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
  listWorkflows,
  pruneTerminalWorkflows,
  selectPruneCandidates,
  defaultPhaseIdempotence,
  makeWorkflowId,
  TERMINAL_STATUSES,
} = require('../../coordinator/workflow-ledger');

function tmpDir(prefix = 'fw-ledger-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const SAMPLE_DEFINITION = {
  phases: [
    { name: 'plan', type: 'skill', skillId: 'agentwright:feature-planning', produces: 'plan' },
    { name: 'plan-review', type: 'checkpoint', summary: 'review plan' },
    { name: 'tests', type: 'command', command: 'npm test' },
  ],
};

describe('workflow-ledger', () => {
  describe('makeWorkflowId', () => {
    test('embeds workflow name in ID', () => {
      const id = makeWorkflowId('feature');
      assert.match(id, /-feature-[0-9a-f]{8}$/);
    });

    test('rejects invalid workflow names', () => {
      assert.throws(() => makeWorkflowId('bad name'), /Invalid workflow name/);
    });
  });

  describe('defaultPhaseIdempotence', () => {
    test('checkpoints are idempotent by default', () => {
      assert.equal(defaultPhaseIdempotence('checkpoint'), true);
    });

    test('skill / pipeline / command default to NON-idempotent', () => {
      assert.equal(defaultPhaseIdempotence('skill'), false);
      assert.equal(defaultPhaseIdempotence('pipeline'), false);
      assert.equal(defaultPhaseIdempotence('command'), false);
    });
  });

  describe('createWorkflow', () => {
    test('persists workflow.json with normalized phases', () => {
      const cwd = tmpDir();
      try {
        const wf = createWorkflow(cwd, {
          workflowName: 'feature',
          args: 'add export',
          definition: SAMPLE_DEFINITION,
        });
        assert.equal(wf.workflowName, 'feature');
        assert.equal(wf.args, 'add export');
        assert.equal(wf.status, 'pending');
        assert.equal(wf.currentPhaseIndex, 0);
        assert.equal(wf.phases.length, 3);
        assert.equal(wf.phases[0].index, 0);
        assert.equal(wf.phases[0].status, 'pending');
        assert.equal(wf.phases[0].idempotent, false);     // skill default
        assert.equal(wf.phases[1].idempotent, true);      // checkpoint default
        assert.equal(wf.phases[2].idempotent, false);     // command default
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    });

    test('honors explicit idempotent flag in phases', () => {
      const cwd = tmpDir();
      try {
        const wf = createWorkflow(cwd, {
          workflowName: 'feature',
          definition: { phases: [
            { name: 'verify', type: 'skill', skillId: 'agentwright:verify-plan', idempotent: true },
            { name: 'pause', type: 'checkpoint', idempotent: false },
          ] },
        });
        assert.equal(wf.phases[0].idempotent, true);
        assert.equal(wf.phases[1].idempotent, false);
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    });

    // Empty-phase and missing-type rejections are the responsibility of
    // validateWorkflowDefinition (in workflow-config.test.js). createWorkflow
    // trusts pre-validated input — duplicating the checks here would let the
    // two layers drift.
  });

  describe('loadWorkflow', () => {
    test('throws on unknown workflow', () => {
      const cwd = tmpDir();
      try {
        assert.throws(() => loadWorkflow(cwd, '2026-01-01-foo-aaaaaaaa'), /Unknown workflow/);
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    });
  });

  describe('mutateWorkflow', () => {
    test('atomically applies callback mutation', async () => {
      const cwd = tmpDir();
      try {
        const wf = createWorkflow(cwd, {
          workflowName: 'feature',
          definition: SAMPLE_DEFINITION,
        });
        const mutated = await mutateWorkflow(cwd, wf.workflowId, w => {
          w.currentPhaseIndex = 1;
          w.status = 'running';
        });
        assert.equal(mutated.currentPhaseIndex, 1);
        assert.equal(mutated.status, 'running');
        assert.notEqual(mutated.updatedAt, wf.updatedAt);
        // Re-load from disk to confirm persistence
        const reloaded = loadWorkflow(cwd, wf.workflowId);
        assert.equal(reloaded.currentPhaseIndex, 1);
        assert.equal(reloaded.status, 'running');
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    });

    test('serializes concurrent mutations under proper-lockfile', async () => {
      const cwd = tmpDir();
      try {
        const wf = createWorkflow(cwd, {
          workflowName: 'feature',
          definition: SAMPLE_DEFINITION,
        });
        const N = 8;
        await Promise.all(Array.from({ length: N }, () =>
          mutateWorkflow(cwd, wf.workflowId, w => {
            w.reauditCycles = (w.reauditCycles || 0) + 1;
          })
        ));
        const finalWf = loadWorkflow(cwd, wf.workflowId);
        assert.equal(finalWf.reauditCycles, N);
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    });
  });

  describe('listWorkflows / pruneTerminalWorkflows', () => {
    test('lists all created workflows', () => {
      const cwd = tmpDir();
      try {
        const a = createWorkflow(cwd, { workflowName: 'feature', definition: SAMPLE_DEFINITION });
        const b = createWorkflow(cwd, { workflowName: 'feature', definition: SAMPLE_DEFINITION });
        const ids = listWorkflows(cwd).map(e => e.workflowId).sort();
        assert.deepEqual(ids, [a.workflowId, b.workflowId].sort());
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    });

    test('keepCompletedWorkflows is a floor — recent workflows beyond top-N are NOT pruned by count alone', async () => {
      const cwd = tmpDir();
      try {
        for (let i = 0; i < 3; i++) {
          const w = createWorkflow(cwd, { workflowName: 'feature', definition: SAMPLE_DEFINITION });
          await mutateWorkflow(cwd, w.workflowId, ww => { ww.status = 'completed'; });
        }
        const removed = pruneTerminalWorkflows(cwd, { keepCompletedWorkflows: 1, maxWorkflowAgeDays: 7 });
        assert.equal(removed.length, 0, 'recent workflows must not be pruned even if over the keep limit');
        assert.equal(listWorkflows(cwd).length, 3);
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    });

    test('prunes only when BOTH past age cutoff AND outside top-N', async () => {
      const cwd = tmpDir();
      try {
        const old1 = createWorkflow(cwd, { workflowName: 'feature', definition: SAMPLE_DEFINITION });
        const old2 = createWorkflow(cwd, { workflowName: 'feature', definition: SAMPLE_DEFINITION });
        const recent = createWorkflow(cwd, { workflowName: 'feature', definition: SAMPLE_DEFINITION });
        const oldIso = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
        for (const id of [old1.workflowId, old2.workflowId]) {
          const file = path.join(cwd, '.claude', 'forgewright', 'workflows', id, 'workflow.json');
          const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
          wf.status = 'completed';
          wf.updatedAt = oldIso;
          fs.writeFileSync(file, JSON.stringify(wf, null, 2), 'utf8');
        }
        await mutateWorkflow(cwd, recent.workflowId, ww => { ww.status = 'completed'; });
        const removed = pruneTerminalWorkflows(cwd, { keepCompletedWorkflows: 1, maxWorkflowAgeDays: 7 });
        // recent is the newest (top-1, kept by floor). old1 and old2 are both
        // outside the top-N AND past 7d → both pruned.
        assert.equal(removed.length, 2);
        const remaining = listWorkflows(cwd).map(e => e.workflowId);
        assert.deepEqual(remaining, [recent.workflowId]);
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    });

    test('surfaces removePath failures to stderr without throwing (best-effort retention)', async () => {
      const cwd = tmpDir();
      const origRmSync = fs.rmSync;
      const origWrite = process.stderr.write.bind(process.stderr);
      const captured = [];
      let targetWorkflowId;
      try {
        const old = createWorkflow(cwd, { workflowName: 'feature', definition: SAMPLE_DEFINITION });
        targetWorkflowId = old.workflowId;
        const oldIso = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
        const file = path.join(cwd, '.claude', 'forgewright', 'workflows', old.workflowId, 'workflow.json');
        const w = JSON.parse(fs.readFileSync(file, 'utf8'));
        w.status = 'completed';
        w.updatedAt = oldIso;
        fs.writeFileSync(file, JSON.stringify(w, null, 2), 'utf8');

        // Intercept only rmSync calls that target this workflow's dir so the
        // surrounding fixture teardown (which also uses rmSync) still works.
        fs.rmSync = function (target, ...rest) {
          if (typeof target === 'string' && target.includes(old.workflowId)) {
            const err = new Error('simulated EBUSY');
            err.code = 'EBUSY';
            throw err;
          }
          return origRmSync.call(this, target, ...rest);
        };
        process.stderr.write = (msg) => { captured.push(String(msg)); return true; };

        let removed;
        assert.doesNotThrow(() => {
          removed = pruneTerminalWorkflows(cwd, { keepCompletedWorkflows: 0, maxWorkflowAgeDays: 7 });
        });
        // The workflow is NOT in the removed list because removePath threw.
        assert.deepEqual(removed, []);
        // Operator must see the failure so the retention policy isn't degraded silently.
        const joined = captured.join('');
        assert.match(joined, /failed to prune terminal workflow/);
        // Direct substring check — workflowId is a literal value, not a
        // pattern, so a RegExp wrapper would silently change semantics if
        // the ID format ever introduces regex metacharacters.
        assert.ok(joined.includes(old.workflowId));
        assert.match(joined, /EBUSY/);
      } finally {
        fs.rmSync = origRmSync;
        process.stderr.write = origWrite;
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    });

    test('keeps non-terminal workflows even past age cutoff', async () => {
      const cwd = tmpDir();
      try {
        const a = createWorkflow(cwd, { workflowName: 'feature', definition: SAMPLE_DEFINITION });
        const b = createWorkflow(cwd, { workflowName: 'feature', definition: SAMPLE_DEFINITION });
        // Make `b` terminal AND old; `a` stays non-terminal.
        const oldIso = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
        const bFile = path.join(cwd, '.claude', 'forgewright', 'workflows', b.workflowId, 'workflow.json');
        const bWf = JSON.parse(fs.readFileSync(bFile, 'utf8'));
        bWf.status = 'completed';
        bWf.updatedAt = oldIso;
        fs.writeFileSync(bFile, JSON.stringify(bWf, null, 2), 'utf8');
        const removed = pruneTerminalWorkflows(cwd, { keepCompletedWorkflows: 0, maxWorkflowAgeDays: 7 });
        assert.deepEqual(removed, [b.workflowId]);
        const remaining = listWorkflows(cwd).map(e => e.workflowId);
        assert.deepEqual(remaining, [a.workflowId]);
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    });
  });

  describe('selectPruneCandidates (pure)', () => {
    function entry(id, daysAgo) {
      return {
        workflowId: id,
        workflow: {
          status: 'completed',
          updatedAt: new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString(),
        },
      };
    }

    test('keeps the N newest regardless of age', () => {
      const now = Date.now();
      const terminal = [
        entry('a', 1), entry('b', 5), entry('c', 30), entry('d', 60),
      ];
      const sevenDays = 7 * 24 * 60 * 60 * 1000;
      const candidates = selectPruneCandidates(terminal, 2, sevenDays, now);
      // The newest two (a, b) are floored; c and d are both >7d → both pruned.
      assert.deepEqual(candidates.map(e => e.workflowId), ['c', 'd']);
    });

    test('returns nothing when nothing is past the age cutoff', () => {
      const now = Date.now();
      const terminal = [entry('a', 1), entry('b', 2), entry('c', 3)];
      const sevenDays = 7 * 24 * 60 * 60 * 1000;
      assert.deepEqual(selectPruneCandidates(terminal, 0, sevenDays, now), []);
    });

    test('maxAgeMs=0 disables the age cutoff (no pruning regardless of keep count)', () => {
      const now = Date.now();
      const terminal = [entry('a', 100), entry('b', 200)];
      assert.deepEqual(selectPruneCandidates(terminal, 0, 0, now), []);
    });

    test('does not mutate the input array', () => {
      const now = Date.now();
      const terminal = [entry('a', 1), entry('b', 30)];
      const before = terminal.map(e => e.workflowId);
      selectPruneCandidates(terminal, 1, 7 * 24 * 60 * 60 * 1000, now);
      const after = terminal.map(e => e.workflowId);
      assert.deepEqual(after, before, 'sort must not mutate the caller-owned list');
    });
  });

  test('TERMINAL_STATUSES contains expected states', () => {
    assert.ok(TERMINAL_STATUSES.has('completed'));
    assert.ok(TERMINAL_STATUSES.has('cancelled'));
    assert.ok(TERMINAL_STATUSES.has('failed'));
    assert.ok(!TERMINAL_STATUSES.has('running'));
  });

  describe('requireLockfile (missing-dependency error)', () => {
    test('mutateWorkflow throws the install-instruction error when proper-lockfile fails to load', async () => {
      // Stage a workflow on disk via the real (loaded) ledger first.
      const cwd = tmpDir();
      const wf = createWorkflow(cwd, {
        workflowName: 'feature',
        definition: SAMPLE_DEFINITION,
      });

      // Now load a *fresh* workflow-ledger with proper-lockfile intercepted to
      // simulate a missing dependency. The freshly-loaded copy keeps its own
      // module-private `lockfile = null` binding and goes through requireLockfile.
      const Module = require('node:module');
      const ledgerPath = require.resolve('../../coordinator/workflow-ledger');
      const origLoad = Module._load;
      delete require.cache[ledgerPath];
      Module._load = function (request, ...rest) {
        if (request === 'proper-lockfile') {
          const err = new Error('Cannot find module proper-lockfile');
          err.code = 'MODULE_NOT_FOUND';
          throw err;
        }
        return origLoad.call(this, request, ...rest);
      };

      try {
        const fresh = require('../../coordinator/workflow-ledger');
        await assert.rejects(
          fresh.mutateWorkflow(cwd, wf.workflowId, w => { w.status = 'running'; }),
          err => /forgewright requires the "proper-lockfile" npm package/.test(err.message)
            && /npm install/.test(err.message),
        );
      } finally {
        Module._load = origLoad;
        delete require.cache[ledgerPath];
        // Force the next test to re-load the real (working) ledger.
        require('../../coordinator/workflow-ledger');
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    });
  });
});
