'use strict';

/**
 * Pure shape validators for the JSON the LLM reports back from a phase via
 * `workflow-advance --mcp-result <json>`. No I/O. No MCP knowledge beyond
 * response shape.
 *
 * Three payload kinds cross this CLI boundary today: command results,
 * pipeline-phase results, and handoff-batch results. Single-tool wrightward
 * responses (whoami / bus_status / list_inbox / send_*) are consumed by the
 * LLM in-process and never roundtrip through the coordinator — so they are
 * NOT validated here. Add a validator only when a new payload kind actually
 * starts flowing through `--mcp-result`.
 */

class ContractError extends Error {
  constructor(tool, detail) {
    super(`wrightward ${tool} response: ${detail}`);
    this.name = 'WrightwardContractError';
    this.tool = tool;
    this.code = 'mcp-shape-mismatch';
  }
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function requireObject(value, label, tool) {
  if (!isPlainObject(value)) {
    throw new ContractError(tool, `${label} must be an object`);
  }
}

/**
 * Command-result shape: the LLM reports back from a command phase.
 */
function validateCommandResult(json) {
  requireObject(json, 'command result', 'command-result');
  if (typeof json.command !== 'string' || json.command.length === 0) {
    throw new ContractError('command-result', 'command must be a non-empty string');
  }
  if (typeof json.exitCode !== 'number') {
    throw new ContractError('command-result', 'exitCode must be a number');
  }
  return {
    command: json.command,
    exitCode: json.exitCode,
    summary: typeof json.summary === 'string' ? json.summary : '',
  };
}

/**
 * Pipeline-phase result: the LLM reports back from a pipeline phase. The
 * payload is the JSON output of `/agentwright:check-deltas`, which the LLM
 * captured between the verifier and snapshot cleanup. Counts are scoped to
 * git-visible source files (excludes `.gitignore`'d paths and the standard
 * EXCLUDED_ROOTS / SECRET_ENV_NAMES).
 *
 * Shape (mirrors agentwright/coordinator/snapshot-deltas.js#computeDeltas):
 *   {
 *     totalAdded: number,
 *     totalDeleted: number,
 *     totalDiffLines: number,
 *     totalLoc: number,
 *     ratio: number,
 *     changedFiles: string[],
 *     // Pass-through fields from the coordinator wrapper (optional):
 *     ok?: boolean, runId?: string, groupIndex?: number, snapshotPath?: string,
 *   }
 */
function validatePipelinePhaseResult(json) {
  requireObject(json, 'pipeline phase result', 'pipeline-phase');
  for (const key of ['totalAdded', 'totalDeleted', 'totalDiffLines', 'totalLoc']) {
    if (typeof json[key] !== 'number' || !Number.isFinite(json[key])) {
      throw new ContractError('pipeline-phase', `${key} must be a finite number`);
    }
  }
  if (typeof json.ratio !== 'number' || !Number.isFinite(json.ratio)) {
    throw new ContractError('pipeline-phase', 'ratio must be a finite number');
  }
  if (!Array.isArray(json.changedFiles)) {
    throw new ContractError('pipeline-phase', 'changedFiles must be an array');
  }
  for (let i = 0; i < json.changedFiles.length; i++) {
    if (typeof json.changedFiles[i] !== 'string') {
      throw new ContractError('pipeline-phase', `changedFiles[${i}] must be a string`);
    }
  }
  return {
    totalAdded: json.totalAdded,
    totalDeleted: json.totalDeleted,
    totalDiffLines: json.totalDiffLines,
    totalLoc: json.totalLoc,
    ratio: json.ratio,
    changedFiles: json.changedFiles,
  };
}

/**
 * Handoff-batch result: the leader reports back the outcome of every task it
 * dispatched (or executed itself) during a handoff phase.
 * Shape: {
 *   tasks: [
 *     { key, by: "peer:<handle>"|"self", status: "completed"|"failed"|"skipped",
 *       ackId?: string, detail?: string },
 *     ...
 *   ]
 * }
 */
function validateHandoffBatchResult(json) {
  requireObject(json, 'handoff batch result', 'handoff-batch');
  if (!Array.isArray(json.tasks)) {
    throw new ContractError('handoff-batch', 'tasks must be an array');
  }
  for (let i = 0; i < json.tasks.length; i++) {
    const task = json.tasks[i];
    if (!isPlainObject(task)) {
      throw new ContractError('handoff-batch', `tasks[${i}] must be an object`);
    }
    if (typeof task.key !== 'string' || task.key.length === 0) {
      throw new ContractError('handoff-batch', `tasks[${i}].key must be a non-empty string`);
    }
    if (typeof task.by !== 'string' || !(task.by === 'self' || task.by.startsWith('peer:'))) {
      throw new ContractError('handoff-batch', `tasks[${i}].by must be "self" or "peer:<handle>"`);
    }
    if (!['completed', 'failed', 'skipped'].includes(task.status)) {
      throw new ContractError('handoff-batch', `tasks[${i}].status must be completed|failed|skipped`);
    }
  }
  return { tasks: json.tasks };
}

module.exports = {
  ContractError,
  validateCommandResult,
  validateHandoffBatchResult,
  validatePipelinePhaseResult,
};
