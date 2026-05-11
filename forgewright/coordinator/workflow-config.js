'use strict';

const fs = require('fs');
const path = require('path');
const { readJson } = require('./io');
const { configFile } = require('./paths');
const { parseProduces } = require('./artifacts');

const DEFAULT_RETENTION = {
  keepCompletedWorkflows: 2,
  maxWorkflowAgeDays: 7,
};

const DEFAULT_REAUDIT = {
  maxCycles: 1,
  minDeltaPercent: 5,
  minDeltaLines: 0,
  decisionMode: 'deterministic',
  loopableStages: ['correctness', 'behavior', 'security'],
};

const VALID_PHASE_TYPES = new Set([
  'skill',
  'pipeline',
  'command',
  'checkpoint',
  'handoff',
]);

// Same shape as workflow names — alnum + - + _, leading letter. Used in
// task_ref strings, log lines, and (eventually) goto/branch references, so
// must be safe in identifiers without any escaping.
const PHASE_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/;

function builtinWorkflowsDir() {
  return path.resolve(__dirname, '..', 'workflows');
}

function loadBuiltinWorkflows() {
  const dir = builtinWorkflowsDir();
  if (!fs.existsSync(dir)) return {};
  const out = {};
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const name = entry.name.replace(/\.json$/, '');
    const def = readJson(path.join(dir, entry.name));
    if (def) out[name] = def;
  }
  return out;
}

/**
 * Per-field validation for a reaudit block. `ctx` is a prefix string used in
 * error messages (e.g., `Workflow "feature"` or `Config .claude/forgewright.json`).
 * Validating at load time means downstream code can read maxCycles /
 * minDeltaPercent / minDeltaLines as numbers without defensive coercion —
 * bad config now fails loudly instead of silently no-op'ing the replay logic.
 */
function validateReauditBlock(reaudit, ctx) {
  for (const key of ['maxCycles', 'minDeltaPercent', 'minDeltaLines']) {
    if (key in reaudit && (typeof reaudit[key] !== 'number' || !Number.isFinite(reaudit[key]))) {
      throw new Error(`${ctx} "reaudit.${key}" must be a finite number.`);
    }
  }
  if ('decisionMode' in reaudit
      && reaudit.decisionMode !== 'deterministic'
      && reaudit.decisionMode !== 'leader') {
    throw new Error(`${ctx} "reaudit.decisionMode" must be "deterministic" or "leader".`);
  }
  if ('loopableStages' in reaudit) {
    if (!Array.isArray(reaudit.loopableStages)
        || !reaudit.loopableStages.every(s => typeof s === 'string' && s.length > 0)) {
      throw new Error(`${ctx} "reaudit.loopableStages" must be an array of non-empty strings.`);
    }
  }
}

function validateWorkflowDefinition(name, def) {
  if (!def || typeof def !== 'object') {
    throw new Error(`Workflow "${name}" must be an object.`);
  }
  if (!Array.isArray(def.phases) || def.phases.length === 0) {
    throw new Error(`Workflow "${name}" must define a non-empty "phases" array.`);
  }
  if (def.reaudit != null) {
    if (typeof def.reaudit !== 'object' || Array.isArray(def.reaudit)) {
      throw new Error(`Workflow "${name}" "reaudit" must be an object.`);
    }
    validateReauditBlock(def.reaudit, `Workflow "${name}"`);
  }
  if (def.tests != null && (typeof def.tests !== 'object' || Array.isArray(def.tests))) {
    throw new Error(`Workflow "${name}" "tests" must be an object.`);
  }
  const seenNames = new Set();
  for (let i = 0; i < def.phases.length; i++) {
    const phase = def.phases[i];
    if (!phase || typeof phase !== 'object') {
      throw new Error(`Workflow "${name}" phase ${i} must be an object.`);
    }
    if (!VALID_PHASE_TYPES.has(phase.type)) {
      throw new Error(`Workflow "${name}" phase ${i} has unknown type: ${phase.type}`);
    }
    // Universal: every phase needs a unique, identifier-safe name.
    if (typeof phase.name !== 'string' || !PHASE_NAME_PATTERN.test(phase.name)) {
      throw new Error(
        `Workflow "${name}" phase ${i} requires a "name" string matching ${PHASE_NAME_PATTERN}.`
      );
    }
    if (seenNames.has(phase.name)) {
      throw new Error(
        `Workflow "${name}" has duplicate phase name "${phase.name}" — names must be unique within a workflow.`
      );
    }
    seenNames.add(phase.name);
    if (phase.type === 'skill' && typeof phase.skillId !== 'string') {
      throw new Error(`Workflow "${name}" phase ${i} (skill) requires a "skillId".`);
    }
    if (phase.type === 'pipeline' && typeof phase.pipelineName !== 'string') {
      throw new Error(`Workflow "${name}" phase ${i} (pipeline) requires a "pipelineName".`);
    }
    if (phase.type === 'command') {
      if (typeof phase.command !== 'string') {
        throw new Error(`Workflow "${name}" phase ${i} (command) requires a "command".`);
      }
      if (phase.consumes != null) {
        const isString = typeof phase.consumes === 'string' && phase.consumes.length > 0;
        const isArrayOfStrings = Array.isArray(phase.consumes)
          && phase.consumes.length > 0
          && phase.consumes.every(s => typeof s === 'string' && s.length > 0);
        if (!isString && !isArrayOfStrings) {
          throw new Error(
            `Workflow "${name}" phase ${i} (command) "consumes" must be a non-empty string or an array of non-empty strings.`
          );
        }
      }
    }
    if (phase.type === 'handoff') {
      const hasDirective = typeof phase.directive === 'string' && phase.directive.trim().length > 0;
      const hasConsumes = typeof phase.consumes === 'string' && phase.consumes.length > 0;
      if (!hasDirective && !hasConsumes) {
        throw new Error(`Workflow "${name}" phase ${i} (handoff) requires "directive" or "consumes" (or both).`);
      }
    }
    // Universal: produces shape, when present, must parse. Catches `produces: 42`,
    // `produces: {}`, `produces: ['plan.md']`, and similar at config-load
    // time rather than at descriptor-build time (where the failure mode is a
    // missing artifact registration the next phase can't find).
    if (phase.produces != null) {
      const parsed = parseProduces(phase.produces);
      if (!parsed) {
        throw new Error(
          `Workflow "${name}" phase ${i} has malformed "produces" — must be a non-empty string or a { stem: filename } map with at least one usable entry.`
        );
      }
    }
  }
  return def;
}

