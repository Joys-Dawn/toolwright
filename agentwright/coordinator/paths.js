'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const RUN_ID_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.-]*$/;
const STAGE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const SNAPSHOT_ROOT_NAME = 'agentwright-snapshots';

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

// Stable per-project key used to namespace the managed snapshot root.
// Concurrent audits in different projects share `os.tmpdir()/agentwright-snapshots/`
// — without per-project scoping, `cleanupOrphanedSnapshots` would only see the
// current cwd's runs and would treat every other project's in-flight snapshot
// as an orphan to delete. The slug is for human-readability when poking
// around the tmpdir; correctness comes from the sha256 of realpath(cwd).
// realpath collapses symlinked aliases so the same project always hashes to
// the same key. On Windows paths are case-insensitive, so we lowercase
// before hashing — otherwise `C:\Users\...` and `c:\users\...` would
// namespace independently.
function projectSnapshotKey(cwd) {
  let resolved;
  try {
    resolved = fs.realpathSync(cwd);
  } catch (_) {
    resolved = path.resolve(cwd);
  }
  const normForHash = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  const hash = crypto.createHash('sha256').update(normForHash).digest('hex').slice(0, 12);
  const slug = path.basename(resolved).replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 32) || 'project';
  return `${slug}-${hash}`;
}

function getManagedSnapshotRoot(cwd) {
  if (cwd === undefined || cwd === null) {
    throw new Error('getManagedSnapshotRoot requires a cwd argument.');
  }
  return path.join(os.tmpdir(), SNAPSHOT_ROOT_NAME, projectSnapshotKey(cwd));
}

// Claude Code stores each session's transcript under
// <config dir>/projects/<slug-of-cwd>/. The config dir is CLAUDE_CONFIG_DIR
// when set, otherwise ~/.claude (both verified empirically against the
// installed CLI). Spawned auditors run with cwd = a snapshot dir, so each
// run leaves a transcript dir here that Claude Code's own GC only reaps
// after 30 days — hence the cleanup hooks in run-ledger / snapshot-manager.
function getClaudeProjectsDir() {
  const configDir = (process.env.CLAUDE_CONFIG_DIR || '').trim() || path.join(os.homedir(), '.claude');
  return path.join(configDir, 'projects');
}

// Claude Code derives a project's transcript dir name by replacing every
// non-alphanumeric character of the absolute cwd with '-'. Verified
// first-party against on-disk ~/.claude/projects entries: case is preserved,
// consecutive separators are NOT collapsed (':' then '\' -> '--'), and '_'
// is replaced ('AI_engineering' -> 'AI-engineering'). agentwright snapshot
// paths are well under Claude Code's 200-char slug cap, so no hash suffix.
function claudeProjectSlug(absPath) {
  return String(absPath).replace(/[^a-zA-Z0-9]/g, '-');
}

// Slug prefix shared by every spawned-auditor transcript dir for THIS
// project. The managed snapshot root contains the literal
// 'agentwright-snapshots' segment plus a per-project sha256, so a dir whose
// slug starts with this prefix is unambiguously one of our auditor
// transcripts — it cannot collide with a real user project or another tool.
function managedSnapshotProjectSlugPrefix(cwd) {
  return claudeProjectSlug(getManagedSnapshotRoot(cwd)) + '-';
}

function expectedGroupSnapshotPath(cwd, runId, groupIndex) {
  return path.join(getManagedSnapshotRoot(cwd), `${validateRunId(runId)}-group-${groupIndex}`);
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
  SNAPSHOT_ROOT_NAME,
  validateRunId,
  validateStageName,
  assertPathWithin,
  projectSnapshotKey,
  getManagedSnapshotRoot,
  getClaudeProjectsDir,
  claudeProjectSlug,
  managedSnapshotProjectSlugPrefix,
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
