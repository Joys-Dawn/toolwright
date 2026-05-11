'use strict';

const fs = require('fs');
const path = require('path');

const WORKFLOW_ID_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._-]*$/;
const WORKFLOW_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/;

function validateWorkflowId(workflowId) {
  if (typeof workflowId !== 'string' || !WORKFLOW_ID_PATTERN.test(workflowId)) {
    throw new Error(`Invalid workflow ID: ${workflowId}`);
  }
  return workflowId;
}

function validateWorkflowName(name) {
  if (typeof name !== 'string' || !WORKFLOW_NAME_PATTERN.test(name)) {
    throw new Error(`Invalid workflow name: ${name}`);
  }
  return name;
}

function ensureWorkflowBase(cwd) {
  const dir = path.join(cwd, '.claude', 'forgewright', 'workflows');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function workflowDir(cwd, workflowId) {
  return path.join(ensureWorkflowBase(cwd), validateWorkflowId(workflowId));
}

function workflowFile(cwd, workflowId) {
  return path.join(workflowDir(cwd, workflowId), 'workflow.json');
}

function artifactsDir(cwd, workflowId) {
  return path.join(workflowDir(cwd, workflowId), 'artifacts');
}

function configFile(cwd) {
  return path.join(cwd, '.claude', 'forgewright.json');
}

module.exports = {
  WORKFLOW_ID_PATTERN,
  WORKFLOW_NAME_PATTERN,
  validateWorkflowId,
  validateWorkflowName,
  ensureWorkflowBase,
  workflowDir,
  workflowFile,
  artifactsDir,
  configFile,
};
