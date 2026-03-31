'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const RUN_ID_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.-]*$/;
const STAGE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

function validateRunId(runId) {
  if (typeof runId !== 'string' || !RUN_ID_PATTERN.test(runId)) {
    throw new Error(`Invalid run ID: ${runId}`);
  }
  return runId;
}

function validateStageName(stageName) {
  if (typeof stageName !== 'string' || !STAGE_NAME_PATTERN.test(stageName)) {
    throw new Error(`Invalid stage name: ${stageName}`);
  }
  return stageName;
}

function assertPathWithin(basePath, targetPath, label) {
  const resolvedBase = fs.existsSync(basePath) ? fs.realpathSync(basePath) : path.resolve(basePath);
  const resolvedTarget = fs.existsSync(targetPath) ? fs.realpathSync(targetPath) : path.resolve(targetPath);
  const relative = path.relative(resolvedBase, resolvedTarget);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${label} escaped the managed directory.`);
  }
  return resolvedTarget;
}

function getManagedSnapshotRoot() {
  return path.join(os.tmpdir(), 'agentwright-snapshots');
}

function expectedGroupSnapshotPath(runId, groupIndex) {
  return path.join(getManagedSnapshotRoot(), `${validateRunId(runId)}-group-${groupIndex}`);
}

function ensureAuditBase(cwd) {
  const claudeDir = path.join(cwd, '.claude');
  const runsDir = path.join(claudeDir, 'audit-runs');
  fs.mkdirSync(runsDir, { recursive: true });
  return runsDir;
}

function runDir(cwd, runId) {
  return path.join(ensureAuditBase(cwd), validateRunId(runId));
}

function runFile(cwd, runId) {
  return path.join(runDir(cwd, runId), 'run.json');
}

function summaryFile(cwd, runId) {
  return path.join(runDir(cwd, runId), 'summary.json');
}

function groupSnapshotFile(cwd, runId, groupIndex) {
  return path.join(runDir(cwd, runId), `group-${groupIndex}-snapshot.json`);
}

function stageDir(cwd, runId, stageName) {
  return path.join(runDir(cwd, runId), 'stages', validateStageName(stageName));
}

function stageFindingsQueueFile(cwd, runId, stageName) {
  return path.join(stageDir(cwd, runId, stageName), 'findings.jsonl');
}

function stageDecisionsFile(cwd, runId, stageName) {
  return path.join(stageDir(cwd, runId, stageName), 'decisions.json');
}

function stageMetaFile(cwd, runId, stageName) {
  return path.join(stageDir(cwd, runId, stageName), 'meta.json');
}

function stageVerifierFile(cwd, runId, stageName) {
  return path.join(stageDir(cwd, runId, stageName), 'verifier.json');
}

function stageLogsDir(cwd, runId, stageName) {
  return path.join(stageDir(cwd, runId, stageName), 'logs');
}

module.exports = {
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
};
