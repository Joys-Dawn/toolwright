'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let lockfile;
try {
  lockfile = require('proper-lockfile');
} catch (_) {
  lockfile = null;
}

const { writeJson, readJson, removePath } = require('./io');
const {
  WORKFLOW_ID_PATTERN,
  validateWorkflowId,
  validateWorkflowName,
  ensureWorkflowBase,
  workflowDir,
  workflowFile,
  artifactsDir,
} = require('./paths');

const TERMINAL_STATUSES = new Set(['completed', 'cancelled', 'failed']);
const LOCK_OPTIONS = {
  stale: 30 * 1000,
  retries: { retries: 20, factor: 1.3, minTimeout: 25, maxTimeout: 500 },
  realpath: false,
};

function requireLockfile() {
  if (!lockfile) {
    throw new Error(
      'forgewright requires the "proper-lockfile" npm package. ' +
      'Install dependencies: cd to the forgewright plugin directory and run `npm install`.'
    );
  }
  return lockfile;
}

function makeWorkflowId(workflowName) {
  validateWorkflowName(workflowName);
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const rand = crypto.randomBytes(4).toString('hex');
  return `${ts}-${workflowName}-${rand}`;
}

function defaultPhaseIdempotence(type) {
  // Per the plan: most phases default non-idempotent (re-running mutates state).
  // Checkpoints are read/notify-only, safe to re-display.
  if (type === 'checkpoint') return true;
  return false;
}

/**
 * Creates a new workflow from a definition (built-in or user-defined).
 * @param {string} cwd - Project working directory.
 * @param {{ workflowName: string, args: string, definition: { phases: Array }, busPresenceRequired: boolean }} spec
 * @returns {object} The created workflow object.
 */
function createWorkflow(cwd, spec) {
  validateWorkflowName(spec.workflowName);
  const workflowId = makeWorkflowId(spec.workflowName);
  ensureWorkflowBase(cwd);
  const dir = workflowDir(cwd, workflowId);
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(artifactsDir(cwd, workflowId), { recursive: true });

  const now = new Date().toISOString();
  // createWorkflow trusts that the caller (workflow-start) has already passed
  // the definition through validateWorkflowDefinition — which enforces shape
  // (object, non-empty phases, valid types, names, produces, consumes…). Any
  // re-validation here would duplicate that contract and rot independently.
  const phases = spec.definition.phases.map((rawPhase, index) => {
    const idempotent = typeof rawPhase.idempotent === 'boolean'
      ? rawPhase.idempotent
      : defaultPhaseIdempotence(rawPhase.type);
    return {
      ...rawPhase,
      index,
      status: 'pending',
      idempotent,
    };
  });

  const workflow = {
    workflowId,
    workflowName: spec.workflowName,
    args: spec.args || '',
    phases,
    currentPhaseIndex: 0,
    artifacts: {},
    reauditCycles: 0,
    // Effective reaudit / tests config, resolved at start time. Frozen here
    // so a later edit to .claude/forgewright.json or to the workflow definition
    // doesn't retroactively change a running workflow's behavior.
    reaudit: spec.reaudit || null,
    tests: spec.tests || null,
    busPresenceRequired: !!spec.busPresenceRequired,
    createdAt: now,
    updatedAt: now,
    status: 'pending',
  };

  // Initial write — no lock needed because the file does not yet exist.
  writeJson(workflowFile(cwd, workflowId), workflow);
  return workflow;
}

function loadWorkflow(cwd, workflowId) {
  validateWorkflowId(workflowId);
  const file = workflowFile(cwd, workflowId);
  const wf = readJson(file);
  if (!wf) {
    throw new Error(`Unknown workflow: ${workflowId}`);
  }
  return wf;
}

/**
 * Atomically reads, mutates, and writes a workflow under a proper-lockfile lock.
 * The callback receives the current workflow and may mutate in place (returning
 * undefined) or return a replacement. updatedAt is set automatically.
 * @param {string} cwd
 * @param {string} workflowId
 * @param {(workflow: object) => object|void|Promise<object|void>} callback
 * @returns {Promise<object>} The persisted workflow.
 */
