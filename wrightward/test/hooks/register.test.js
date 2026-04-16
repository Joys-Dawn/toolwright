'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { ensureCollabDir } = require('../../lib/collab-dir');
const { registerAgent, withAgentsLock } = require('../../lib/agents');
const { writeContext, readContext } = require('../../lib/context');
const { append, readBookmark, writeBookmark } = require('../../lib/bus-log');
const { createEvent } = require('../../lib/bus-schema');

const HOOK = path.resolve(__dirname, '../../hooks/register.js');

function runHook(input, env) {
  return execFileSync('node', [HOOK], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    timeout: 5000,
    env: { ...process.env, ...env }
  });
}

describe('register hook', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collab-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates .claude/collab directory and registers agent', () => {
    runHook({ session_id: 'test-sess-1', cwd: tmpDir });

    assert.ok(fs.existsSync(path.join(tmpDir, '.claude', 'collab')));
    assert.ok(fs.existsSync(path.join(tmpDir, '.claude', 'collab', 'context')));
    assert.ok(fs.existsSync(path.join(tmpDir, '.claude', 'collab', 'context-hash')));

    const agents = JSON.parse(fs.readFileSync(path.join(tmpDir, '.claude', 'collab', 'agents.json'), 'utf8'));
    assert.ok(agents['test-sess-1']);
    assert.ok(agents['test-sess-1'].registered_at > 0);
  });

  it('appends .claude/collab/ to an existing .gitignore', () => {
    fs.writeFileSync(path.join(tmpDir, '.gitignore'), 'node_modules\n', 'utf8');
    runHook({ session_id: 'test-sess-1', cwd: tmpDir });
    const gitignore = fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf8');
    assert.match(gitignore, /node_modules/, 'pre-existing entries must survive');
    assert.match(gitignore, /\.claude\/collab\//);
  });

  it('does NOT create .gitignore when one does not exist', () => {
    // Launching `claude` from a non-VCS directory (e.g. ~) must not leave a
    // .gitignore behind. Two sessions in such a directory still get a shared
    // .claude/collab/ for coordination — they just don't pollute the parent.
    runHook({ session_id: 'test-sess-1', cwd: tmpDir });
    assert.ok(fs.existsSync(path.join(tmpDir, '.claude', 'collab')),
      'collab dir must still be created so multi-session coordination works');
    assert.ok(!fs.existsSync(path.join(tmpDir, '.gitignore')),
      'must not create a .gitignore where none existed');
  });

  it('registers multiple agents', () => {
    runHook({ session_id: 'sess-a', cwd: tmpDir });
    runHook({ session_id: 'sess-b', cwd: tmpDir });
    const agents = JSON.parse(fs.readFileSync(path.join(tmpDir, '.claude', 'collab', 'agents.json'), 'utf8'));
    assert.ok(agents['sess-a']);
    assert.ok(agents['sess-b']);
  });

  it('does nothing when ENABLED is false', () => {
    const claudeDir = path.join(tmpDir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(path.join(claudeDir, 'wrightward.json'), JSON.stringify({ ENABLED: false }));
    runHook({ session_id: 'test-sess-1', cwd: tmpDir });
    assert.ok(!fs.existsSync(path.join(tmpDir, '.claude', 'collab')));
  });

  it('sweeps expired file entries on SessionStart (reopened-session cleanup)', () => {
    // Simulate a session reopened after 3 days: an existing agent with old
    // planned files that are long past the 15-minute timeout. Reopening the
    // session must not leave those claims in place to block other sessions.
    const collabDir = ensureCollabDir(tmpDir);
    registerAgent(collabDir, 'stale-sess');
    const ancient = Date.now() - (3 * 24 * 60 * 60 * 1000); // 3 days ago
    writeContext(collabDir, 'stale-sess', {
      task: 'old work from days ago',
      files: [
        { path: 'src/ghost.js', prefix: '~', source: 'planned',
          declaredAt: ancient, lastTouched: ancient, reminded: false }
      ],
      status: 'in-progress'
    });

    runHook({ session_id: 'stale-sess', cwd: tmpDir });

    const ctx = readContext(collabDir, 'stale-sess');
    assert.equal(ctx.files.length, 0, 'expired planned file should have been scavenged on SessionStart');
  });

  it('also sweeps stale entries from OTHER sessions on SessionStart', () => {
    // A fresh session starting up should clean out any other session's stale
    // entries too, so it doesn't immediately hit ghost claims from dead agents.
    const collabDir = ensureCollabDir(tmpDir);
    registerAgent(collabDir, 'other-sess');
    const ancient = Date.now() - (3 * 24 * 60 * 60 * 1000);
    writeContext(collabDir, 'other-sess', {
      task: 'ancient claim',
      files: [
        { path: 'src/ghost.js', prefix: '~', source: 'planned',
          declaredAt: ancient, lastTouched: ancient, reminded: false }
      ],
      status: 'in-progress'
    });

    runHook({ session_id: 'new-sess', cwd: tmpDir });

    const ctx = readContext(collabDir, 'other-sess');
    assert.equal(ctx.files.length, 0, 'other session\'s expired entries should have been scavenged');
  });

  // Bus-specific tests
  it('creates bus subdirectories', () => {
    runHook({ session_id: 'test-sess-1', cwd: tmpDir });
    const collabDir = path.join(tmpDir, '.claude', 'collab');
    assert.ok(fs.existsSync(path.join(collabDir, 'bus-delivered')));
    assert.ok(fs.existsSync(path.join(collabDir, 'bus-index')));
    assert.ok(fs.existsSync(path.join(collabDir, 'mcp-bindings')));
  });

  it('writes MCP binding ticket', () => {
    runHook({ session_id: 'test-sess-1', cwd: tmpDir });
    const bindingsDir = path.join(tmpDir, '.claude', 'collab', 'mcp-bindings');
    const files = fs.readdirSync(bindingsDir);
    assert.ok(files.length >= 1, 'Expected at least one binding ticket');
    const ticket = JSON.parse(fs.readFileSync(path.join(bindingsDir, files[0]), 'utf8'));
    assert.equal(ticket.session_id, 'test-sess-1');
    assert.ok(ticket.created_at > 0);
    assert.ok(ticket.hook_pid > 0);
  });

  it('appends session_started event to bus.jsonl on source=startup', () => {
    runHook({ session_id: 'test-sess-1', cwd: tmpDir, source: 'startup' });
    const busFile = path.join(tmpDir, '.claude', 'collab', 'bus.jsonl');
    assert.ok(fs.existsSync(busFile));
    const content = fs.readFileSync(busFile, 'utf8').trim();
    const event = JSON.parse(content);
    assert.equal(event.type, 'session_started');
    assert.equal(event.from, 'test-sess-1');
    assert.equal(event.to, 'all');
    assert.equal(event.meta.hook_source, 'startup');
  });

  it('appends session_started when source is omitted (back-compat fallback)', () => {
    // Older Claude Code versions may not send `source`. Treat undefined as startup
    // so wrightward keeps announcing sessions on those hosts.
    runHook({ session_id: 'test-sess-1', cwd: tmpDir });
    const busFile = path.join(tmpDir, '.claude', 'collab', 'bus.jsonl');
    assert.ok(fs.existsSync(busFile));
    const event = JSON.parse(fs.readFileSync(busFile, 'utf8').trim());
    assert.equal(event.type, 'session_started');
    assert.equal(event.meta.hook_source, 'startup');
  });

  it('appends session_started when source is resume', () => {
    runHook({ session_id: 'test-sess-1', cwd: tmpDir, source: 'resume' });
    const busFile = path.join(tmpDir, '.claude', 'collab', 'bus.jsonl');
    assert.ok(fs.existsSync(busFile));
    const event = JSON.parse(fs.readFileSync(busFile, 'utf8').trim());
    assert.equal(event.type, 'session_started');
    assert.equal(event.meta.hook_source, 'resume');
  });

  it('does NOT append session_started when source is clear', () => {
    runHook({ session_id: 'test-sess-1', cwd: tmpDir, source: 'clear' });
    const busFile = path.join(tmpDir, '.claude', 'collab', 'bus.jsonl');
    const hasBus = fs.existsSync(busFile);
    if (hasBus) {
      const content = fs.readFileSync(busFile, 'utf8');
      assert.ok(!content.includes('session_started'),
        'clear source must not produce a session_started event');
    }
  });

  it('does NOT append session_started when source is compact', () => {
    // This is the root-cause fix: a long-lived session that auto-compacts must
    // not re-announce itself to the bus (and therefore to Discord).
    runHook({ session_id: 'test-sess-1', cwd: tmpDir, source: 'compact' });
    const busFile = path.join(tmpDir, '.claude', 'collab', 'bus.jsonl');
    const hasBus = fs.existsSync(busFile);
    if (hasBus) {
      const content = fs.readFileSync(busFile, 'utf8');
      assert.ok(!content.includes('session_started'),
        'compact source must not produce a session_started event');
    }
  });

  it('still registers agent and writes ticket on source=clear (heartbeat refresh)', () => {
    runHook({ session_id: 'sess-clear', cwd: tmpDir, source: 'clear' });
    const collabDir = path.join(tmpDir, '.claude', 'collab');
    const agents = JSON.parse(fs.readFileSync(path.join(collabDir, 'agents.json'), 'utf8'));
    assert.ok(agents['sess-clear'], 'agent must be registered even when announce is suppressed');
    const tickets = fs.readdirSync(path.join(collabDir, 'mcp-bindings'));
    assert.ok(tickets.length >= 1, 'binding ticket must be written on clear');
  });

  it('still registers agent and writes ticket on source=compact (heartbeat refresh)', () => {
    runHook({ session_id: 'sess-compact', cwd: tmpDir, source: 'compact' });
    const collabDir = path.join(tmpDir, '.claude', 'collab');
    const agents = JSON.parse(fs.readFileSync(path.join(collabDir, 'agents.json'), 'utf8'));
    assert.ok(agents['sess-compact'], 'agent must be registered even when announce is suppressed');
    const tickets = fs.readdirSync(path.join(collabDir, 'mcp-bindings'));
    assert.ok(tickets.length >= 1, 'binding ticket must be written on compact');
  });

  it('anchors a fresh session\'s bookmark at bus tail so history is not replayed', () => {
    // Pre-populate the bus with events from an earlier coordination run — the
    // scenario a new agent would otherwise inherit wholesale on first inbox
    // scan because its default bookmark points at offset 0.
    runHook({ session_id: 'sess-prior', cwd: tmpDir, source: 'startup' });
    const collabDir = path.join(tmpDir, '.claude', 'collab');
    withAgentsLock(collabDir, (token) => {
      append(token, collabDir, createEvent('sess-prior', 'all', 'finding', 'old finding 1'));
      append(token, collabDir, createEvent('sess-prior', 'all', 'decision', 'old decision'));
    });
    const busBefore = fs.statSync(path.join(collabDir, 'bus.jsonl')).size;

    runHook({ session_id: 'sess-new', cwd: tmpDir, source: 'startup' });

    const bm = readBookmark(collabDir, 'sess-new');
    assert.ok(bm.lastScannedOffset >= busBefore,
      'fresh session bookmark must be at or past the prior bus tail');
    assert.equal(bm.lastScannedOffset, bm.lastDeliveredOffset,
      'scanned and delivered offsets should be aligned for a tail-anchored init');
  });

  it('does not overwrite an existing bookmark on resume', () => {
    runHook({ session_id: 'sess-resume', cwd: tmpDir, source: 'startup' });
    const collabDir = path.join(tmpDir, '.claude', 'collab');
    const existing = {
      lastDeliveredOffset: 42,
      lastScannedOffset: 42,
      lastDeliveredId: 'evt-mid',
      lastDeliveredTs: 1700000000,
      generation: 0
    };
    withAgentsLock(collabDir, (token) => {
      writeBookmark(token, collabDir, 'sess-resume', existing);
    });

    runHook({ session_id: 'sess-resume', cwd: tmpDir, source: 'resume' });

    const bm = readBookmark(collabDir, 'sess-resume');
    assert.deepEqual(bm, existing,
      'resumed session must keep its prior bookmark so missed events catch up');
  });

  it('does not write bus files when BUS_ENABLED is false', () => {
    const claudeDir = path.join(tmpDir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(path.join(claudeDir, 'wrightward.json'), JSON.stringify({ BUS_ENABLED: false }));
    runHook({ session_id: 'test-sess-1', cwd: tmpDir });
    const busFile = path.join(tmpDir, '.claude', 'collab', 'bus.jsonl');
    assert.ok(!fs.existsSync(busFile));
  });

  it('snapshot bypass fires before bus emission', () => {
    const snapshotDir = path.join(os.tmpdir(), 'agentwright-snapshots', 'snap-test-' + Date.now());
    fs.mkdirSync(snapshotDir, { recursive: true });
    try {
      runHook({ session_id: 'snap-sess', cwd: snapshotDir });
      const busFile = path.join(snapshotDir, '.claude', 'collab', 'bus.jsonl');
      assert.ok(!fs.existsSync(busFile));
    } finally {
      fs.rmSync(snapshotDir, { recursive: true, force: true });
    }
  });

  it('persists session env vars for later Bash commands when CLAUDE_ENV_FILE is set', () => {
    const envFile = path.join(tmpDir, 'session-env.sh');

    runHook(
      { session_id: 'sess-env', cwd: tmpDir },
      { CLAUDE_ENV_FILE: envFile }
    );

    const envContent = fs.readFileSync(envFile, 'utf8');
    assert.match(envContent, /export COLLAB_SESSION_ID='sess-env'/);
    assert.ok(envContent.includes(`export COLLAB_PROJECT_CWD='${tmpDir}'`),
      `expected COLLAB_PROJECT_CWD='${tmpDir}' in env file, got: ${envContent}`);
  });

  describe('SessionStart additionalContext emission', () => {
    // The hook writes a Claude Code SessionStart hook JSON to stdout telling
    // the agent its own handle. Without this injection, a fresh session has
    // no way to know its own name — peers would address it by handle in
    // inbox hints, but the session couldn't ack or self-identify on Discord.
    const { deriveHandle } = require('../../lib/handles');

    it('emits additionalContext JSON with the session handle', () => {
      const stdout = runHook({ session_id: 'test-sess-ctx', cwd: tmpDir });
      const payload = JSON.parse(stdout.trim());
      assert.equal(payload.hookSpecificOutput.hookEventName, 'SessionStart');
      const msg = payload.hookSpecificOutput.additionalContext;
      const expectedHandle = deriveHandle('test-sess-ctx');
      assert.ok(msg.includes('**' + expectedHandle + '**'),
        'context message must include the derived handle: ' + msg);
      assert.ok(msg.includes('test-sess-ctx'),
        'context message must mention the sessionId so the agent can cross-reference: ' + msg);
      assert.match(msg, /wrightward_send_message/,
        'context message must tell the agent how to address peers');
      assert.match(msg, /wrightward_whoami/,
        'context message must point at the self-discovery tool for post-compaction recovery');
    });

    it('mentions the Discord auto-chunk envelope so agents self-moderate length', () => {
      // Agents otherwise have no way to know the bridge will split long
      // messages across multiple Discord posts. Without this hint, a short
      // ack and a 4000-char plan both look the same from the agent's side
      // — and the agent can't judge whether to compress the ack.
      const stdout = runHook({ session_id: 'test-sess-chunks', cwd: tmpDir });
      const msg = JSON.parse(stdout.trim()).hookSpecificOutput.additionalContext;
      assert.match(msg, /auto-split|multiple Discord posts/i,
        'context must describe the auto-chunking envelope: ' + msg);
    });

    it('does NOT emit additionalContext when BUS_ENABLED is false', () => {
      // Tools are unavailable when the bus is off — injecting a message that
      // tells the agent to call wrightward_send_message would be misleading.
      const claudeDir = path.join(tmpDir, '.claude');
      fs.mkdirSync(claudeDir, { recursive: true });
      fs.writeFileSync(path.join(claudeDir, 'wrightward.json'),
        JSON.stringify({ ENABLED: true, BUS_ENABLED: false }));
      const stdout = runHook({ session_id: 'test-sess-quiet', cwd: tmpDir });
      assert.equal(stdout.trim(), '',
        'no context JSON should be emitted when BUS_ENABLED=false');
    });

    it('stdout contains exactly one JSON payload (Claude Code parses the first line)', () => {
      // The SessionStart hook contract is "stdout JSON = additionalContext".
      // Multiple newline-separated JSON blobs would break the parser or
      // double-inject context.
      const stdout = runHook({ session_id: 'test-sess-once', cwd: tmpDir });
      const trimmed = stdout.trim();
      // Single parse must succeed; trailing content would fail the
      // zero-trailing-garbage assertion below.
      const payload = JSON.parse(trimmed);
      assert.ok(payload.hookSpecificOutput);
      // The entire stdout is the one JSON object (plus trailing newline).
      assert.equal(JSON.stringify(payload), trimmed.replace(/\s+$/, ''));
    });

    it('emits handle deterministically across re-registration of the same sessionId', () => {
      // Resume / clear / compact all re-fire SessionStart with the same
      // session_id. The handle MUST NOT change — it's keyed on the UUID
      // and must be stable for the life of the session.
      const out1 = runHook({ session_id: 'stable-sess', cwd: tmpDir, source: 'startup' });
      const out2 = runHook({ session_id: 'stable-sess', cwd: tmpDir, source: 'resume' });
      const p1 = JSON.parse(out1.trim()).hookSpecificOutput.additionalContext;
      const p2 = JSON.parse(out2.trim()).hookSpecificOutput.additionalContext;
      const handleOf = (s) => s.match(/\*\*([a-z]+-\d+)\*\*/)[1];
      assert.equal(handleOf(p1), handleOf(p2),
        'handle must not change between startup and resume for the same sessionId');
    });
  });
});
