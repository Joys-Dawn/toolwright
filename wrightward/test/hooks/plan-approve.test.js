'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { ensureCollabDir } = require('../../lib/collab-dir');
const { writeMarker } = require('../../lib/last-prompt');
const { withAgentsLock } = require('../../lib/agents');
const { append, tailReader } = require('../../lib/bus-log');
const { createEvent, SYNTHETIC_SENDER } = require('../../lib/bus-schema');
const { loadConfig } = require('../../lib/config');

const HOOK = path.resolve(__dirname, '../../hooks/plan-approve.js');

function runHookSync(input, env = {}) {
  return execFileSync('node', [HOOK], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    timeout: 30000,
    env: { ...process.env, ...env }
  });
}

function runHookAsync(input, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [HOOK], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('exit', code => resolve({ code, stdout, stderr }));
    child.stdin.write(JSON.stringify(input));
    child.stdin.end();
  });
}

function appendDiscordReply(collabDir, sessionId, body) {
  withAgentsLock(collabDir, (token) => {
    append(token, collabDir, createEvent(
      SYNTHETIC_SENDER, sessionId, 'user_message', body, { source: 'discord' }
    ));
  });
}

function readBus(collabDir) {
  let events = [];
  withAgentsLock(collabDir, (token) => {
    const r = tailReader(token, collabDir, 0);
    events = r.events;
  });
  return events;
}

