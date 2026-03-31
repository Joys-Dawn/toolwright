'use strict';

const fs = require('fs');
const path = require('path');
const {
  groupSnapshotFile,
  stageFindingsQueueFile,
  stageDecisionsFile,
  stageMetaFile,
  stageVerifierFile,
  stageLogsDir
} = require('./paths');
const { writeJson } = require('./io');

function buildStageResponse(cwd, run, currentStage, extra = {}) {
  return {
    ok: true,
    runId: run.runId,
    currentStage: currentStage.name,
    scope: run.scope,
    status: currentStage.status,
    findingsQueueFile: stageFindingsQueueFile(cwd, run.runId, currentStage.name),
    decisionsFile: stageDecisionsFile(cwd, run.runId, currentStage.name),
    metaFile: stageMetaFile(cwd, run.runId, currentStage.name),
    verifierFile: stageVerifierFile(cwd, run.runId, currentStage.name),
    snapshotFile: groupSnapshotFile(cwd, run.runId, currentStage.groupIndex),
    logsDir: stageLogsDir(cwd, run.runId, currentStage.name),
    ...extra
  };
}

function buildGroupResponse(cwd, run, currentGroup, extra = {}) {
  const activeStages = currentGroup.stages.map(stageName => {
    const stage = run.stages.find(s => s.name === stageName);
    return buildStageResponse(cwd, run, stage, {
      groupIndex: currentGroup.index
    });
  });
  const response = {
    ok: true,
    runId: run.runId,
    scope: run.scope,
    currentGroupIndex: currentGroup.index,
    activeStages,
    groupSnapshotFile: groupSnapshotFile(cwd, run.runId, currentGroup.index),
    ...extra
  };
  if (activeStages.length === 1) {
    response.currentStage = activeStages[0].currentStage;
  }
  return response;
}

function initializeStageFiles(cwd, run, stageName, groupIndex) {
  const queuePath = stageFindingsQueueFile(cwd, run.runId, stageName);
  fs.mkdirSync(path.dirname(queuePath), { recursive: true });
  fs.writeFileSync(queuePath, '', 'utf8');
  writeJson(stageMetaFile(cwd, run.runId, stageName), {
    stage: stageName,
    status: 'preparing_snapshot',
    groupIndex,
    auditDone: false,
    emittedCount: 0,
    snapshotFile: path.basename(groupSnapshotFile(cwd, run.runId, groupIndex)),
    findingsQueueFile: path.basename(queuePath),
    verifierFile: path.basename(stageVerifierFile(cwd, run.runId, stageName)),
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  writeJson(stageVerifierFile(cwd, run.runId, stageName), {
    stage: stageName,
    lastConsumedIndex: 0,
    processedFindingIds: [],
    fixedCount: 0,
    invalidCount: 0,
    deferredCount: 0,
    updatedAt: new Date().toISOString()
  });
  writeJson(stageDecisionsFile(cwd, run.runId, stageName), {
    stage: stageName,
    decisions: []
  });
}

module.exports = {
  buildStageResponse,
  buildGroupResponse,
  initializeStageFiles
};