async function mutateWorkflow(cwd, workflowId, callback) {
  validateWorkflowId(workflowId);
  const file = workflowFile(cwd, workflowId);
  if (!fs.existsSync(file)) {
    throw new Error(`Unknown workflow: ${workflowId}`);
  }
  const lf = requireLockfile();
  const release = await lf.lock(file, LOCK_OPTIONS);
  try {
    const wf = readJson(file);
    if (!wf) {
      throw new Error(`Unknown workflow: ${workflowId}`);
    }
    const result = await callback(wf);
    const next = result === undefined ? wf : result;
    next.updatedAt = new Date().toISOString();
    writeJson(file, next);
    return next;
  } finally {
    await release();
  }
}

function listWorkflows(cwd) {
  const base = ensureWorkflowBase(cwd);
  return fs.readdirSync(base, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && WORKFLOW_ID_PATTERN.test(entry.name))
    .map(entry => {
      const wf = readJson(path.join(base, entry.name, 'workflow.json'));
      return wf ? { workflowId: entry.name, workflow: wf } : null;
    })
    .filter(Boolean);
}

/**
 * Removes terminal workflows that exceed the retention policy (count or age).
 * @param {string} cwd
 * @param {{ keepCompletedWorkflows?: number, maxWorkflowAgeDays?: number }} retention
 * @returns {string[]} Removed workflow IDs.
 */
/**
 * Pure selection: given a list of terminal workflow entries, returns the
 * subset to delete. Sorts by recency (newest first), keeps the top-N as a
 * floor, and rejects anything inside the age cutoff.
 *
 * `keepCompletedWorkflows` is a *floor*, not a cap: the N newest terminal
 * workflows are always kept regardless of age. A workflow is pruned only when
 * it is BOTH outside the top-N AND past the age cutoff. Without that floor,
 * the third workflow run would silently delete the user's recent plans /
 * findings / handoff logs.
 */
function selectPruneCandidates(terminal, keepCount, maxAgeMs, now) {
  const sorted = [...terminal].sort((a, b) => {
    const ta = Date.parse(a.workflow.updatedAt || a.workflow.createdAt) || 0;
    const tb = Date.parse(b.workflow.updatedAt || b.workflow.createdAt) || 0;
    return tb - ta;
  });
  const keepIds = new Set(sorted.slice(0, keepCount).map(e => e.workflowId));
  return sorted.filter(entry => {
    const updatedAt = Date.parse(entry.workflow.updatedAt || entry.workflow.createdAt) || 0;
    const tooOld = maxAgeMs > 0 && updatedAt > 0 && (now - updatedAt) > maxAgeMs;
    const overKeepLimit = !keepIds.has(entry.workflowId);
    return tooOld && overKeepLimit;
  });
}

function pruneTerminalWorkflows(cwd, retention = {}) {
  const now = Date.now();
  const maxAgeMs = Number(retention.maxWorkflowAgeDays || 0) * 24 * 60 * 60 * 1000;
  const keepCount = Math.max(0, Number(retention.keepCompletedWorkflows || 0));
  const terminal = listWorkflows(cwd)
    .filter(entry => TERMINAL_STATUSES.has(entry.workflow.status));
  const candidates = selectPruneCandidates(terminal, keepCount, maxAgeMs, now);
  const removed = [];
  for (const entry of candidates) {
    try {
      removePath(workflowDir(cwd, entry.workflowId));
      removed.push(entry.workflowId);
    } catch (err) {
      // Best-effort: don't fail the caller (workflow start) on a prune
      // error, but surface to stderr. A permanent failure (Windows file
      // lock, EACCES) would otherwise skip silently every prune forever,
      // accumulating stale state with no operator-visible signal.
      process.stderr.write(
        `forgewright: failed to prune terminal workflow "${entry.workflowId}": ${err.code || ''} ${err.message}\n`
      );
    }
  }
  return removed;
}

module.exports = {
  TERMINAL_STATUSES,
  LOCK_OPTIONS,
  makeWorkflowId,
  defaultPhaseIdempotence,
  createWorkflow,
  loadWorkflow,
  mutateWorkflow,
  listWorkflows,
  pruneTerminalWorkflows,
  selectPruneCandidates,
};