describe('plan-approve hook (PermissionRequest for ExitPlanMode)', () => {
  let tmpDir, collabDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-approve-test-'));
    collabDir = ensureCollabDir(tmpDir);
    // Ensure config has BUS_ENABLED — the hook itself only checks ENABLED but
    // the bus-log path needs the collab tree set up which ensureCollabDir does.
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('exits silently when no last-prompt marker exists', () => {
    const out = runHookSync({
      session_id: 'sess-1',
      cwd: tmpDir,
      tool_name: 'ExitPlanMode',
      tool_input: { plan: 'do stuff' }
    });
    assert.equal(out, '');
  });

  it('exits silently when last-prompt marker is cli', () => {
    writeMarker(collabDir, 'sess-1', 'cli');
    const out = runHookSync({
      session_id: 'sess-1',
      cwd: tmpDir,
      tool_name: 'ExitPlanMode',
      tool_input: { plan: 'do stuff' }
    });
    assert.equal(out, '');
  });

  it('does nothing when ENABLED is false', () => {
    writeMarker(collabDir, 'sess-1', 'discord');
    fs.writeFileSync(path.join(tmpDir, '.claude', 'wrightward.json'),
      JSON.stringify({ ENABLED: false }));
    const out = runHookSync({
      session_id: 'sess-1',
      cwd: tmpDir,
      tool_name: 'ExitPlanMode',
      tool_input: { plan: 'do stuff' }
    });
    assert.equal(out, '');
    assert.equal(readBus(collabDir).length, 0);
  });

  it('exits silently when no collab directory exists', () => {
    const { root: fsRoot } = path.parse(tmpDir);
    const isolated = path.join(fsRoot, '__plan_approve_test_' + process.pid);
    fs.mkdirSync(isolated, { recursive: true });
    try {
      const out = runHookSync({
        session_id: 'sess-1',
        cwd: isolated,
        tool_name: 'ExitPlanMode',
        tool_input: { plan: 'x' }
      });
      assert.equal(out, '');
    } finally {
      fs.rmSync(isolated, { recursive: true, force: true });
    }
  });

  it('exits silently when session_id fails validateSessionId (e.g., reserved ID)', () => {
    writeMarker(collabDir, 'sess-1', 'discord');
    const out = runHookSync({
      session_id: 'wrightward:runtime',
      cwd: tmpDir,
      tool_name: 'ExitPlanMode',
      tool_input: { plan: 'do stuff' }
    });
    assert.equal(out, '');
    // Bus should be empty — validateSessionId failed before postPlanToBus.
    assert.equal(readBus(collabDir).length, 0);
  });

  it('posts plan to bus and returns allow on Discord approve reply', async () => {
    writeMarker(collabDir, 'sess-1', 'discord');

    const planText = '## Plan\n- step one\n- step two';
    const promise = runHookAsync({
      session_id: 'sess-1',
      cwd: tmpDir,
      tool_name: 'ExitPlanMode',
      tool_input: { plan: planText }
    }, {
      WRIGHTWARD_PLAN_APPROVE_TIMEOUT_MS: '10000',
      WRIGHTWARD_PLAN_APPROVE_POLL_MS: '100'
    });

    // Wait for the hook to post the plan, then send a Discord reply.
    await new Promise(r => setTimeout(r, 400));
    appendDiscordReply(collabDir, 'sess-1', 'approve');

    const { code, stdout } = await promise;
    assert.equal(code, 0);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.hookSpecificOutput.hookEventName, 'PermissionRequest');
    assert.equal(parsed.hookSpecificOutput.decision.behavior, 'allow');

    // The plan should be on the bus as an agent_message to 'user'.
    const events = readBus(collabDir);
    const planEvent = events.find(e => e.type === 'agent_message' && e.to === 'user');
    assert.ok(planEvent, 'expected an agent_message event addressed to user');
    assert.match(planEvent.body, /Plan ready for review:/);
    assert.match(planEvent.body, /step one/);
    assert.match(planEvent.body, /step two/);
  });

  it('returns deny with the reply text on a non-approve Discord reply', async () => {
    writeMarker(collabDir, 'sess-1', 'discord');

    const promise = runHookAsync({
      session_id: 'sess-1',
      cwd: tmpDir,
      tool_name: 'ExitPlanMode',
      tool_input: { plan: 'do stuff' }
    }, {
      WRIGHTWARD_PLAN_APPROVE_TIMEOUT_MS: '10000',
      WRIGHTWARD_PLAN_APPROVE_POLL_MS: '100'
    });

    await new Promise(r => setTimeout(r, 400));
    appendDiscordReply(collabDir, 'sess-1', 'deny: not enough detail on the migration');

    const { code, stdout } = await promise;
    assert.equal(code, 0);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.hookSpecificOutput.decision.behavior, 'deny');
    assert.match(parsed.hookSpecificOutput.decision.message, /not enough detail/);
  });

  it('returns deny + stop-and-wait message on timeout', async () => {
    writeMarker(collabDir, 'sess-1', 'discord');

    const { code, stdout } = await runHookAsync({
      session_id: 'sess-1',
      cwd: tmpDir,
      tool_name: 'ExitPlanMode',
      tool_input: { plan: 'do stuff' }
    }, {
      WRIGHTWARD_PLAN_APPROVE_TIMEOUT_MS: '600',
      WRIGHTWARD_PLAN_APPROVE_POLL_MS: '100'
    });

    assert.equal(code, 0);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.hookSpecificOutput.decision.behavior, 'deny');
    assert.match(parsed.hookSpecificOutput.decision.message, /5 minutes/);
    assert.match(parsed.hookSpecificOutput.decision.message, /ask me again/);
  });

  it('ignores non-discord-source user_message on the bus', async () => {
    writeMarker(collabDir, 'sess-1', 'discord');

    const promise = runHookAsync({
      session_id: 'sess-1',
      cwd: tmpDir,
      tool_name: 'ExitPlanMode',
      tool_input: { plan: 'do stuff' }
    }, {
      WRIGHTWARD_PLAN_APPROVE_TIMEOUT_MS: '600',
      WRIGHTWARD_PLAN_APPROVE_POLL_MS: '100'
    });

    // Append a user_message WITHOUT meta.source='discord' — should not satisfy.
    await new Promise(r => setTimeout(r, 200));
    withAgentsLock(collabDir, (token) => {
      append(token, collabDir, createEvent(
        SYNTHETIC_SENDER, 'sess-1', 'user_message', 'approve', {}
      ));
    });

    const { code, stdout } = await promise;
    assert.equal(code, 0);
    const parsed = JSON.parse(stdout);
    // Should have hit the timeout because the non-Discord reply was ignored.
    assert.equal(parsed.hookSpecificOutput.decision.behavior, 'deny');
    assert.match(parsed.hookSpecificOutput.decision.message, /5 minutes/);
  });

  it('ignores discord replies addressed to a different session', async () => {
    writeMarker(collabDir, 'sess-1', 'discord');

    const promise = runHookAsync({
      session_id: 'sess-1',
      cwd: tmpDir,
      tool_name: 'ExitPlanMode',
      tool_input: { plan: 'do stuff' }
    }, {
      WRIGHTWARD_PLAN_APPROVE_TIMEOUT_MS: '600',
      WRIGHTWARD_PLAN_APPROVE_POLL_MS: '100'
    });

    await new Promise(r => setTimeout(r, 200));
    appendDiscordReply(collabDir, 'sess-other', 'approve');

    const { code, stdout } = await promise;
    assert.equal(code, 0);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.hookSpecificOutput.decision.behavior, 'deny');
    assert.match(parsed.hookSpecificOutput.decision.message, /5 minutes/);
  });
});

describe('parseReply (plan-approve approval keyword surface)', () => {
  const { parseReply } = require('../../hooks/plan-approve');

  const ACCEPT_BODIES = [
    'approve', 'Approve', 'APPROVE',
    'approved',
    'yes', 'Yes', 'y', 'Y',
    'ok', 'OK', 'okay', 'Okay',
    'lgtm', 'LGTM',
    'ship it', 'shipit',
    'go', 'proceed',
    'approve!', 'approve.', 'approve!!!',
    '👍'
  ];
  const DENY_BODIES = [
    '', '   ',
    'go away', 'go fuck yourself',
    'yes but I disagree', 'yes, but',
    'ok no', 'okay so what about X',
    'approve, also ship tomorrow',
    'deny: not enough detail',
    'no'
  ];

  for (const body of ACCEPT_BODIES) {
    it(`accepts ${JSON.stringify(body)} as approval`, () => {
      assert.equal(parseReply(body).behavior, 'allow');
    });
  }

  for (const body of DENY_BODIES) {
    it(`denies ${JSON.stringify(body)}`, () => {
      assert.equal(parseReply(body).behavior, 'deny');
    });
  }
});
