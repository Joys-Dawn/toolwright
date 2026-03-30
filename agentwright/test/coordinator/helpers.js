'use strict';

const fs = require('fs');
const path = require('path');

const { createRun, updateStageStatus, updateGroupStatus } = require('../../coordinator/run-ledger');
const {
  stageMetaFile,
  stageFindingsQueueFile,
  stageDecisionsFile,
  stageVerifierFile,
  groupSnapshotFile,
  expectedGroupSnapshotPath
} = require('../../coordinator/paths');
const { writeJson } = require('../../coordinator/io');

/**
 * Creates a run in the awaiting_verification_completion state, ready for completeStage.
 * @param {string} tmpDir - Temporary directory acting as cwd.
 * @param {string} stageName - Stage name (must be a known builtin).
 * @param {{ findingsCount?: number }} [opts]
 * @returns {{ runId: string, created: object }}
 */
function setupRunForCompletion(tmpDir, stageName, opts = {}) {
  const spec = {
    pipelineName: null,
    groups: [[stageName]],
    stages: [stageName],
    scope: '--diff'
  };
  const created = createRun(tmpDir, spec);
  const runId = created.runId;

  updateStageStatus(tmpDir, runId, stageName, 'awaiting_verification_completion', {
    auditorExitCode: 0,
    findingsCount: opts.findingsCount || 0
  });
  updateGroupStatus(tmpDir, runId, 0, 'auditing');

  writeJson(stageMetaFile(tmpDir, runId, stageName), {
    stage: stageName,
    status: 'done',
    auditDone: true,
    auditSucceeded: true,
    emittedCount: opts.findingsCount || 0,
    auditorExitCode: 0,
    updatedAt: new Date().toISOString()
  });

  const queuePath = stageFindingsQueueFile(tmpDir, runId, stageName);
  fs.mkdirSync(path.dirname(queuePath), { recursive: true });
  fs.writeFileSync(queuePath, '', 'utf8');

  const snapshotPath = expectedGroupSnapshotPath(runId, 0);
  fs.mkdirSync(snapshotPath, { recursive: true });
  writeJson(groupSnapshotFile(tmpDir, runId, 0), {
    type: 'temp-copy',
    path: snapshotPath,
    createdAt: new Date().toISOString()
  });

  return { runId, created };
}

/**
 * Initializes stage files for a worker run (queue, meta, verifier, decisions).
 * @param {string} tmpDir - Temporary directory acting as cwd.
 * @param {string} runId - Run identifier.
 * @param {string} stageName - Stage name.
 */
function initializeStageFilesForWorker(tmpDir, runId, stageName) {
  const queuePath = stageFindingsQueueFile(tmpDir, runId, stageName);
  fs.mkdirSync(path.dirname(queuePath), { recursive: true });
  fs.writeFileSync(queuePath, '', 'utf8');
  writeJson(stageMetaFile(tmpDir, runId, stageName), {
    stage: stageName,
    status: 'preparing_snapshot',
    auditDone: false,
    emittedCount: 0
  });
  writeJson(stageVerifierFile(tmpDir, runId, stageName), {
    stage: stageName,
    lastConsumedIndex: 0,
    processedFindingIds: [],
    fixedCount: 0,
    invalidCount: 0,
    deferredCount: 0
  });
  writeJson(stageDecisionsFile(tmpDir, runId, stageName), {
    stage: stageName,
    decisions: []
  });
  updateStageStatus(tmpDir, runId, stageName, 'auditing', { findingsCount: 0 });
}

module.exports = {
  setupRunForCompletion,
  initializeStageFilesForWorker
};
