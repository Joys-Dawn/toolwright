'use strict';

const path = require('path');
const { spawn } = require('child_process');
const { resolveStageDefinition, loadUserConfig } = require('./pipeline');
const {
  loadRun,
  getCurrentGroup,
  mutateRun,
  withRunLock,
  updateStageStatus,
  updateGroupStatus,
  cleanupCompletedStageArtifacts,
  cleanupCompletedGroupArtifacts,
  pruneTerminalRuns
} = require('./run-ledger');
const {
  validateRunId,
  validateStageName,
  groupSnapshotFile,
  stageDecisionsFile,
  stageMetaFile,
  stageLogsDir,
  runFile
} = require('./paths');
const { writeJson, readJson } = require('./io');
const { createGroupSnapshot } = require('./snapshot-manager');
const { isPidAlive, markDeadStageWorkers } = require('./health-check');
const { buildGroupResponse, initializeStageFiles } = require('./responses');
const { validateDecisions, updateSummary } = require('./decisions');

function validateCompletionResult(result) {
  const normalized = result || 'accepted';
  const allowed = new Set(['accepted', 'rejected', 'approval']);
  if (!allowed.has(normalized)) {
    throw new Error(`Invalid completion result: ${normalized}`);
  }
  return normalized;
}

function tryAdvanceGroup(lockedRun) {
  const lockedGroup = getCurrentGroup(lockedRun);
  const groupFinished = lockedGroup && lockedGroup.stages.every(name => {
    const stage = lockedRun.stages.find(s => s.name === name);
    return stage && stage.status === 'completed';
  });
  if (!groupFinished || lockedGroup.status === 'completed') {
    return { groupCompleted: false, completedGroupIndex: null };
  }
  lockedGroup.status = 'completed';
  const completedGroupIndex = lockedGroup.index;
  lockedRun.currentGroupIndex += 1;
  lockedRun.activeStages = [];
  if (lockedRun.currentGroupIndex >= lockedRun.groups.length) {
    lockedRun.status = 'completed';
  }
  return { groupCompleted: true, completedGroupIndex };
}

async function launchCurrentGroup(cwd, run) {
  markDeadStageWorkers(cwd, run);
  run = loadRun(cwd, run.runId);
  const currentGroup = getCurrentGroup(run);
  if (!currentGroup) {
    throw new Error('Pipeline resolved to zero stages.');
  }
  const groupStages = currentGroup.stages.map(stageName => run.stages.find(stage => stage.name === stageName));
  if (groupStages.some(stage => !stage || stage.status !== 'pending')) {
    return buildGroupResponse(cwd, run, currentGroup, {
      stageAlreadyActive: true
    });
  }

  for (const stage of groupStages) {
    const stageDef = resolveStageDefinition(stage.name, cwd);
    if (!stageDef || stageDef.type !== 'skill') {
      throw new Error(`Stage ${stage.name} is not configured as a skill stage.`);
    }
  }

  const snapshot = createGroupSnapshot(cwd, run.runId, currentGroup.index);
  updateGroupStatus(cwd, run.runId, currentGroup.index, 'auditing', {
    snapshotFile: path.basename(groupSnapshotFile(cwd, run.runId, currentGroup.index)),
    snapshotPath: snapshot.path
  });
  const workerPids = {};
  const auditor = {};
  const spawnedWorkers = [];
  for (const stage of groupStages) {
    initializeStageFiles(cwd, run, stage.name, currentGroup.index);
    updateStageStatus(cwd, run.runId, stage.name, 'auditing', {
      findingsCount: 0
    });
    let worker;
    try {
      worker = spawn(process.execPath, [
        path.join(__dirname, 'stage-worker.js'),
        '--run',
        run.runId,
        '--stage',
        stage.name,
        '--group-index',
        String(currentGroup.index)
      ], {
        cwd,
        detached: true,
        stdio: 'ignore',
        windowsHide: true
      });
    } catch (spawnError) {
      for (const prev of spawnedWorkers) {
        try { process.kill(prev.pid); } catch (_) {}
      }
      const failedStageNames = spawnedWorkers.map(prev => prev.stage);
      failedStageNames.push(stage.name);
      mutateRun(cwd, run.runId, current => {
        for (const name of failedStageNames) {
          const s = current.stages.find(stage => stage.name === name);
          if (s) {
            Object.assign(s, { status: 'pending', auditorExitCode: undefined, findingsCount: undefined });
          }
          if (current.auditor && typeof current.auditor === 'object') {
            delete current.auditor[name];
            if (Object.keys(current.auditor).length === 0) {
              current.auditor = null;
            }
          }
        }
        const group = current.groups.find(g => g.index === currentGroup.index);
        if (group) {
          group.status = 'pending';
        }
        return current;
      });
      throw spawnError;
    }
    worker.unref();
    spawnedWorkers.push({ pid: worker.pid, stage: stage.name });
    workerPids[stage.name] = worker.pid;
    auditor[stage.name] = {
      workerPid: worker.pid,
      stage: stage.name,
      groupIndex: currentGroup.index,
      logsDir: stageLogsDir(cwd, run.runId, stage.name),
      snapshotPath: snapshot.path
    };
  }
  const mutatedRun = mutateRun(cwd, run.runId, current => {
    const nextAuditor = current.auditor && typeof current.auditor === 'object' ? { ...current.auditor } : {};
    for (const [name, info] of Object.entries(auditor)) {
      nextAuditor[name] = info;
    }
    current.auditor = nextAuditor;
    current.activeStages = currentGroup.stages.slice();
    return current;
  });
  return buildGroupResponse(cwd, mutatedRun, getCurrentGroup(mutatedRun), {
    stageWorkerPids: workerPids
  });
}

