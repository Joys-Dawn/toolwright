'use strict';

const fs = require('fs');
const path = require('path');

const BUILTIN_STAGES = {
  correctness: { type: 'skill', skillId: 'correctness-audit' },
  security: { type: 'skill', skillId: 'security-audit' },
  'best-practices': { type: 'skill', skillId: 'best-practices-audit' },
  implementation: { type: 'skill', skillId: 'implementation-audit' },
  migration: { type: 'skill', skillId: 'migration-audit' },
  ui: { type: 'skill', skillId: 'ui-audit' },
  'test-coverage': { type: 'skill', skillId: 'test-coverage-audit' },
  'tests-migration': { type: 'skill', skillId: 'write-tests-pgtap' },
  'tests-edge': { type: 'skill', skillId: 'write-tests-deno' },
  'tests-frontend': { type: 'skill', skillId: 'write-tests-frontend' }
};

const DEFAULT_PIPELINES = {
  default: ['correctness', 'security', 'best-practices'],
  full: [
    'correctness',
    ['migration', 'ui'],
    'security',
    'best-practices',
    'tests-migration',
    'tests-edge',
    'tests-frontend'
  ]
};

const DEFAULT_RETENTION = {
  keepCompletedRuns: 2,
  deleteCompletedLogs: true,
  deleteCompletedFindings: false,
  maxRunAgeDays: 2
};

function validateUserConfig(parsed, configPath) {
  if (parsed.pipelines != null) {
    if (typeof parsed.pipelines !== 'object' || Array.isArray(parsed.pipelines)) {
      throw new Error(`Invalid config ${configPath}: "pipelines" must be an object.`);
    }
    for (const [name, value] of Object.entries(parsed.pipelines)) {
      if (!Array.isArray(value)) {
        throw new Error(`Invalid config ${configPath}: pipeline "${name}" must be an array.`);
      }
    }
  }
  if (parsed.customStages != null) {
    if (typeof parsed.customStages !== 'object' || Array.isArray(parsed.customStages)) {
      throw new Error(`Invalid config ${configPath}: "customStages" must be an object.`);
    }
    for (const [name, value] of Object.entries(parsed.customStages)) {
      if (!value || typeof value !== 'object' || typeof value.type !== 'string') {
        throw new Error(`Invalid config ${configPath}: customStage "${name}" must have { type: string }.`);
      }
      const hasSkillId = typeof value.skillId === 'string';
      const hasSkillPath = typeof value.skillPath === 'string';
      const hasSkillIds = Array.isArray(value.skillIds);
      const presentCount = [hasSkillId, hasSkillPath, hasSkillIds].filter(Boolean).length;
      if (presentCount === 0) {
        throw new Error(`Invalid config ${configPath}: customStage "${name}" must have one of "skillId" (single builtin), "skillIds" (fused builtin array), or "skillPath" (project-relative path to a SKILL.md file).`);
      }
      if (presentCount > 1) {
        throw new Error(`Invalid config ${configPath}: customStage "${name}" must have exactly one of "skillId", "skillIds", or "skillPath" — not multiple.`);
      }
      if (hasSkillIds) {
        if (value.skillIds.length < 2) {
          throw new Error(`Invalid config ${configPath}: customStage "${name}" "skillIds" must list at least 2 skill IDs (use "skillId" for a single skill).`);
        }
        for (const id of value.skillIds) {
          if (typeof id !== 'string' || id.length === 0) {
            throw new Error(`Invalid config ${configPath}: customStage "${name}" "skillIds" must contain non-empty strings.`);
          }
        }
      }
    }
  }
  if (parsed.retention != null && (typeof parsed.retention !== 'object' || Array.isArray(parsed.retention))) {
    throw new Error(`Invalid config ${configPath}: "retention" must be an object.`);
  }
}

function loadUserConfig(cwd) {
  const configPath = path.join(cwd, '.claude', 'agentwright.json');
  if (!fs.existsSync(configPath)) {
    return { pipelines: {}, customStages: {}, retention: { ...DEFAULT_RETENTION } };
  }
  const raw = fs.readFileSync(configPath, 'utf8');
  const parsed = JSON.parse(raw);
  validateUserConfig(parsed, configPath);
  return {
    pipelines: parsed.pipelines || {},
    customStages: parsed.customStages || {},
    retention: {
      ...DEFAULT_RETENTION,
      ...(parsed.retention || {})
    }
  };
}

function resolveStageDefinition(stageName, cwd, config) {
  const resolved = config || loadUserConfig(cwd);
  const direct = BUILTIN_STAGES[stageName] || resolved.customStages[stageName];
  if (direct) return direct;
  // Support auto-suffixed duplicates (e.g., "correctness-2" → "correctness")
  const base = stageName.replace(/-\d+$/, '');
  if (base !== stageName) {
    return BUILTIN_STAGES[base] || resolved.customStages[base] || null;
  }
  return null;
}

