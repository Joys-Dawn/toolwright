'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const { createRun, loadRun, updateStageStatus, updateGroupStatus, mutateRun } = require('../../coordinator/run-ledger');
const {
  groupSnapshotFile,
  stageMetaFile,
  stageFindingsQueueFile,
  stageDecisionsFile,
  stageVerifierFile,
  stageLogsDir,
  getManagedSnapshotRoot,
  expectedGroupSnapshotPath
} = require('../../coordinator/paths');
const { writeJson, readJson, readJsonLines } = require('../../coordinator/io');

const { createGroupSnapshot } = require('../../coordinator/snapshot-manager');
const { spawnAuditor } = require('../../coordinator/process-manager');
const { initializeStageFilesForWorker } = require('./helpers');

const COORDINATOR = path.resolve(__dirname, '../../coordinator/index.js');
const WORKER = path.resolve(__dirname, '../../coordinator/stage-worker.js');
const PLUGIN_ROOT = path.resolve(__dirname, '../../');

describe('integration: real auditor', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'integration-test-'));
    // Create a tiny file for the auditor to inspect
    fs.writeFileSync(path.join(tmpDir, 'example.js'), [
      'function add(a, b) {',
      '  return a + b;',
      '}',
      'module.exports = { add };'
    ].join('\n'), 'utf8');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('spawnAuditor produces structured output and terminates', { timeout: 120000 }, async () => {
    const logsDir = path.join(tmpDir, 'logs');
    const events = [];

    const worker = spawnAuditor({
      cwd: tmpDir,
      pluginRoot: PLUGIN_ROOT,
      prompt: [
        'Audit stage: test-stage',
        'Scope: example.js',
        'You are auditing a tiny file. Output newline-delimited JSON only.',
        'Emit one finding or zero findings.',
        'Finding line format: {"type":"finding","finding":{"id":"test-1","severity":"low","title":"...","file":"example.js","problem":"...","fix":"..."}}',
        'When done, emit exactly one final line: {"type":"done","auditType":"test-stage","summary":"...","emittedCount":0}',
        'Do not emit markdown or prose. Only JSON lines.'
      ].join('\n'),
      logsDir,
      runId: 'integration-test',
      stageName: 'test-stage',
      onEvent(event) {
        events.push(event);
      }
    });

    assert.ok(worker.pid);
    assert.ok(typeof worker.wait === 'function');
    assert.ok(typeof worker.kill === 'function');

    const result = await worker.wait();

    // The auditor should exit cleanly
    assert.equal(result.exitCode, 0);

    // Should have received at least heartbeat events from the stream
    assert.ok(events.length > 0, `Expected events but got ${events.length}`);

    // Should have a done event (either from stream or synthesized)
    const doneEvents = events.filter(e => e.type === 'done');
    assert.ok(doneEvents.length >= 1 || result.doneEvent, 'Should have at least one done event');

    // Logs should have been written
    assert.ok(fs.existsSync(path.join(logsDir, 'auditor.stdout.log')));
    assert.ok(fs.existsSync(path.join(logsDir, 'auditor.stderr.log')));
  });

  it('stage-worker end-to-end: spawns auditor, writes findings and meta', { timeout: 180000 }, () => {
    // Create a run
    const run = createRun(tmpDir, {
      pipelineName: null,
      groups: [['correctness']],
      stages: ['correctness'],
      scope: 'example.js'
    });

    // Create a real snapshot
    const snapshot = createGroupSnapshot(tmpDir, run.runId, 0);

    // Initialize stage files
    initializeStageFilesForWorker(tmpDir, run.runId, 'correctness');

    // Run the stage worker synchronously
    const result = spawnSync('node', [
      WORKER,
      '--run', run.runId,
      '--stage', 'correctness',
      '--group-index', '0'
    ], {
      cwd: tmpDir,
      encoding: 'utf8',
      timeout: 180000
    });

    // Worker should complete (exit 0 or 1 depending on findings)
    assert.ok(result.status === 0 || result.status === 1, `Unexpected exit code: ${result.status}`);

    // Meta file should be updated with auditDone: true
    const meta = readJson(stageMetaFile(tmpDir, run.runId, 'correctness'));
    assert.ok(meta, 'Meta file should exist');
    assert.equal(meta.auditDone, true, 'Audit should be marked done');
    assert.ok(typeof meta.emittedCount === 'number');
    assert.ok(meta.summary, 'Summary should be present');

    // Queue file should have been written with JSONL entries
    const queueLines = readJsonLines(stageFindingsQueueFile(tmpDir, run.runId, 'correctness'));
    const findingLines = queueLines.filter(l => l.type === 'finding');
    assert.equal(findingLines.length, meta.emittedCount);

    // Each finding in the queue should have a unique ID
    const ids = new Set(findingLines.map(l => l.finding?.id));
    assert.equal(ids.size, findingLines.length, 'Finding IDs should be unique');

    // Stage status should be updated
    const updatedRun = loadRun(tmpDir, run.runId);
    const stage = updatedRun.stages.find(s => s.name === 'correctness');
    assert.ok(
      stage.status === 'awaiting_verification_completion' || stage.status === 'audit_failed',
      `Stage should be awaiting_verification_completion or audit_failed, got: ${stage.status}`
    );

    // Auditor entry should be cleaned up
    assert.ok(!updatedRun.auditor || !updatedRun.auditor.correctness, 'Auditor entry should be cleaned up after completion');

    // Logs should exist
    const logsPath = stageLogsDir(tmpDir, run.runId, 'correctness');
    assert.ok(fs.existsSync(logsPath), 'Logs directory should exist');
    assert.ok(fs.existsSync(path.join(logsPath, 'auditor.stdout.log')));

    // Clean up snapshot
    if (snapshot.type === 'git-worktree') {
      spawnSync('git', ['worktree', 'remove', '--force', snapshot.path], { cwd: tmpDir });
    }
    fs.rmSync(snapshot.path, { recursive: true, force: true });
  });
});