function completeStage(runId, stageName, result) {
  const cwd = process.cwd();
  validateRunId(runId);
  validateStageName(stageName);
  const completionResult = validateCompletionResult(result);
  const retention = loadUserConfig(cwd).retention;
  let run = loadRun(cwd, runId);
  markDeadStageWorkers(cwd, run);
  const decisionsPath = stageDecisionsFile(cwd, runId, stageName);
  let groupCompleted = false;
  let completedGroupIndex = null;
  let nextGroup = null;
  let finalRunStatus = 'running';
  withRunLock(cwd, runId, () => {
    const lockedRun = loadRun(cwd, runId);
    const currentGroup = getCurrentGroup(lockedRun);
    if (!currentGroup || !currentGroup.stages.includes(stageName)) {
      throw new Error(`Stage ${stageName} is not in the current group for run ${runId}.`);
    }
    const currentStage = lockedRun.stages.find(stage => stage.name === stageName);
    if (currentStage.status !== 'awaiting_verification_completion') {
      throw new Error(`Stage ${stageName} is not ready for completion. Current status: ${currentStage.status}.`);
    }
    const meta = readJson(stageMetaFile(cwd, runId, stageName));
    const decisions = readJson(decisionsPath);
    if (!meta || !meta.auditDone) {
      throw new Error(`Stage ${stageName} is still auditing. Wait for the done marker before completing the stage.`);
    }
    if (meta.error || meta.auditSucceeded === false || Number(meta.auditorExitCode || 0) !== 0) {
      throw new Error(`Stage ${stageName} audit failed and cannot be completed. Review the stage logs and retry the stage.`);
    }
    if (!decisions || !Array.isArray(decisions.decisions)) {
      throw new Error(`Missing or invalid decisions file for stage ${stageName}: ${decisionsPath}`);
    }
    validateDecisions(cwd, runId, stageName, decisions);
    Object.assign(currentStage, {
      status: 'completed',
      verificationResult: completionResult,
      decisionsCount: decisions.decisions.length
    });
    updateSummary(cwd, runId, stageName, decisions, completionResult, lockedRun.scope);
    const advancement = tryAdvanceGroup(lockedRun);
    groupCompleted = advancement.groupCompleted;
    completedGroupIndex = advancement.completedGroupIndex;
    lockedRun.updatedAt = new Date().toISOString();
    finalRunStatus = lockedRun.status;
    nextGroup = getCurrentGroup(lockedRun);
    writeJson(runFile(cwd, runId), lockedRun);
  });
  cleanupCompletedStageArtifacts(cwd, runId, stageName, retention);
  if (groupCompleted && completedGroupIndex !== null) {
    cleanupCompletedGroupArtifacts(cwd, runId, completedGroupIndex, { keepFirst: true });
  }
  if (finalRunStatus === 'completed') {
    pruneTerminalRuns(cwd, retention, { excludeRunIds: [runId] });
  }
  return {
    ok: true,
    runId,
    completedStage: stageName,
    groupCompleted,
    nextGroup: nextGroup ? nextGroup.stages.slice() : null,
    decisionsFile: decisionsPath
  };
}

async function nextStage(runId) {
  const cwd = process.cwd();
  validateRunId(runId);
  let run = loadRun(cwd, runId);
  const recoveredFailedStages = markDeadStageWorkers(cwd, run);
  if (recoveredFailedStages.length > 0) {
    run = loadRun(cwd, runId);
  }
  if (run.status === 'completed') {
    return { ok: true, runId, nextGroup: null, status: run.status };
  }
  const currentGroup = getCurrentGroup(run);
  if (!currentGroup) {
    return { ok: true, runId, nextGroup: null, status: run.status };
  }
  const groupStages = currentGroup.stages.map(stageName => run.stages.find(stage => stage.name === stageName));
  const failedStages = groupStages.filter(stage => stage && stage.status === 'audit_failed').map(stage => stage.name);
  if (failedStages.length > 0) {
    return buildGroupResponse(cwd, run, currentGroup, {
      failedStages,
      stageAlreadyActive: false
    });
  }
  if (groupStages.some(stage => stage && stage.status !== 'pending')) {
    return buildGroupResponse(cwd, run, currentGroup, {
      stageAlreadyActive: true
    });
  }
  return launchCurrentGroup(cwd, run);
}

function stopRun(runId) {
  const cwd = process.cwd();
  validateRunId(runId);
  const killed = [];
  const finalRun = mutateRun(cwd, runId, current => {
    if (current.status === 'completed' || current.status === 'cancelled') {
      return current;
    }
    const auditor = current.auditor && typeof current.auditor === 'object' ? current.auditor : {};
    for (const [stageName, info] of Object.entries(auditor)) {
      if (info.workerPid && isPidAlive(info.workerPid)) {
        try {
          process.kill(Number(info.workerPid));
          killed.push({ stage: stageName, pid: info.workerPid, role: 'worker' });
        } catch (_) {}
      }
      if (info.pid && isPidAlive(info.pid)) {
        try {
          process.kill(Number(info.pid));
          killed.push({ stage: stageName, pid: info.pid, role: 'auditor' });
        } catch (_) {}
      }
    }
    for (const stage of current.stages) {
      if (stage.status !== 'completed') {
        stage.status = 'cancelled';
      }
    }
    for (const group of current.groups) {
      if (group.status !== 'completed') {
        group.status = 'cancelled';
      }
    }
    current.auditor = null;
    current.activeStages = [];
    current.status = 'cancelled';
    current.updatedAt = new Date().toISOString();
    return current;
  });
  return { ok: true, runId, status: finalRun.status, killed };
}

module.exports = {
  launchCurrentGroup,
  completeStage,
  nextStage,
  stopRun,
  tryAdvanceGroup,
  validateCompletionResult
};
