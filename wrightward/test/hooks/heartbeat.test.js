'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { ensureCollabDir } = require('../../lib/collab-dir');
const { registerAgent, readAgents, withAgentsLock } = require('../../lib/agents');
const { writeContext, readContext } = require('../../lib/context');
const { fileEntryForPath } = require('../../lib/context');
const { append, busPath, readBookmark } = require('../../lib/bus-log');
const { createEvent } = require('../../lib/bus-schema');
const interestIndex = require('../../lib/interest-index');

const HOOK = path.resolve(__dirname, '../../hooks/heartbeat.js');

function runHook(input) {
  try {
    const stdout = execFileSync('node', [HOOK], {
      input: JSON.stringify(input),
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    return { exitCode: 0, stdout, stderr: '' };
  } catch (e) {
    return { exitCode: e.status, stdout: e.stdout || '', stderr: e.stderr || '' };
  }
}

describe('heartbeat hook', () => {
  let tmpDir;
  let collabDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collab-test-'));
    collabDir = ensureCollabDir(tmpDir);
    registerAgent(collabDir, 'sess-1');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('updates last_active timestamp', () => {
    const before = readAgents(collabDir)['sess-1'].last_active;
    const start = Date.now();
    while (Date.now() === start) {}
    runHook({ session_id: 'sess-1', cwd: tmpDir });
    const after = readAgents(collabDir)['sess-1'].last_active;
    assert.ok(after >= before);
  });

  it('auto-tracks edited file as object entry with ~ prefix', () => {
    writeContext(collabDir, 'sess-1', { task: 'my work', files: [], status: 'in-progress' });
    runHook({
      session_id: 'sess-1',
      cwd: tmpDir,
      tool_name: 'Edit',
      tool_input: { file_path: path.join(tmpDir, 'src', 'foo.js') }
    });
    const ctx = readContext(collabDir, 'sess-1');
    assert.equal(ctx.files.length, 1);
    assert.equal(ctx.files[0].path, 'src/foo.js');
    assert.equal(ctx.files[0].prefix, '~');
    assert.equal(ctx.files[0].source, 'auto');
    assert.equal(ctx.files[0].reminded, false);
  });

  it('auto-tracks written file as object entry with + prefix', () => {
    writeContext(collabDir, 'sess-1', { task: 'my work', files: [], status: 'in-progress' });
    runHook({
      session_id: 'sess-1',
      cwd: tmpDir,
      tool_name: 'Write',
      tool_input: { file_path: path.join(tmpDir, 'new-file.ts') }
    });
    const ctx = readContext(collabDir, 'sess-1');
    assert.equal(ctx.files.length, 1);
    assert.equal(ctx.files[0].path, 'new-file.ts');
    assert.equal(ctx.files[0].prefix, '+');
    assert.equal(ctx.files[0].source, 'auto');
  });

  it('updates lastTouched and resets reminded for existing file', () => {
    const oldTime = Date.now() - 600000;
    writeContext(collabDir, 'sess-1', {
      task: 'my work',
      files: [{
        path: 'src/foo.js', prefix: '+', source: 'planned',
        declaredAt: oldTime, lastTouched: oldTime, reminded: true
      }],
      status: 'in-progress'
    });
    const before = Date.now();
    runHook({
      session_id: 'sess-1',
      cwd: tmpDir,
      tool_name: 'Edit',
      tool_input: { file_path: path.join(tmpDir, 'src', 'foo.js') }
    });
    const ctx = readContext(collabDir, 'sess-1');
    assert.equal(ctx.files.length, 1);
    assert.equal(ctx.files[0].prefix, '+');
    assert.equal(ctx.files[0].source, 'planned');
    assert.ok(ctx.files[0].lastTouched >= before);
    assert.equal(ctx.files[0].reminded, false);
  });

  it('does not track files outside the project', () => {
    writeContext(collabDir, 'sess-1', { task: 'my work', files: [], status: 'in-progress' });
    runHook({
      session_id: 'sess-1',
      cwd: tmpDir,
      tool_name: 'Edit',
      tool_input: { file_path: '/some/other/project/file.js' }
    });
    const ctx = readContext(collabDir, 'sess-1');
    assert.equal(ctx.files.length, 0);
  });

  it('auto-creates context when agent has no context declared', () => {
    runHook({
      session_id: 'sess-1',
      cwd: tmpDir,
      tool_name: 'Edit',
      tool_input: { file_path: path.join(tmpDir, 'foo.js') }
    });
    const ctx = readContext(collabDir, 'sess-1');
    assert.notEqual(ctx, null);
    assert.equal(ctx.task, 'Auto-tracked (no task declared)');
    assert.equal(ctx.files.length, 1);
    assert.equal(ctx.files[0].path, 'foo.js');
    assert.equal(ctx.files[0].source, 'auto');
  });

  it('does not track for Read tool', () => {
    writeContext(collabDir, 'sess-1', { task: 'my work', files: [], status: 'in-progress' });
    runHook({
      session_id: 'sess-1',
      cwd: tmpDir,
      tool_name: 'Read',
      tool_input: { file_path: path.join(tmpDir, 'foo.js') }
    });
    const ctx = readContext(collabDir, 'sess-1');
    assert.equal(ctx.files.length, 0);
  });

  it('exits cleanly when .claude/collab does not exist and tool is Read', () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collab-empty-'));
    try {
      const result = runHook({ session_id: 'sess-1', cwd: emptyDir, tool_name: 'Read', tool_input: {} });
      assert.equal(result.exitCode, 0);
      // Should not have created collabDir
      assert.ok(!fs.existsSync(path.join(emptyDir, '.claude', 'collab')));
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it('creates collabDir when .claude/collab does not exist and tool is Edit', () => {
    // Use a dir at filesystem root so walk-up can't find a real .claude/collab
    const { root: fsRoot } = path.parse(tmpDir);
    const emptyDir = path.join(fsRoot, '__collab_heartbeat_test_' + process.pid);
    fs.mkdirSync(emptyDir, { recursive: true });
    try {
      const result = runHook({
        session_id: 'sess-1',
        cwd: emptyDir,
        tool_name: 'Edit',
        tool_input: { file_path: path.join(emptyDir, 'foo.js') }
      });
      assert.equal(result.exitCode, 0);
      assert.ok(fs.existsSync(path.join(emptyDir, '.claude', 'collab')));
      const ctx = readContext(path.join(emptyDir, '.claude', 'collab'), 'sess-1');
      assert.notEqual(ctx, null);
      assert.equal(ctx.files[0].path, 'foo.js');
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it('emits idle reminder for planned files not touched within REMINDER_IDLE_MS (when other agents active)', () => {
    // Reminders are designed for planned files (declared via /wrightward:collab-context)
    // that the agent forgot about. Auto-tracked files expire at 2 minutes, well before
    // the 5-minute reminder window, so they're never reachable for reminders.
    // Planned files have a 15-minute timeout, which gives the reminder a real window.
    // Reminders only fire when another agent is active — otherwise there's nobody to unblock.
    registerAgent(collabDir, 'sess-other');
    const oldTime = Date.now() - 400000; // 6+ minutes ago — past reminder window, still within planned timeout
    writeContext(collabDir, 'sess-1', {
      task: 'my work',
      files: [
        { path: 'old.js', prefix: '~', source: 'planned', declaredAt: oldTime, lastTouched: oldTime, reminded: false },
        { path: 'recent.js', prefix: '~', source: 'planned', declaredAt: Date.now(), lastTouched: Date.now(), reminded: false }
      ],
      status: 'in-progress'
    });
    const result = runHook({
      session_id: 'sess-1',
      cwd: tmpDir,
      tool_name: 'Edit',
      tool_input: { file_path: path.join(tmpDir, 'another.js') }
    });
    assert.equal(result.exitCode, 0);
    assert.ok(result.stdout.length > 0);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.hookSpecificOutput.hookEventName, 'PostToolUse');
    assert.ok(parsed.hookSpecificOutput.additionalContext.includes('old.js'));
    assert.ok(!parsed.hookSpecificOutput.additionalContext.includes('recent.js'));

    // Verify reminded flag is set
    const ctx = readContext(collabDir, 'sess-1');
    const oldEntry = ctx.files.find(f => f.path === 'old.js');
    assert.equal(oldEntry.reminded, true);
  });

  it('does NOT emit idle reminder when the session is solo (no other agents)', () => {
    // Solo agent has nobody to unblock, so the reminder is just noise.
    // Also verifies the 'reminded' flag is NOT flipped — so a later-joining agent
    // can still trigger the reminder when it becomes relevant.
    const oldTime = Date.now() - 400000;
    writeContext(collabDir, 'sess-1', {
      task: 'my work',
      files: [
        { path: 'old.js', prefix: '~', source: 'planned', declaredAt: oldTime, lastTouched: oldTime, reminded: false }
      ],
      status: 'in-progress'
    });
    const result = runHook({
      session_id: 'sess-1',
      cwd: tmpDir,
      tool_name: 'Edit',
      tool_input: { file_path: path.join(tmpDir, 'another.js') }
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, '');

    // Reminded flag must NOT be set — if another agent joins later, the reminder
    // should still be able to fire.
    const ctx = readContext(collabDir, 'sess-1');
    const oldEntry = ctx.files.find(f => f.path === 'old.js');
    assert.equal(oldEntry.reminded, false);
  });

  it('does not re-emit reminder for already-reminded files', () => {
    registerAgent(collabDir, 'sess-other');
    const oldTime = Date.now() - 400000;
    writeContext(collabDir, 'sess-1', {
      task: 'my work',
      files: [
        { path: 'old.js', prefix: '~', source: 'planned', declaredAt: oldTime, lastTouched: oldTime, reminded: true }
      ],
      status: 'in-progress'
    });
    const result = runHook({
      session_id: 'sess-1',
      cwd: tmpDir,
      tool_name: 'Edit',
      tool_input: { file_path: path.join(tmpDir, 'another.js') }
    });
    assert.equal(result.exitCode, 0);
    // No reminder emitted (already reminded)
    assert.equal(result.stdout, '');
  });

  it('does not emit reminder for auto-tracked files (they expire before reminder window)', () => {
    // Auto-tracked files have a 2-minute timeout, scavenged well before the 5-minute
    // reminder window. This test documents that the reminder path is unreachable for
    // auto files — they just quietly age out.
    const oldTime = Date.now() - 400000; // 6+ minutes ago
    writeContext(collabDir, 'sess-1', {
      task: 'my work',
      files: [
        { path: 'auto-old.js', prefix: '~', source: 'auto', declaredAt: oldTime, lastTouched: oldTime, reminded: false }
      ],
      status: 'in-progress'
    });
    const result = runHook({
      session_id: 'sess-1',
      cwd: tmpDir,
      tool_name: 'Edit',
      tool_input: { file_path: path.join(tmpDir, 'another.js') }
    });
    assert.equal(result.exitCode, 0);
    // The stale auto-tracked file has been scavenged; the only remaining entry
    // should be the current 'another.js' just added by autoTrackFile.
    const ctx = readContext(collabDir, 'sess-1');
    assert.ok(!ctx.files.some(f => f.path === 'auto-old.js'));
    assert.ok(ctx.files.some(f => f.path === 'another.js'));
  });

  it('does not auto-create context when AUTO_TRACK is false', () => {
    // Write config disabling auto-track
    const claudeDir = path.join(tmpDir, '.claude');
    fs.writeFileSync(path.join(claudeDir, 'wrightward.json'), JSON.stringify({ AUTO_TRACK: false }));

    // Remove existing context so we test the no-context path
    const contextFile = path.join(collabDir, 'context', 'sess-1.json');
    try { fs.unlinkSync(contextFile); } catch (_) {}

    runHook({
      session_id: 'sess-1',
      cwd: tmpDir,
      tool_name: 'Edit',
      tool_input: { file_path: path.join(tmpDir, 'foo.js') }
    });
    const ctx = readContext(collabDir, 'sess-1');
    assert.equal(ctx, null);
  });

  it('does nothing when ENABLED is false', () => {
    const claudeDir = path.join(tmpDir, '.claude');
    fs.writeFileSync(path.join(claudeDir, 'wrightward.json'), JSON.stringify({ ENABLED: false }));
    writeContext(collabDir, 'sess-1', { task: 'my work', files: [], status: 'in-progress' });
    const before = readAgents(collabDir)['sess-1'].last_active;
    const start = Date.now();
    while (Date.now() === start) {}
    runHook({
      session_id: 'sess-1',
      cwd: tmpDir,
      tool_name: 'Edit',
      tool_input: { file_path: path.join(tmpDir, 'foo.js') }
    });
    // Heartbeat should not have updated
    const after = readAgents(collabDir)['sess-1'].last_active;
    assert.equal(after, before);
    // File should not have been tracked
    const ctx = readContext(collabDir, 'sess-1');
    assert.equal(ctx.files.length, 0);
  });

  it('does nothing when ENABLED is false and cwd is a subdirectory', () => {
    const claudeDir = path.join(tmpDir, '.claude');
    fs.writeFileSync(path.join(claudeDir, 'wrightward.json'), JSON.stringify({ ENABLED: false }));
    writeContext(collabDir, 'sess-1', { task: 'my work', files: [], status: 'in-progress' });
    const subDir = path.join(tmpDir, 'app', 'src');
    fs.mkdirSync(subDir, { recursive: true });
    const before = readAgents(collabDir)['sess-1'].last_active;
    const start = Date.now();
    while (Date.now() === start) {}
    runHook({
      session_id: 'sess-1',
      cwd: subDir,
      tool_name: 'Edit',
      tool_input: { file_path: path.join(subDir, 'foo.js') }
    });
    const after = readAgents(collabDir)['sess-1'].last_active;
    assert.equal(after, before);
    const ctx = readContext(collabDir, 'sess-1');
    assert.equal(ctx.files.length, 0);
  });

  it('still tracks into existing context when AUTO_TRACK is false', () => {
    const claudeDir = path.join(tmpDir, '.claude');
    fs.writeFileSync(path.join(claudeDir, 'wrightward.json'), JSON.stringify({ AUTO_TRACK: false }));

    writeContext(collabDir, 'sess-1', { task: 'my work', files: [], status: 'in-progress' });
    runHook({
      session_id: 'sess-1',
      cwd: tmpDir,
      tool_name: 'Edit',
      tool_input: { file_path: path.join(tmpDir, 'foo.js') }
    });
    const ctx = readContext(collabDir, 'sess-1');
    assert.equal(ctx.files.length, 1);
    assert.equal(ctx.files[0].path, 'foo.js');
  });

  // === Bus integration tests ===

  it('injects urgent inbox events as additionalContext', () => {
    writeContext(collabDir, 'sess-1', { task: 'work', files: [], status: 'in-progress' });
    // Seed an urgent event for sess-1
    withAgentsLock(collabDir, (token) => {
      append(token, collabDir, createEvent('sess-2', 'sess-1', 'handoff', 'please take over auth'));
    });

    const result = runHook({
      session_id: 'sess-1',
      cwd: tmpDir,
      tool_name: 'Read',
      tool_input: { file_path: path.join(tmpDir, 'anything.js') }
    });
    assert.equal(result.exitCode, 0);
    assert.ok(result.stdout.length > 0);
    const parsed = JSON.parse(result.stdout);
    assert.ok(parsed.hookSpecificOutput.additionalContext.includes('please take over auth'));
  });

  it('advances bookmark after inbox injection', () => {
    writeContext(collabDir, 'sess-1', { task: 'work', files: [], status: 'in-progress' });
    withAgentsLock(collabDir, (token) => {
      append(token, collabDir, createEvent('sess-2', 'sess-1', 'handoff', 'msg'));
    });

    runHook({
      session_id: 'sess-1',
      cwd: tmpDir,
      tool_name: 'Read',
      tool_input: { file_path: path.join(tmpDir, 'x.js') }
    });

    const bm = readBookmark(collabDir, 'sess-1');
    assert.ok(bm.lastDeliveredOffset > 0);
    assert.ok(bm.lastScannedOffset > 0);
  });

  it('does not emit bus events when BUS_ENABLED is false', () => {
    const claudeDir = path.join(tmpDir, '.claude');
    fs.writeFileSync(path.join(claudeDir, 'wrightward.json'), JSON.stringify({ BUS_ENABLED: false }));
    writeContext(collabDir, 'sess-1', { task: 'work', files: [], status: 'in-progress' });

    // Seed an event — should be ignored
    withAgentsLock(collabDir, (token) => {
      append(token, collabDir, createEvent('sess-2', 'sess-1', 'handoff', 'msg'));
    });

    const result = runHook({
      session_id: 'sess-1',
      cwd: tmpDir,
      tool_name: 'Read',
      tool_input: { file_path: path.join(tmpDir, 'x.js') }
    });
    // Should exit cleanly with no bus injection
    assert.equal(result.exitCode, 0);
    // No bookmark should be written
    const bm = readBookmark(collabDir, 'sess-1');
    assert.equal(bm.lastDeliveredOffset, 0);
  });

  it('emits file_freed events when scavengeExpiredFiles removes files with interested agents', () => {
    registerAgent(collabDir, 'sess-2');
    const oldTime = Date.now() - 200000; // well past auto-track timeout
    writeContext(collabDir, 'sess-2', {
      task: 'other work',
      files: [{ path: 'stale.js', prefix: '~', source: 'auto', declaredAt: oldTime, lastTouched: oldTime, reminded: false }],
      status: 'in-progress'
    });

    // sess-1 is interested in stale.js
    withAgentsLock(collabDir, (token) => {
      interestIndex.upsert(token, collabDir, 'stale.js', {
        sessionId: 'sess-1', busEventId: 'e1', declaredAt: Date.now(), expiresAt: null
      });
    });

    writeContext(collabDir, 'sess-1', { task: 'my work', files: [], status: 'in-progress' });

    runHook({
      session_id: 'sess-1',
      cwd: tmpDir,
      tool_name: 'Read',
      tool_input: { file_path: path.join(tmpDir, 'x.js') }
    });

    const bp = busPath(collabDir);
    assert.ok(fs.existsSync(bp), 'bus.jsonl must exist after file_freed emission');
    const events = fs.readFileSync(bp, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    const freed = events.find(e => e.type === 'file_freed' && e.meta.file === 'stale.js' && e.to === 'sess-1');
    assert.ok(freed, 'Expected file_freed event for interested agent');
  });

  it('skips file_freed for files that were re-claimed between scavenge and emit', () => {
    // sess-2 holds a stale file that will be scavenged.
    // Before the emit lock opens, sess-3 re-claims the same file.
    // Heartbeat should NOT emit a misleading file_freed.
    registerAgent(collabDir, 'sess-2');
    registerAgent(collabDir, 'sess-3');
    const oldTime = Date.now() - 200000;
    writeContext(collabDir, 'sess-2', {
      task: 'old work',
      files: [{ path: 'contested.js', prefix: '~', source: 'auto', declaredAt: oldTime, lastTouched: oldTime, reminded: false }],
      status: 'in-progress'
    });
    // sess-3 now also claims contested.js (simulating re-claim via collab-context)
    writeContext(collabDir, 'sess-3', {
      task: 'taking over',
      files: [{ path: 'contested.js', prefix: '+', source: 'planned', declaredAt: Date.now(), lastTouched: Date.now(), reminded: false }],
      status: 'in-progress'
    });
    // sess-1 is interested in contested.js
    withAgentsLock(collabDir, (token) => {
      interestIndex.upsert(token, collabDir, 'contested.js', {
        sessionId: 'sess-1', busEventId: 'e1', declaredAt: Date.now(), expiresAt: null
      });
    });
    writeContext(collabDir, 'sess-1', { task: 'my work', files: [], status: 'in-progress' });

    runHook({
      session_id: 'sess-1',
      cwd: tmpDir,
      tool_name: 'Read',
      tool_input: { file_path: path.join(tmpDir, 'x.js') }
    });

    const bp = busPath(collabDir);
    const events = fs.existsSync(bp)
      ? fs.readFileSync(bp, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
      : [];
    const freed = events.find(e => e.type === 'file_freed' && e.meta.file === 'contested.js');
    assert.ok(!freed, 'Should NOT emit file_freed — sess-3 still claims contested.js');
  });

  it('does not compact when bus is small', () => {
    writeContext(collabDir, 'sess-1', { task: 'work', files: [], status: 'in-progress' });
    // Write a few events — well under the compaction threshold
    withAgentsLock(collabDir, (token) => {
      append(token, collabDir, createEvent('sess-2', 'sess-1', 'note', 'hi'));
      append(token, collabDir, createEvent('sess-2', 'sess-1', 'note', 'there'));
    });

    const bp = busPath(collabDir);
    const sizeBefore = fs.statSync(bp).size;

    runHook({
      session_id: 'sess-1',
      cwd: tmpDir,
      tool_name: 'Read',
      tool_input: { file_path: path.join(tmpDir, 'x.js') }
    });

    // Bus should still have the same content (not compacted away)
    const content = fs.readFileSync(bp, 'utf8').trim();
    const lines = content.split('\n');
    assert.ok(lines.length >= 2, 'Events should not have been compacted away');
  });

  it('compacts bus when eventCount exceeds BUS_RETENTION_MAX_EVENTS', () => {
    // Shrink the retention cap so a few events trigger compaction.
    fs.writeFileSync(
      path.join(tmpDir, '.claude', 'wrightward.json'),
      JSON.stringify({ BUS_RETENTION_MAX_EVENTS: 2 })
    );
    writeContext(collabDir, 'sess-1', { task: 'work', files: [], status: 'in-progress' });

    withAgentsLock(collabDir, (token) => {
      for (let i = 0; i < 4; i++) {
        append(token, collabDir, createEvent('sess-2', 'sess-1', 'note', 'm' + i));
      }
      // Plant a stale interest-index entry. If the rebuildInterestIndex callback
      // actually runs after compaction, this entry disappears (rebuild reconstructs
      // solely from on-disk events, and no 'interest' events exist on the bus).
      interestIndex.upsert(token, collabDir, 'phantom.js', {
        sessionId: 'sess-1', busEventId: 'STALE', declaredAt: Date.now(), expiresAt: null
      });
    });

    const bp = busPath(collabDir);
    const beforeLines = fs.readFileSync(bp, 'utf8').trim().split('\n').filter(Boolean);
    assert.ok(beforeLines.length > 2);

    runHook({
      session_id: 'sess-1',
      cwd: tmpDir,
      tool_name: 'Read',
      tool_input: { file_path: path.join(tmpDir, 'x.js') }
    });

    const afterLines = fs.readFileSync(bp, 'utf8').trim().split('\n').filter(Boolean);
    assert.ok(afterLines.length <= 2, 'Bus not trimmed to BUS_RETENTION_MAX_EVENTS: ' + afterLines.length);

    const meta = JSON.parse(fs.readFileSync(path.join(collabDir, 'bus-meta.json'), 'utf8'));
    assert.ok(meta.generation >= 1, 'generation not bumped after compact: ' + meta.generation);

    const idx = interestIndex.read(collabDir);
    assert.ok(!idx['phantom.js'], 'phantom.js should have been purged by rebuildInterestIndex callback');
  });

  it('force-compacts and clamps generation when bus-meta has CORRUPT_GENERATION (-1)', () => {
    writeContext(collabDir, 'sess-1', { task: 'work', files: [], status: 'in-progress' });

    // Plant the CORRUPT_GENERATION sentinel directly in bus-meta.json.
    fs.writeFileSync(
      path.join(collabDir, 'bus-meta.json'),
      JSON.stringify({ generation: -1, eventCount: 0, lastTs: 0 })
    );

    runHook({
      session_id: 'sess-1',
      cwd: tmpDir,
      tool_name: 'Read',
      tool_input: { file_path: path.join(tmpDir, 'x.js') }
    });

    const meta = JSON.parse(fs.readFileSync(path.join(collabDir, 'bus-meta.json'), 'utf8'));
    assert.ok(meta.generation >= 1, 'generation should be clamped to >=1 after force-compact, got ' + meta.generation);
  });
});