function validateUserConfig(parsed, configFilePath) {
  if (parsed.workflows != null) {
    if (typeof parsed.workflows !== 'object' || Array.isArray(parsed.workflows)) {
      throw new Error(`Invalid config ${configFilePath}: "workflows" must be an object.`);
    }
    for (const [name, def] of Object.entries(parsed.workflows)) {
      validateWorkflowDefinition(name, def);
    }
  }
  if (parsed.retention != null && (typeof parsed.retention !== 'object' || Array.isArray(parsed.retention))) {
    throw new Error(`Invalid config ${configFilePath}: "retention" must be an object.`);
  }
  if (parsed.reaudit != null) {
    if (typeof parsed.reaudit !== 'object' || Array.isArray(parsed.reaudit)) {
      throw new Error(`Invalid config ${configFilePath}: "reaudit" must be an object.`);
    }
    validateReauditBlock(parsed.reaudit, `Config ${configFilePath}:`);
  }
  if (parsed.tests != null && (typeof parsed.tests !== 'object' || Array.isArray(parsed.tests))) {
    throw new Error(`Invalid config ${configFilePath}: "tests" must be an object.`);
  }
  if (parsed.agentwright != null && (typeof parsed.agentwright !== 'object' || Array.isArray(parsed.agentwright))) {
    throw new Error(`Invalid config ${configFilePath}: "agentwright" must be an object.`);
  }
}

function loadUserConfig(cwd) {
  const file = configFile(cwd);
  if (!fs.existsSync(file)) {
    return {
      workflows: {},
      retention: { ...DEFAULT_RETENTION },
      reaudit: { ...DEFAULT_REAUDIT },
      tests: { command: null },
      agentwright: { path: null },
    };
  }
  const parsed = readJson(file) || {};
  validateUserConfig(parsed, file);
  return {
    workflows: parsed.workflows || {},
    retention: { ...DEFAULT_RETENTION, ...(parsed.retention || {}) },
    reaudit: { ...DEFAULT_REAUDIT, ...(parsed.reaudit || {}) },
    tests: { command: null, ...(parsed.tests || {}) },
    agentwright: { path: null, ...(parsed.agentwright || {}) },
  };
}

function resolveWorkflowDefinition(workflowName, cwd, config) {
  const resolved = config || loadUserConfig(cwd);
  const userDef = resolved.workflows[workflowName];
  if (userDef) {
    return validateWorkflowDefinition(workflowName, userDef);
  }
  const builtin = loadBuiltinWorkflows();
  if (builtin[workflowName]) {
    return validateWorkflowDefinition(workflowName, builtin[workflowName]);
  }
  return null;
}

function listAvailableWorkflows(cwd, config) {
  const resolved = config || loadUserConfig(cwd);
  const builtin = Object.keys(loadBuiltinWorkflows());
  const user = Object.keys(resolved.workflows);
  return Array.from(new Set([...builtin, ...user])).sort();
}

/**
 * Returns the effective reaudit config for a workflow: a shallow merge of the
 * workflow definition's `reaudit` block (if present) over the user config's
 * top-level `reaudit` block. Every key — maxCycles, minDeltaPercent,
 * minDeltaLines, decisionMode, loopableStages — is overridable.
 *
 * Frozen onto the workflow at createWorkflow time so the rules in effect at
 * start are the rules the workflow uses through completion (a later config
 * edit doesn't retroactively change a running workflow's behavior).
 */
function resolveReaudit(definition, userConfig) {
  const global = (userConfig && userConfig.reaudit) || DEFAULT_REAUDIT;
  const override = (definition && definition.reaudit && typeof definition.reaudit === 'object' && !Array.isArray(definition.reaudit))
    ? definition.reaudit
    : null;
  if (!override) return { ...global };
  return { ...global, ...override };
}

/**
 * Returns the effective `tests` config for a workflow: a shallow merge of the
 * workflow definition's `tests` block over the user config's top-level `tests`
 * block. Currently only `command` is meaningful; the merge shape future-proofs
 * for additional keys (timeout, env, etc.).
 *
 * Frozen onto the workflow at createWorkflow time alongside `reaudit`.
 */
function resolveTests(definition, userConfig) {
  const global = (userConfig && userConfig.tests) || { command: null };
  const override = (definition && definition.tests && typeof definition.tests === 'object' && !Array.isArray(definition.tests))
    ? definition.tests
    : null;
  if (!override) return { ...global };
  return { ...global, ...override };
}

module.exports = {
  DEFAULT_RETENTION,
  DEFAULT_REAUDIT,
  PHASE_NAME_PATTERN,
  loadBuiltinWorkflows,
  loadUserConfig,
  resolveWorkflowDefinition,
  resolveReaudit,
  resolveTests,
  validateWorkflowDefinition,
  validateUserConfig,
  listAvailableWorkflows,
};
