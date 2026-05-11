'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { tmpDir, runCli, setupRepo } = require('../_helpers/integration-cli');

const SIMPLE_DEFINITION = {
  phases: [
    { name: 'plan', type: 'skill', skillId: 'agentwright:feature-planning', produces: 'plan' },
    { name: 'review', type: 'checkpoint', summary: 'review' },
    { name: 'verify', type: 'skill', skillId: 'agentwright:verify-plan', consumes: 'plan', idempotent: true },
  ],
};

describe('CLI dispatch', () => {
  test('--help prints usage and exits 0', () => {
    const cwd = tmpDir();
    try {
      const proc = runCli(cwd, ['--help']);
      assert.equal(proc.code, 0);
      assert.match(proc.stdout, /Usage:/);
      assert.match(proc.stdout, /workflow-start/);
      assert.match(proc.stdout, /workflow-advance/);
      assert.match(proc.stdout, /workflow-stop/);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('-h alias prints usage and exits 0', () => {
    const cwd = tmpDir();
    try {
      const proc = runCli(cwd, ['-h']);
      assert.equal(proc.code, 0);
      assert.match(proc.stdout, /Usage:/);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('no args prints usage and exits 0', () => {
    const cwd = tmpDir();
    try {
      const proc = runCli(cwd, []);
      assert.equal(proc.code, 0);
      assert.match(proc.stdout, /Usage:/);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('unknown command exits non-zero with helpful stderr', () => {
    const cwd = tmpDir();
    try {
      const proc = runCli(cwd, ['workflow-banana']);
      assert.notEqual(proc.code, 0);
      assert.match(proc.stderr, /Unknown command: workflow-banana/);
      assert.match(proc.stderr, /--help/);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('workflow-advance --skip combined with --result is rejected', () => {
    const env = setupRepo(SIMPLE_DEFINITION);
    try {
      const start = runCli(env.cwd, ['workflow-start', 'simple']);
      assert.equal(start.code, 0, start.stderr);
      const wf = JSON.parse(start.stdout).workflowId;
      const proc = runCli(env.cwd,
        ['workflow-advance', '--workflow', wf, '--skip', '--result', 'completed']);
      assert.notEqual(proc.code, 0);
      assert.match(proc.stderr, /--skip is mutually exclusive/);
    } finally {
      env.cleanup();
    }
  });

  test('workflow-advance with neither --skip nor --result is rejected', () => {
    const env = setupRepo(SIMPLE_DEFINITION);
    try {
      const start = runCli(env.cwd, ['workflow-start', 'simple']);
      assert.equal(start.code, 0, start.stderr);
      const wf = JSON.parse(start.stdout).workflowId;
      const proc = runCli(env.cwd, ['workflow-advance', '--workflow', wf]);
      assert.notEqual(proc.code, 0);
      assert.match(proc.stderr, /requires --result.*or --skip/);
    } finally {
      env.cleanup();
    }
  });

  test('workflow-advance --mcp-result with malformed JSON is rejected', () => {
    const env = setupRepo(SIMPLE_DEFINITION);
    try {
      const start = runCli(env.cwd, ['workflow-start', 'simple']);
      assert.equal(start.code, 0, start.stderr);
      const wf = JSON.parse(start.stdout).workflowId;
      const proc = runCli(env.cwd, [
        'workflow-advance', '--workflow', wf, '--result', 'completed',
        '--artifact-path', 'artifacts/plan.md',
        '--mcp-result', '{not valid',
      ]);
      assert.notEqual(proc.code, 0);
      assert.match(proc.stderr, /--mcp-result must be valid JSON/);
      assert.match(proc.stderr, /\{not valid/);
    } finally {
      env.cleanup();
    }
  });

  test('workflow-stop on already-cancelled workflow is a no-op (early return)', () => {
    const env = setupRepo(SIMPLE_DEFINITION);
    try {
      const start = runCli(env.cwd, ['workflow-start', 'simple']);
      const wf = JSON.parse(start.stdout).workflowId;
      const first = runCli(env.cwd, ['workflow-stop', '--workflow', wf]);
      assert.equal(first.code, 0, first.stderr);
      assert.match(first.stdout, /"status": "cancelled"/);
      // First stop transitioned the workflow → the skill should broadcast.
      const firstJson = JSON.parse(first.stdout);
      assert.equal(firstJson.broadcastNeeded, true);
      const second = runCli(env.cwd, ['workflow-stop', '--workflow', wf]);
      assert.equal(second.code, 0, second.stderr);
      const json = JSON.parse(second.stdout);
      // Already-terminal early-return path emits the "already terminal"
      // message and signals the skill NOT to broadcast (no in-flight peers).
      assert.equal(json.status, 'cancelled');
      assert.match(json.message, /already terminal/i);
      assert.equal(json.broadcastNeeded, false);
    } finally {
      env.cleanup();
    }
  });

  test('workflow-stop on a failed workflow early-returns (forgewright no longer tracks agentwright snapshots)', () => {
    const env = setupRepo(SIMPLE_DEFINITION);
    try {
      const start = runCli(env.cwd, ['workflow-start', 'simple']);
      const wf = JSON.parse(start.stdout).workflowId;
      const stateFile = path.join(env.cwd, '.claude', 'forgewright', 'workflows', wf, 'workflow.json');
      const w = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      w.status = 'failed';
      w.failedAt = new Date().toISOString();
      fs.writeFileSync(stateFile, JSON.stringify(w, null, 2), 'utf8');
      const proc = runCli(env.cwd, ['workflow-stop', '--workflow', wf]);
      assert.equal(proc.code, 0, proc.stderr);
      const json = JSON.parse(proc.stdout);
      // Pipeline phases are atomic from forgewright's POV: the LLM driving
      // /agentwright:audit-run cleans the snapshot itself, and any leftovers
      // get swept by agentwright's orphan-snapshot cleanup. workflow-stop
      // therefore early-returns on any terminal state, including failed.
      assert.equal(json.status, 'failed');
      assert.match(json.message, /already terminal/i);
      // Terminal → no peers to broadcast to.
      assert.equal(json.broadcastNeeded, false);
    } finally {
      env.cleanup();
    }
  });

  describe('workflow-resume --bump-reaudit-cycles', () => {
    function setupRepoWithReaudit() {
      const env = setupRepo(SIMPLE_DEFINITION);
      const start = runCli(env.cwd, ['workflow-start', 'simple']);
      const wf = JSON.parse(start.stdout).workflowId;
      // Inject a reaudit snapshot so we have something to bump. Simulate a
      // workflow that ran a pipeline and hit the cap (paused state, cycles
      // already at cap).
      const wfFile = path.join(env.cwd, '.claude', 'forgewright', 'workflows', wf, 'workflow.json');
      const state = JSON.parse(fs.readFileSync(wfFile, 'utf8'));
      state.reaudit = { maxCycles: 1, minDeltaPercent: 5, minDeltaLines: 0, decisionMode: 'leader', loopableStages: ['correctness'] };
      state.reauditCycles = 1;
      fs.writeFileSync(wfFile, JSON.stringify(state, null, 2), 'utf8');
      return { env, wf, wfFile };
    }

    test('bumps maxCycles atomically before resuming', () => {
      const { env, wf, wfFile } = setupRepoWithReaudit();
      try {
        const proc = runCli(env.cwd, ['workflow-resume', '--workflow', wf, '--bump-reaudit-cycles', '2']);
        assert.equal(proc.code, 0, proc.stderr);
        const after = JSON.parse(fs.readFileSync(wfFile, 'utf8'));
        assert.equal(after.reaudit.maxCycles, 3, 'maxCycles must be bumped by N before resume runs');
      } finally {
        env.cleanup();
      }
    });

    test('rejects non-integer --bump-reaudit-cycles', () => {
      const { env, wf } = setupRepoWithReaudit();
      try {
        const proc = runCli(env.cwd, ['workflow-resume', '--workflow', wf, '--bump-reaudit-cycles', 'abc']);
        assert.notEqual(proc.code, 0);
        assert.match(proc.stderr, /positive integer/);
      } finally {
        env.cleanup();
      }
    });

    test('rejects zero / negative --bump-reaudit-cycles', () => {
      const { env, wf } = setupRepoWithReaudit();
      try {
        const proc = runCli(env.cwd, ['workflow-resume', '--workflow', wf, '--bump-reaudit-cycles', '0']);
        assert.notEqual(proc.code, 0);
        assert.match(proc.stderr, /positive integer/);
      } finally {
        env.cleanup();
      }
    });

    test('errors when the workflow has no frozen reaudit config', () => {
      const env = setupRepo(SIMPLE_DEFINITION);
      try {
        const start = runCli(env.cwd, ['workflow-start', 'simple']);
        const wf = JSON.parse(start.stdout).workflowId;
        const wfFile = path.join(env.cwd, '.claude', 'forgewright', 'workflows', wf, 'workflow.json');
        const state = JSON.parse(fs.readFileSync(wfFile, 'utf8'));
        state.reaudit = null;
        fs.writeFileSync(wfFile, JSON.stringify(state, null, 2), 'utf8');
        const proc = runCli(env.cwd, ['workflow-resume', '--workflow', wf, '--bump-reaudit-cycles', '1']);
        assert.notEqual(proc.code, 0);
        assert.match(proc.stderr, /no frozen reaudit config/);
      } finally {
        env.cleanup();
      }
    });

    test('without the flag, resume does not touch reaudit', () => {
      const { env, wf, wfFile } = setupRepoWithReaudit();
      try {
        const before = JSON.parse(fs.readFileSync(wfFile, 'utf8'));
        const proc = runCli(env.cwd, ['workflow-resume', '--workflow', wf]);
        assert.equal(proc.code, 0, proc.stderr);
        const after = JSON.parse(fs.readFileSync(wfFile, 'utf8'));
        assert.equal(after.reaudit.maxCycles, before.reaudit.maxCycles, 'maxCycles must not change when flag is absent');
      } finally {
        env.cleanup();
      }
    });
  });
});
