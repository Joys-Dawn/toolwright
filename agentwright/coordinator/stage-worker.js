#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { loadRun, mutateRun, updateStageStatus } = require('./run-ledger');
const {
  assertPathWithin,
  expectedGroupSnapshotPath,
  getManagedSnapshotRoot,
  groupSnapshotFile,
  stageFindingsQueueFile,
  stageMetaFile,
  stageLogsDir
} = require('./paths');
const { writeJson, readJson, appendJsonLine } = require('./io');
const { resolveStageDefinition } = require('./pipeline');
const { spawnAuditor } = require('./process-manager');
const { parseFlags } = require('./cli-utils');

const SKILL_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/i;

function resolveBuiltinSkill({ pluginRoot, stageName, skillId }) {
  if (typeof skillId !== 'string' || !SKILL_ID_PATTERN.test(skillId)) {
    throw new Error(`Invalid skill ID for stage ${stageName}: ${skillId}`);
  }
  const skillPath = path.join(pluginRoot, 'skills', skillId, 'SKILL.md');
  if (!fs.existsSync(skillPath)) {
    throw new Error(`Vendored skill not found for stage ${stageName}: ${skillId}`);
  }
  return { id: skillId, path: skillPath };
}

function resolveSkillPaths({ pluginRoot, cwd, stageName, stageDef }) {
  if (stageDef.skillPath) {
    const resolved = path.resolve(cwd, stageDef.skillPath);
    if (!fs.existsSync(resolved)) {
      throw new Error(`Custom skill file not found for stage ${stageName}: ${resolved}`);
    }
    const id = path.basename(path.dirname(resolved)) || stageName;
    return [{ id, path: resolved }];
  }
  if (Array.isArray(stageDef.skillIds)) {
    return stageDef.skillIds.map(skillId => resolveBuiltinSkill({ pluginRoot, stageName, skillId }));
  }
  return [resolveBuiltinSkill({ pluginRoot, stageName, skillId: stageDef.skillId })];
}

function resolveScopeMode({ scope, snapshot, cwd }) {
  const trimmedScope = String(scope || '').trim();
  // Match the literal token, not its prefix. \b would match --all-foo because
  // - is non-word; lookahead for whitespace or end-of-string is the correct
  // boundary for hyphen-prefixed tokens.
  if (/^--all(?=\s|$)/.test(trimmedScope)) {
    return { scopeMode: 'full', effectiveScope: '' };
  }
  if (/^--diff(?=\s|$)/.test(trimmedScope)) {
    if (snapshot.type === 'git-worktree' && snapshot.dirtyOverlay) {
      return { scopeMode: 'diff', effectiveScope: scope };
    }
    if (snapshot.type === 'git-worktree') {
      return { scopeMode: 'full', effectiveScope: scope };
    }
    const diffResult = spawnSync('git', ['diff', '--name-only', 'HEAD'], { cwd, encoding: 'utf8' });
    const stagedResult = spawnSync('git', ['diff', '--name-only', '--cached'], { cwd, encoding: 'utf8' });
    const diffFiles = new Set([
      ...(diffResult.stdout || '').split('\n').map(f => f.trim()).filter(Boolean),
      ...(stagedResult.stdout || '').split('\n').map(f => f.trim()).filter(Boolean)
    ]);
    if (diffFiles.size > 0) {
      return { scopeMode: 'targeted', effectiveScope: [...diffFiles].join(' ') };
    }
    return { scopeMode: 'full', effectiveScope: scope };
  }
  return { scopeMode: 'targeted', effectiveScope: scope };
}

