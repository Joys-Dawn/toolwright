'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { tmpDir, runCli, setupRepo } = require('../_helpers/integration-cli');

const SIMPLE_DEFINITION = {
  phases: [
    { name: 'plan', type: 'skill', skillId: 'agentwright:feature-planning', produces: 'plan' },
    { name: 'plan-review', type: 'checkpoint', summary: 'review the plan' },
    { name: 'verify', type: 'skill', skillId: 'agentwright:verify-plan', consumes: 'plan', idempotent: true },
    { name: 'tests', type: 'command', command: 'echo done' },
  ],
};

describe('integration: simple workflow end-to-end', () => {
  test('workflow-start → advance through skill → checkpoint → resume → skill → command → done', () => {
    const env = setupRepo(SIMPLE_DEFINITION);
    try {
      // 1. Start
      const start = runCli(env.cwd, ['workflow-start', 'simple', 'Add export']);
      assert.equal(start.code, 0, `start failed: ${start.stderr}`);
      assert.ok(start.json, 'start should emit JSON');
      assert.equal(start.json.ok, true);
      const workflowId = start.json.workflowId;
      assert.ok(workflowId, 'workflow-start must return workflowId');
      assert.equal(start.json.descriptor.kind, 'phase');
      assert.equal(start.json.descriptor.skillId, 'agentwright:feature-planning');
      assert.equal(start.json.agentwrightVersion, '2.1.5');
      assert.equal(start.json.busPresenceRequired, true);
      assert.match(start.json.busProbeInstruction, /wrightward_whoami/);

      // 2. Advance phase 0 → checkpoint
      const adv1 = runCli(env.cwd, [
        'workflow-advance',
        '--workflow', workflowId,
        '--result', 'completed',
        '--artifact-path', 'artifacts/plan.md',
      ]);
      assert.equal(adv1.code, 0, `advance1 failed: ${adv1.stderr}`);
      assert.equal(adv1.json.descriptor.kind, 'checkpoint');
      assert.equal(adv1.json.descriptor.name, 'plan-review');

      // 3. Resume past checkpoint → verify-plan
      const resume = runCli(env.cwd, ['workflow-resume', '--workflow', workflowId]);
      assert.equal(resume.code, 0, `resume failed: ${resume.stderr}`);
      assert.equal(resume.json.descriptor.kind, 'phase');
      assert.equal(resume.json.descriptor.skillId, 'agentwright:verify-plan');

      // 4. Advance verify-plan → command
      const adv2 = runCli(env.cwd, [
        'workflow-advance',
        '--workflow', workflowId,
        '--result', 'completed',
      ]);
      assert.equal(adv2.code, 0, `advance2 failed: ${adv2.stderr}`);
      assert.equal(adv2.json.descriptor.kind, 'phase');
      assert.equal(adv2.json.descriptor.type, 'command');
      assert.equal(adv2.json.descriptor.command, 'echo done');

      // 5. Advance command → done
      const adv3 = runCli(env.cwd, [
        'workflow-advance',
        '--workflow', workflowId,
        '--result', 'completed',
        '--mcp-result', JSON.stringify({ command: 'echo done', exitCode: 0, summary: 'ok' }),
      ]);
      assert.equal(adv3.code, 0, `advance3 failed: ${adv3.stderr}`);
      assert.equal(adv3.json.descriptor.kind, 'done');

      // 6. Status reports completed
      const status = runCli(env.cwd, ['workflow-status', '--workflow', workflowId]);
      assert.equal(status.code, 0);
      assert.equal(status.json.status, 'completed');
      assert.equal(status.json.workflowId, workflowId);
      assert.equal(status.json.phases.length, 4);
      assert.ok(status.json.phases.every(p => p.status === 'completed'));
    } finally {
      env.cleanup();
    }
  });

  test('workflow-stop on a running workflow marks it cancelled', () => {
    const env = setupRepo(SIMPLE_DEFINITION);
    try {
      const start = runCli(env.cwd, ['workflow-start', 'simple', 'Add export']);
      assert.equal(start.code, 0);
      const workflowId = start.json.workflowId;

      const stop = runCli(env.cwd, ['workflow-stop', '--workflow', workflowId]);
      assert.equal(stop.code, 0, `stop failed: ${stop.stderr}`);
      assert.equal(stop.json.status, 'cancelled');
      // The stop transitioned the workflow → the skill should broadcast.
      assert.equal(stop.json.broadcastNeeded, true);

      const status = runCli(env.cwd, ['workflow-status', '--workflow', workflowId]);
      assert.equal(status.code, 0);
      assert.equal(status.json.status, 'cancelled');
    } finally {
      env.cleanup();
    }
  });

  test('workflow-status without ID lists all workflows', () => {
    const env = setupRepo(SIMPLE_DEFINITION);
    try {
      runCli(env.cwd, ['workflow-start', 'simple', 'first']);
      runCli(env.cwd, ['workflow-start', 'simple', 'second']);
      const list = runCli(env.cwd, ['workflow-status']);
      assert.equal(list.code, 0);
      assert.ok(Array.isArray(list.json.workflows));
      assert.equal(list.json.workflows.length, 2);
      assert.deepEqual(list.json.workflows.map(w => w.workflowName), ['simple', 'simple']);
    } finally {
      env.cleanup();
    }
  });

  test('workflow-status accepts the positional workflow id form (mirrors --workflow)', () => {
    // printHelp advertises both `workflow-status --workflow <id>` and
    // `workflow-status <id>`. The --workflow form is exercised above; this
    // test pins the positional form so a future regression that flipped
    // `flags.workflow || positional[0]` would fail loudly.
    const env = setupRepo(SIMPLE_DEFINITION);
    try {
      const start = runCli(env.cwd, ['workflow-start', 'simple']);
      assert.equal(start.code, 0, start.stderr);
      const workflowId = start.json.workflowId;
      const proc = runCli(env.cwd, ['workflow-status', workflowId]);
      assert.equal(proc.code, 0, proc.stderr);
      // Full workflow snapshot, not the summary list shape.
      assert.equal(proc.json.workflowId, workflowId);
      assert.equal(proc.json.workflowName, 'simple');
      assert.ok(Array.isArray(proc.json.phases));
      assert.equal(proc.json.phases.length, 4);
    } finally {
      env.cleanup();
    }
  });

  test('workflow-start fails fast when agentwright path is invalid', () => {
    const cwd = tmpDir();
    // Block bootstrap fallback so the test deterministically hits the "not found" path.
    const pluginRoot = tmpDir();
    try {
      fs.mkdirSync(path.join(cwd, '.claude'), { recursive: true });
      fs.writeFileSync(path.join(cwd, '.claude', 'forgewright.json'),
        JSON.stringify({
          workflows: { simple: SIMPLE_DEFINITION },
          agentwright: { path: '/nonexistent/path/coordinator/index.js' },
        }, null, 2), 'utf8');
      const proc = runCli(cwd, ['workflow-start', 'simple'], { CLAUDE_PLUGIN_ROOT: pluginRoot });
      assert.notEqual(proc.code, 0);
      assert.match(proc.stderr, /agentwright CLI not found/);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
      fs.rmSync(pluginRoot, { recursive: true, force: true });
    }
  });

  test('workflow-start fails when workflow name is unknown', () => {
    const env = setupRepo(SIMPLE_DEFINITION);
    try {
      const start = runCli(env.cwd, ['workflow-start', 'does-not-exist']);
      assert.notEqual(start.code, 0);
      assert.match(start.stderr, /Unknown workflow: "does-not-exist"/);
    } finally {
      env.cleanup();
    }
  });

  test('workflow-start auto-rebinds when a newer agentwright version is available in the cache', () => {
    // Scenario: user had agentwright 2.1.5 stored in forgewright.json. They
    // upgraded to 2.1.6. The plugin cache keeps both on disk side-by-side.
    // The next workflow-start must transparently refresh agentwright.path to
    // the 2.1.6 dir — no manual rebind command, no LLM intervention.
    const cwd = tmpDir();
    const cacheRoot = tmpDir();
    try {
      const agentwrightOld = path.join(cacheRoot, 'agentwright', '2.1.5');
      const agentwrightNew = path.join(cacheRoot, 'agentwright', '2.1.6');
      for (const [dir, version] of [[agentwrightOld, '2.1.5'], [agentwrightNew, '2.1.6']]) {
        fs.mkdirSync(path.join(dir, 'coordinator'), { recursive: true });
        fs.mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'coordinator', 'index.js'),
          '#!/usr/bin/env node\n', 'utf8');
        fs.writeFileSync(path.join(dir, '.claude-plugin', 'plugin.json'),
          JSON.stringify({ name: 'agentwright', version }), 'utf8');
      }
      const oldCliPath = path.join(agentwrightOld, 'coordinator', 'index.js');
      const newCliPath = path.join(agentwrightNew, 'coordinator', 'index.js');
      const forgewrightRoot = path.join(cacheRoot, 'forgewright');
      fs.mkdirSync(forgewrightRoot, { recursive: true });

      // Seed forgewright.json with the OLD path plus a custom workflow we
      // want to verify auto-rebind leaves untouched.
      fs.mkdirSync(path.join(cwd, '.claude'), { recursive: true });
      fs.writeFileSync(path.join(cwd, '.claude', 'forgewright.json'),
        JSON.stringify({
          workflows: { 'simple': SIMPLE_DEFINITION, 'custom-thing': { phases: [{ name: 'hi', type: 'command', command: 'echo hi' }] } },
          agentwright: { path: oldCliPath },
        }, null, 2), 'utf8');

      const proc = runCli(cwd, ['workflow-start', 'simple'], { CLAUDE_PLUGIN_ROOT: forgewrightRoot });
      assert.equal(proc.code, 0, `workflow-start failed: ${proc.stderr}`);
      assert.equal(proc.json.agentwrightCli, newCliPath, 'workflow-start should resolve to the newer version');
      assert.equal(proc.json.agentwrightVersion, '2.1.6');

      const cfg = JSON.parse(fs.readFileSync(path.join(cwd, '.claude', 'forgewright.json'), 'utf8'));
      assert.equal(cfg.agentwright.path, newCliPath, 'auto-rebind should persist the new path');
      assert.ok(cfg.workflows && cfg.workflows['custom-thing'],
        'auto-rebind must not touch other config sections');
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
      fs.rmSync(cacheRoot, { recursive: true, force: true });
    }
  });
});
