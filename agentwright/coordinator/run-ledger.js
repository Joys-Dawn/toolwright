'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const { writeJson, readJson, readJsonLines, appendJsonLine, removePath } = require('./io');
const {
  RUN_ID_PATTERN,
  validateRunId,
  validateStageName,
  assertPathWithin,
  getManagedSnapshotRoot,
  expectedGroupSnapshotPath,
  ensureAuditBase,
  runDir,
  runFile,
  summaryFile,
  groupSnapshotFile,
  stageDir,
  stageFindingsQueueFile,
  stageDecisionsFile,
  stageMetaFile,
  stageVerifierFile,
  stageLogsDir
} = require('./paths');

const LOCK_STALE_MS = 30 * 1000;
const LOCK_TIMEOUT_MS = 10 * 1000;

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function runLockDir(cwd, runId) {
  return `${runFile(cwd, runId)}.lock`;
}

function acquireRunLock(cwd, runId) {
  const lockDir = runLockDir(cwd, runId);
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      fs.mkdirSync(lockDir, { recursive: false });
      fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({
        pid: process.pid,
        acquiredAt: new Date().toISOString()
      }), 'utf8');
      return lockDir;
    } catch (error) {
      if (error.code !== 'EEXIST') {
        throw error;
      }
      try {
        const stat = fs.statSync(lockDir);
        if ((Date.now() - stat.mtimeMs) > LOCK_STALE_MS) {
          const staleLockDir = `${lockDir}.stale-${process.pid}-${Date.now()}`;
          fs.renameSync(lockDir, staleLockDir);
          fs.rmSync(staleLockDir, { recursive: true, force: true });
          continue;
        }
      } catch (statError) {
        continue;
      }
      sleepMs(50 + Math.random() * 50);
    }
  }
  throw new Error(`Timed out waiting for run lock: ${runId}`);
}

function releaseRunLock(lockDir) {
  fs.rmSync(lockDir, { recursive: true, force: true });
}

/**
 * Executes callback while holding an exclusive file-system lock for the given run.
 * The lock is always released after callback completes, even on error.
 * @param {string} cwd - Project working directory.
 * @param {string} runId - Run identifier (validated).
 * @param {() => *} callback - Function to execute under the lock.
 * @returns {*} The return value of callback.
 */
function withRunLock(cwd, runId, callback) {
  const safeRunId = validateRunId(runId);
  const lockDir = acquireRunLock(cwd, safeRunId);
  try {
    return callback();
  } finally {
    releaseRunLock(lockDir);
  }
}

/**
 * Atomically reads, mutates, and writes a run under a file-system lock.
 * The callback receives the current run object and may mutate it in place
 * (return undefined) or return a replacement. updatedAt is set automatically.
 * @param {string} cwd - Project working directory.
 * @param {string} runId - Run identifier.
 * @param {(run: object) => object|void} callback - Mutation function.
 * @returns {object} The persisted run object.
 */
function mutateRun(cwd, runId, callback) {
  return withRunLock(cwd, runId, () => {
    const run = readJson(runFile(cwd, runId));
    if (!run) {
      throw new Error(`Unknown run ID: ${runId}`);
    }
    const result = callback(run);
    const nextRun = result === undefined ? run : result;
    nextRun.updatedAt = new Date().toISOString();
    writeJson(runFile(cwd, runId), nextRun);
    return nextRun;
  });
}