function buildScopeInstruction(scope, scopeMode) {
  const sanitizedScope = String(scope || '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[<>]/g, ' ')
    .trim()
    .slice(0, 500);
  if (scopeMode === 'diff') {
    return [
      'SCOPE MODE: diff',
      'This snapshot contains uncommitted changes overlaid on a git worktree.',
      'Run `git diff` to see line-level changes to existing files, and `git ls-files --others --exclude-standard` to find newly created files.',
      'Audit the changed lines and their immediate context. Do not report low or medium severity findings in unchanged code.',
      'You may report critical or high severity findings in unchanged code if discovered while reading context, but the primary focus must be the diff.'
    ].join('\n');
  }
  if (scopeMode === 'full') {
    return [
      'SCOPE MODE: full repository',
      'Audit the entire codebase. There is no diff to narrow the scope.'
    ].join('\n');
  }
  return [
    'SCOPE MODE: targeted',
    `Audit only the following files or directories: ${sanitizedScope}`,
    'Do NOT report findings in files outside this scope.'
  ].join('\n');
}

const SHARED_OUTPUT_INTRO = 'You are auditing a frozen stage snapshot. Output newline-delimited JSON only.';
const SHARED_EMIT_RULE = 'Emit one compact JSON object per line as soon as a finding is ready. Do not wait until you have reviewed all files — emit each finding immediately after identifying it so the verifier can work in parallel.';
const SHARED_FORMAT_RULE = 'Do not emit markdown, prose paragraphs, bullet lists, or code fences.';
const SHARED_GROUNDING_RULE = 'Every finding must be grounded enough that the verifier can re-check only the cited file and local context in the live repo.';

function buildSingleSkillPrompt({ stageName, scopeInstruction, skill }) {
  const skillContent = fs.readFileSync(skill.path, 'utf8');
  return [
    `Audit stage: ${stageName}`,
    '',
    scopeInstruction,
    '',
    SHARED_OUTPUT_INTRO,
    SHARED_EMIT_RULE,
    'Finding line format:',
    `{"type":"finding","finding":{"id":"${stageName}-1","severity":"low|medium|high|critical","title":"...","file":"relative/path","lines":"optional","problem":"...","fix":"...","evidence":"...","snippet":"optional"}}`,
    'When the audit is complete, emit exactly one final line:',
    `{"type":"done","auditType":"${stageName}","summary":"...","emittedCount":0}`,
    SHARED_FORMAT_RULE,
    SHARED_GROUNDING_RULE,
    '',
    'Follow the bundled skill below exactly when deciding what to audit.',
    '',
    skillContent
  ].join('\n');
}

function buildFusedSkillPrompt({ stageName, scopeInstruction, skills }) {
  const skillIdList = skills.map(s => s.id);
  const auditTypeChoices = skillIdList.join('|');
  const allowedAuditTypes = skillIdList.map(id => `"${id}"`).join(', ');
  const concatenatedSkills = skills
    .map(skill => `===== Skill: ${skill.id} =====\n${fs.readFileSync(skill.path, 'utf8')}`)
    .join('\n\n');

  return [
    `Audit stage: ${stageName} (fused: ${skillIdList.join(', ')})`,
    '',
    scopeInstruction,
    '',
    SHARED_OUTPUT_INTRO,
    `This is a FUSED stage running ${skills.length} audit types in one pass. Apply every bundled skill below as a separate lens — do not skip any. Tag each finding with an "auditType" field whose value is exactly one of: ${allowedAuditTypes}.`,
    SHARED_EMIT_RULE,
    'Finding line format:',
    `{"type":"finding","finding":{"id":"${stageName}-1","auditType":"${auditTypeChoices}","severity":"low|medium|high|critical","title":"...","file":"relative/path","lines":"optional","problem":"...","fix":"...","evidence":"...","snippet":"optional"}}`,
    'When all audits are complete, emit exactly one final line:',
    `{"type":"done","auditType":"${stageName}","summary":"...","emittedCount":0}`,
    SHARED_FORMAT_RULE,
    SHARED_GROUNDING_RULE,
    '',
    'Follow EACH bundled skill below exactly. The separator "===== Skill: <id> =====" delimits one skill from the next; apply all of them.',
    '',
    concatenatedSkills
  ].join('\n');
}

function buildAuditorPrompt({ pluginRoot, cwd, stageName, stageDef, scope, scopeMode }) {
  const skills = resolveSkillPaths({ pluginRoot, cwd, stageName, stageDef });
  const scopeInstruction = buildScopeInstruction(scope, scopeMode);
  if (skills.length === 1) {
    return buildSingleSkillPrompt({ stageName, scopeInstruction, skill: skills[0] });
  }
  return buildFusedSkillPrompt({ stageName, scopeInstruction, skills });
}

// Each auditor subprocess creates a project entry in ~/.claude/projects/
// named after its cwd — these are single-use and pile up.
// NOTE: The folder naming convention (drive letter + dashes) is reverse-engineered
// from Claude CLI behavior as of v2.1.91. If the CLI changes this convention,
// cleanup silently fails (swallowed by try-catch) and folders accumulate.
function cleanupClaudeProjectFolder(absPath) {
  try {
    const homedir = require('os').homedir();
    const folderName = path.resolve(absPath)
      .replace(/^([a-zA-Z]):/, (_, d) => d.toUpperCase() + '-')
      .replace(/[\\/]/g, '-');
    const projectDir = path.join(homedir, '.claude', 'projects', folderName);
    fs.rmSync(projectDir, { recursive: true, force: true });
  } catch (_) {}
}

function updateRunAuditor(cwd, runId, stageName, value) {
  mutateRun(cwd, runId, run => {
    const nextAuditor = run.auditor && typeof run.auditor === 'object' ? { ...run.auditor } : {};
    if (value == null) {
      delete nextAuditor[stageName];
    } else {
      nextAuditor[stageName] = value;
    }
    run.auditor = Object.keys(nextAuditor).length > 0 ? nextAuditor : null;
    return run;
  });
}

async function main() {
  const { flags } = parseFlags(process.argv.slice(2));
  const runId = flags.run;
  const stageName = flags.stage;
  const rawGroupIndex = flags['group-index'];
  const groupIndex = Number(rawGroupIndex);
  const cwd = process.cwd();
  const pluginRoot = path.resolve(__dirname, '..');
  if (!runId || !stageName || typeof rawGroupIndex !== 'string' || !Number.isInteger(groupIndex)) {
    throw new Error('stage-worker requires --run, --stage, and --group-index.');
  }

  const run = loadRun(cwd, runId);
  const stageDef = resolveStageDefinition(stageName, cwd);
  if (!stageDef || stageDef.type !== 'skill') {
    throw new Error(`Stage ${stageName} is not configured as a skill stage.`);
  }

  const findingsQueuePath = stageFindingsQueueFile(cwd, runId, stageName);
  const metaPath = stageMetaFile(cwd, runId, stageName);
  const logsDir = stageLogsDir(cwd, runId, stageName);
  const findings = [];
  const seenIds = new Set();
  let stageMeta = readJson(metaPath, {
    stage: stageName,
    status: 'auditing',
    auditDone: false,
    emittedCount: 0,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  let doneMarker = null;
  let sawDoneMarker = false;

  function saveStageMeta(extra = {}) {
    stageMeta = {
      ...stageMeta,
      ...extra,
      updatedAt: new Date().toISOString()
    };
    writeJson(metaPath, stageMeta);
  }

  const snapshot = readJson(groupSnapshotFile(cwd, runId, groupIndex));
  if (!snapshot || !snapshot.path) {
    throw new Error(`Missing group snapshot metadata for group ${groupIndex}.`);
  }
  assertPathWithin(getManagedSnapshotRoot(), snapshot.path, 'Snapshot path');
  if (path.resolve(snapshot.path) !== path.resolve(expectedGroupSnapshotPath(runId, groupIndex))) {
    throw new Error(`Snapshot path for run ${runId} group ${groupIndex} did not match the expected location.`);
  }
  saveStageMeta({
    status: 'auditing',
    snapshotPath: snapshot.path,
    groupIndex,
    groupSnapshotFile: path.basename(groupSnapshotFile(cwd, runId, groupIndex))
  });
  updateStageStatus(cwd, runId, stageName, 'auditing', {
    findingsCount: 0
  });

  const { scopeMode, effectiveScope } = resolveScopeMode({ scope: run.scope, snapshot, cwd });

  const worker = spawnAuditor({
    cwd: snapshot.path,
    pluginRoot,
    prompt: buildAuditorPrompt({
      pluginRoot,
      cwd,
      stageName,
      stageDef,
      scope: effectiveScope,
      scopeMode
    }),
    logsDir,
    runId,
    stageName,
    onEvent(event) {
      if (event.type === 'finding' && event.finding && typeof event.finding.id === 'string') {
        if (seenIds.has(event.finding.id)) {
          return;
        }
        seenIds.add(event.finding.id);
        findings.push(event.finding);
        appendJsonLine(findingsQueuePath, event);
        saveStageMeta({
          status: 'auditing',
          emittedCount: findings.length,
          lastFindingId: event.finding.id,
          lastEventType: 'finding'
        });
        // Live findingsCount is read from the meta file by loadRunWithLiveStatus
        // rather than writing to run.json on every finding (avoids lock contention
        // when parallel stage workers compete for the same run.json lock).
        return;
      }
      if (event.type === 'done') {
        sawDoneMarker = true;
        doneMarker = event;
        saveStageMeta({
          lastEventType: 'done',
          donePreview: event.summary || ''
        });
        return;
      }
      saveStageMeta({
        lastEventType: event.type || null,
        lastEventSubtype: event.rawSubtype || null
      });
    }
  });

  updateRunAuditor(cwd, runId, stageName, {
    workerPid: process.pid,
    pid: worker.pid,
    stage: stageName,
    groupIndex,
    logsDir,
    snapshotPath: snapshot.path
  });

  const { exitCode, resultEvent, doneEvent } = await worker.wait();

  cleanupClaudeProjectFolder(snapshot.path);

  if (!doneMarker) {
    doneMarker = doneEvent || {
      type: 'done',
      auditType: stageName,
      summary: resultEvent?.is_error
        ? String(resultEvent.result || 'Auditor failed before emitting a done marker.')
        : 'Auditor finished without emitting a done marker. Review the stage logs before trusting the findings.',
      emittedCount: findings.length,
      error: exitCode !== 0
    };
  }

  const stageFailed = !sawDoneMarker || Boolean(doneMarker.error) || exitCode !== 0;
  saveStageMeta({
    status: stageFailed ? 'failed' : 'done',
    auditDone: true,
    auditSucceeded: !stageFailed,
    doneAt: new Date().toISOString(),
    emittedCount: findings.length,
    summary: doneMarker.summary || '',
    error: Boolean(doneMarker.error),
    auditorExitCode: exitCode
  });
  updateRunAuditor(cwd, runId, stageName, null);
  updateStageStatus(cwd, runId, stageName, stageFailed ? 'audit_failed' : 'awaiting_verification_completion', {
    auditorExitCode: exitCode,
    findingsCount: findings.length
  });
}

if (require.main === module) {
  main().catch(handleMainError);
}

module.exports = {
  buildAuditorPrompt,
  resolveScopeMode,
  resolveSkillPaths,
  cleanupClaudeProjectFolder
};

function handleMainError(error) {
  const { flags } = parseFlags(process.argv.slice(2));
  if (flags.run && flags.stage) {
    try {
      writeJson(stageMetaFile(process.cwd(), flags.run, flags.stage), {
        stage: flags.stage,
        status: 'failed',
        auditDone: true,
        auditSucceeded: false,
        emittedCount: 0,
        summary: error.message,
        error: true,
        auditorExitCode: 1,
        updatedAt: new Date().toISOString()
      });
      updateRunAuditor(process.cwd(), flags.run, flags.stage, null);
      updateStageStatus(process.cwd(), flags.run, flags.stage, 'audit_failed', {
        auditorExitCode: 1,
        findingsCount: 0
      });
    } catch (nestedError) {
      // Ignore nested failures so the worker can still exit.
    }
  }
  process.exit(1);
}