function normalizePipelineGroups(pipeline, cwd, config) {
  if (!Array.isArray(pipeline) || pipeline.length === 0) {
    throw new Error('Pipelines must be non-empty arrays of stages or stage groups.');
  }
  const resolved = config || loadUserConfig(cwd);
  const seenStages = new Map(); // stageName → count
  return pipeline.map((entry, index) => {
    const group = Array.isArray(entry) ? entry : [entry];
    if (group.length === 0) {
      throw new Error(`Pipeline group ${index} cannot be empty.`);
    }
    const normalizedGroup = group.map(stageName => String(stageName || '').trim()).filter(Boolean);
    if (normalizedGroup.length !== group.length) {
      throw new Error(`Pipeline group ${index} contains an empty stage name.`);
    }
    return normalizedGroup.map(stageName => {
      if (!resolveStageDefinition(stageName, cwd, resolved)) {
        throw new Error(`Unknown stage in pipeline: ${stageName}`);
      }
      const count = (seenStages.get(stageName) || 0) + 1;
      seenStages.set(stageName, count);
      if (count > 1) {
        let suffix = count;
        let suffixed = `${stageName}-${suffix}`;
        while (BUILTIN_STAGES[suffixed] || resolved.customStages[suffixed]) {
          suffix++;
          suffixed = `${stageName}-${suffix}`;
        }
        seenStages.set(suffixed, 1);
        return suffixed;
      }
      return stageName;
    });
  });
}

function flattenGroups(groups) {
  return groups.flat();
}

function looksLikeStageList(token, cwd, config) {
  if (!token || !token.includes(',')) {
    return false;
  }
  const parts = token.split(',').map(part => part.trim()).filter(Boolean);
  if (parts.length === 0) {
    return false;
  }
  return parts.every(part => !!resolveStageDefinition(part, cwd, config));
}

function resolveNamedPipeline(name, cwd, config) {
  const resolved = config || loadUserConfig(cwd);
  if (resolved.pipelines[name]) {
    return resolved.pipelines[name];
  }
  return DEFAULT_PIPELINES[name] || null;
}

/**
 * Parses a CLI argument string into a resolved pipeline spec.
 * Tries in order: named pipeline, comma-separated stage list, single stage, fallback to default.
 * Loads user config once and threads it through all resolution calls.
 * @param {string} argumentString - Raw CLI argument string (may be empty).
 * @param {string} cwd - Project working directory (used to locate .claude/agentwright.json).
 * @returns {{ pipelineName: string|null, groups: string[][], stages: string[], scope: string }}
 */
/**
 * Validates that a scope string is one of: exactly --all, exactly --diff, or
 * one or more paths with no --flag tokens. Mixed inputs like "--all src/api/"
 * are rejected — they would otherwise silently drop tokens downstream.
 * @param {string} scope
 */
function validateScope(scope) {
  const tokens = scope.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return;
  const flagTokens = tokens.filter(t => t.startsWith('--'));
  if (flagTokens.length === 0) return;
  if (tokens.length === 1 && (tokens[0] === '--all' || tokens[0] === '--diff')) return;
  throw new Error(
    `Invalid scope "${scope}". Use --all alone, --diff alone, or one or more paths.`
  );
}

function resolveCommandArgs(argumentString, cwd, config) {
  config = config || loadUserConfig(cwd);
  const trimmed = String(argumentString || '').trim();
  if (!trimmed) {
    const groups = normalizePipelineGroups(DEFAULT_PIPELINES.default, cwd, config);
    return {
      pipelineName: 'default',
      groups,
      stages: flattenGroups(groups),
      scope: '--diff'
    };
  }

  const tokens = trimmed.split(/\s+/);
  const first = tokens[0];
  const namedPipeline = resolveNamedPipeline(first, cwd, config);
  if (namedPipeline) {
    const groups = normalizePipelineGroups(namedPipeline, cwd, config);
    const scope = tokens.slice(1).join(' ').trim() || '--diff';
    validateScope(scope);
    return {
      pipelineName: first,
      groups,
      stages: flattenGroups(groups),
      scope
    };
  }

  if (looksLikeStageList(first, cwd, config)) {
    const groups = normalizePipelineGroups(first.split(',').map(part => part.trim()).filter(Boolean), cwd, config);
    const scope = tokens.slice(1).join(' ').trim() || '--diff';
    validateScope(scope);
    return {
      pipelineName: null,
      groups,
      stages: flattenGroups(groups),
      scope
    };
  }

  if (resolveStageDefinition(first, cwd, config)) {
    const groups = normalizePipelineGroups([first], cwd, config);
    const scope = tokens.slice(1).join(' ').trim() || '--diff';
    validateScope(scope);
    return {
      pipelineName: null,
      groups,
      stages: flattenGroups(groups),
      scope
    };
  }

  const groups = normalizePipelineGroups(DEFAULT_PIPELINES.default, cwd, config);
  validateScope(trimmed);
  return {
    pipelineName: 'default',
    groups,
    stages: flattenGroups(groups),
    scope: trimmed
  };
}

module.exports = {
  BUILTIN_STAGES,
  DEFAULT_PIPELINES,
  DEFAULT_RETENTION,
  loadUserConfig,
  normalizePipelineGroups,
  flattenGroups,
  resolveStageDefinition,
  resolveNamedPipeline,
  resolveCommandArgs,
  validateScope
};
