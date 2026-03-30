'use strict';

const { loadRun, mutateRun, updateStageStatus } = require('./run-ledger');
const { validateStageName, stageMetaFile } = require('./paths');
const { writeJson, readJson } = require('./io');

function isPidAlive(pid) {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) {
    return false;
  }
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (error) {
    return false;
  }
}

function markDeadStageWorkers(cwd, run) {
  const freshRun = loadRun(cwd, run.runId);
  const auditor = freshRun.auditor && typeof freshRun.auditor === 'object' ? freshRun.auditor : {};
  const stageNames = Object.keys(auditor);
  const deadStages = [];
  for (const stageName of stageNames) {
    try {
      validateStageName(stageName);
      const info = auditor[stageName];
      if (!info || isPidAlive(info.workerPid) || isPidAlive(info.pid)) {
        continue;
      }
      const stageMetaPath = stageMetaFile(cwd, run.runId, stageName);
      const stageMeta = readJson(stageMetaPath, {});
      if (stageMeta.auditDone || stageMeta.error) {
        continue;
      }
      deadStages.push({
        stageName,
        emittedCount: Number(stageMeta.emittedCount || 0),
        metaPath: stageMetaPath,
        existingMeta: stageMeta
      });
    } catch (error) {
      continue;
    }
  }
  if (deadStages.length > 0) {
    mutateRun(cwd, run.runId, currentRun => {
      for (const { stageName, emittedCount, metaPath, existingMeta } of deadStages) {
        // Write meta inside the lock to prevent two callers racing on the same meta file
        writeJson(metaPath, {
          ...existingMeta,
          stage: stageName,
          status: 'failed',
          auditDone: true,
          auditSucceeded: false,
          error: true,
          summary: 'Worker died before completing the audit.',
          auditorExitCode: 1,
          updatedAt: new Date().toISOString()
        });
        const stage = currentRun.stages.find(s => s.name === stageName);
        if (stage) {
          Object.assign(stage, {
            status: 'audit_failed',
            auditorExitCode: 1,
            findingsCount: emittedCount
          });
        }
        if (currentRun.auditor && typeof currentRun.auditor === 'object') {
          delete currentRun.auditor[stageName];
          if (Object.keys(currentRun.auditor).length === 0) {
            currentRun.auditor = null;
          }
        }
      }
      return currentRun;
    });
  }
  return deadStages.map(dead => dead.stageName);
}

module.exports = {
  isPidAlive,
  markDeadStageWorkers
};