function removeSnapshotFromFile(cwd, snapshotFilePath) {
  const snapshot = readJson(snapshotFilePath);
  const managedRoot = getManagedSnapshotRoot();
  const snapshotFileName = path.basename(snapshotFilePath);
  const groupMatch = /^group-(\d+)-snapshot\.json$/.exec(snapshotFileName);
  const runId = path.basename(path.dirname(snapshotFilePath));
  const expectedPath = groupMatch ? expectedGroupSnapshotPath(runId, Number(groupMatch[1])) : null;
  if (snapshot?.type === 'git-worktree' && snapshot.path) {
    assertPathWithin(managedRoot, snapshot.path, 'Snapshot path');
    if (expectedPath && path.resolve(snapshot.path) !== path.resolve(expectedPath)) {
      throw new Error('Snapshot path did not match the expected run/group location.');
    }
    const wtResult = spawnSync('git', ['worktree', 'remove', '--force', snapshot.path], {
      cwd,
      encoding: 'utf8'
    });
    if (wtResult.status !== 0) {
      const msg = (wtResult.stderr || '').trim();
      if (fs.existsSync(snapshot.path)) {
        removePath(snapshot.path);
      }
      if (fs.existsSync(snapshot.path)) {
        throw new Error(`Failed to remove git worktree at ${snapshot.path}: ${msg}`);
      }
    }
    return;
  }
  if (snapshot?.path) {
    assertPathWithin(managedRoot, snapshot.path, 'Snapshot path');
    if (expectedPath && path.resolve(snapshot.path) !== path.resolve(expectedPath)) {
      throw new Error('Snapshot path did not match the expected run/group location.');
    }
    removePath(snapshot.path);
    return;
  }
  if (expectedPath && fs.existsSync(expectedPath)) {
    assertPathWithin(managedRoot, expectedPath, 'Snapshot path');
    removePath(expectedPath);
  }
}

function removeGroupSnapshot(cwd, runId, groupIndex) {
  removeSnapshotFromFile(cwd, groupSnapshotFile(cwd, runId, groupIndex));
}

function makeRunId() {
  return `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(4).toString('hex')}`;
}

/**
 * Creates a new run, persists run.json and summary.json, and returns the run object.
 * @param {string} cwd - Project working directory.
 * @param {{ pipelineName: string|null, groups: string[][], stages: string[], scope: string }} spec
 * @returns {object} The created run with a generated runId.
 */
function createRun(cwd, spec) {
  const runId = makeRunId();
  const dir = runDir(cwd, runId);
  fs.mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  const run = {
    runId,
    cwd,
    scope: spec.scope,
    pipelineName: spec.pipelineName,
    groups: spec.groups.map((group, index) => ({
      index,
      stages: group.slice(),
      status: 'pending',
      snapshotFile: path.basename(groupSnapshotFile(cwd, runId, index))
    })),
    stages: spec.stages.map(name => ({
      groupIndex: spec.groups.findIndex(group => group.includes(name)),
      name,
      status: 'pending',
      stageDir: path.relative(runDir(cwd, runId), stageDir(cwd, runId, name)),
      snapshotFile: path.basename(groupSnapshotFile(cwd, runId, spec.groups.findIndex(group => group.includes(name))))
    })),
    currentGroupIndex: 0,
    activeStages: spec.groups[0] ? spec.groups[0].slice() : [],
    auditor: null,
    createdAt: now,
    updatedAt: now,
    status: 'running'
  };
  writeJson(runFile(cwd, runId), run);
  writeJson(summaryFile(cwd, runId), {
    runId,
    scope: spec.scope,
    completedStages: [],
    rejectedFindings: [],
    pendingApprovals: []
  });
  return run;
}

function loadRun(cwd, runId) {
  validateRunId(runId);
  const run = readJson(runFile(cwd, runId));
  if (!run) {
    throw new Error(`Unknown run ID: ${runId}`);
  }
  return run;
}

function getCurrentStage(run) {
  const currentGroup = getCurrentGroup(run);
  if (!currentGroup) {
    return null;
  }
  return currentGroup.stages
    .map(stageName => run.stages.find(stage => stage.name === stageName))
    .find(stage => stage && stage.status !== 'completed') || null;
}

function getCurrentGroup(run) {
  return run.groups[run.currentGroupIndex] || null;
}

function updateStageStatus(cwd, runId, stageName, status, extra = {}) {
  return mutateRun(cwd, runId, currentRun => {
    const stage = currentRun.stages.find(s => s.name === stageName);
    if (!stage) {
      throw new Error(`Unknown stage in run: ${stageName}`);
    }
    Object.assign(stage, extra, { status });
    return currentRun;
  });
}

function updateGroupStatus(cwd, runId, groupIndex, status, extra = {}) {
  return mutateRun(cwd, runId, currentRun => {
    const group = currentRun.groups.find(g => g.index === groupIndex);
    if (!group) {
      throw new Error(`Unknown group in run: ${groupIndex}`);
    }
    Object.assign(group, extra, { status });
    return currentRun;
  });
}

function listRuns(cwd) {
  const base = ensureAuditBase(cwd);
  return fs.readdirSync(base, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !entry.isSymbolicLink())
    .filter(entry => RUN_ID_PATTERN.test(entry.name))
    .map(entry => {
      const run = readJson(runFile(cwd, entry.name));
      return run ? { runId: entry.name, run } : null;
    })
    .filter(Boolean);
}

function cleanupCompletedStageArtifacts(cwd, runId, stageName, retention) {
  if (retention.deleteCompletedLogs) {
    removePath(stageLogsDir(cwd, runId, stageName));
  }
  if (retention.deleteCompletedFindings) {
    removePath(stageFindingsQueueFile(cwd, runId, stageName));
  }
}

function cleanupCompletedGroupArtifacts(cwd, runId, groupIndex) {
  removeGroupSnapshot(cwd, runId, groupIndex);
}

/**
 * Removes completed runs that exceed the retention policy (age or count).
 * Snapshots are cleaned up before the run directory is deleted.
 * Individual failures are swallowed so one broken run doesn't block others.
 * @param {string} cwd - Project working directory.
 * @param {{ keepCompletedRuns: number, maxRunAgeDays: number }} retention
 * @param {{ excludeRunIds?: string[] }} [options]
 * @returns {string[]} Array of removed run IDs.
 */
function pruneCompletedRuns(cwd, retention, options = {}) {
  const now = Date.now();
  const maxAgeMs = Number(retention.maxRunAgeDays || 0) * 24 * 60 * 60 * 1000;
  const excludeRunIds = new Set(options.excludeRunIds || []);
  const completedRuns = listRuns(cwd)
    .filter(entry => entry.run.status === 'completed')
    .sort((a, b) => {
      const parse = (d) => { const ms = Date.parse(d); return Number.isFinite(ms) ? ms : 0; };
      return parse(b.run.updatedAt || b.run.createdAt) - parse(a.run.updatedAt || a.run.createdAt);
    });

  const keepIds = new Set(
    completedRuns
      .slice(0, Math.max(0, Number(retention.keepCompletedRuns || 0)))
      .map(entry => entry.runId)
  );

  const removed = [];
  for (const entry of completedRuns) {
    if (excludeRunIds.has(entry.runId)) {
      continue;
    }
    const updatedAt = Date.parse(entry.run.updatedAt || entry.run.createdAt || '1970-01-01T00:00:00Z');
    const tooOld = maxAgeMs > 0 && Number.isFinite(updatedAt) && (now - updatedAt) > maxAgeMs;
    const overKeepLimit = !keepIds.has(entry.runId);
    if (tooOld || overKeepLimit) {
      try {
        for (const group of entry.run.groups || []) {
          try {
            removeGroupSnapshot(cwd, entry.runId, group.index);
          } catch (snapshotError) {
            // Continue cleaning other groups even if one snapshot removal fails
          }
        }
        removePath(runDir(cwd, entry.runId));
        removed.push(entry.runId);
      } catch (runError) {
        // Skip this run — will be retried on next prune
      }
    }
  }
  return removed;
}

/**
 * Loads a run and overlays live progress from per-stage meta files.
 * Stages in 'auditing' status get their findingsCount and status updated
 * from the meta file, synthesizing 'fixing_live' when findings have been emitted.
 * This avoids the need for stage-workers to write to run.json on every finding,
 * eliminating lock contention between parallel workers.
 */
function loadRunWithLiveStatus(cwd, runId) {
  const run = loadRun(cwd, runId);
  for (const stage of run.stages) {
    if (stage.status !== 'auditing') continue;
    const meta = readJson(stageMetaFile(cwd, runId, stage.name), null);
    if (!meta) continue;
    const emitted = Number(meta.emittedCount || 0);
    if (emitted > 0) {
      stage.status = 'fixing_live';
      stage.findingsCount = emitted;
    }
  }
  return run;
}

module.exports = {
  withRunLock,
  mutateRun,
  createRun,
  loadRun,
  loadRunWithLiveStatus,
  getCurrentStage,
  getCurrentGroup,
  updateStageStatus,
  updateGroupStatus,
  listRuns,
  cleanupCompletedStageArtifacts,
  cleanupCompletedGroupArtifacts,
  pruneCompletedRuns
};
