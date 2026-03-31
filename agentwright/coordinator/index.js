#!/usr/bin/env node
'use strict';

const fs = require('fs');
const { parseFlags } = require('./cli-utils');
const { resolveCommandArgs, resolveStageDefinition, loadUserConfig } = require('./pipeline');
const {
  createRun,
  loadRun,
  loadRunWithLiveStatus,
  pruneCompletedRuns,
  listRuns,
  cleanupCompletedStageArtifacts
} = require('./run-ledger');
const {
  validateRunId,
  validateStageName,
  stageFindingsQueueFile,
  stageLogsDir
} = require('./paths');
const { markDeadStageWorkers } = require('./health-check');
const { launchCurrentGroup, completeStage, nextStage, stopRun } = require('./lifecycle');
const { cleanupOrphanedSnapshots } = require('./snapshot-manager');
const { nextFinding, recordDecision, requireFlag } = require('./verification');

function printHelp() {
  process.stdout.write(
    [
      'Usage:',
      '  node coordinator/index.js start [pipeline-or-stage-list] <scope>',
      '  node coordinator/index.js start-stage <stage> [scope]',
      '  node coordinator/index.js status [runId]',
      '  node coordinator/index.js complete-stage --run <runId> --stage <name> [--result accepted|rejected|approval]',
      '  node coordinator/index.js next --run <runId>',
      '  node coordinator/index.js next-finding --run <runId>',
      '  node coordinator/index.js record-decision --run <runId> --stage <name> --finding <id> --decision <valid|invalid|valid_needs_approval> [--action fixed|none] [--rationale "..."] [--files-changed "a.js,b.js"] [--evidence "..."]',
      '  node coordinator/index.js stop --run <runId>',
      '  node coordinator/index.js clean [--logs-only]',
      '  node coordinator/index.js --help'
    ].join('\n') + '\n'
  );
}

async function startRun(argumentString) {
  const cwd = process.cwd();
  const { requireClaudeCli } = require('./process-manager');
  requireClaudeCli();
  const config = loadUserConfig(cwd);
  pruneCompletedRuns(cwd, config.retention);
  cleanupOrphanedSnapshots(cwd, listRuns);
  const resolved = resolveCommandArgs(argumentString, cwd, config);
  const run = createRun(cwd, resolved);
  activeCleanup = () => cleanupOrphanedSnapshots(cwd, listRuns);
  const result = await launchCurrentGroup(cwd, run);
  activeCleanup = null;
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

async function startSingleStage(argumentString) {
  const cwd = process.cwd();
  const { requireClaudeCli } = require('./process-manager');
  requireClaudeCli();
  const trimmed = String(argumentString || '').trim();
  if (!trimmed) {
    throw new Error('start-stage requires a stage name.');
  }
  const tokens = trimmed.split(/\s+/);
  const stageName = validateStageName(tokens[0]);
  const config = loadUserConfig(cwd);
  if (!resolveStageDefinition(stageName, cwd, config)) {
    throw new Error(`Unknown stage: ${stageName}`);
  }
  const scope = tokens.slice(1).join(' ').trim() || '--diff';
  pruneCompletedRuns(cwd, config.retention);
  cleanupOrphanedSnapshots(cwd, listRuns);
  const run = createRun(cwd, {
    pipelineName: null,
    groups: [[stageName]],
    stages: [stageName],
    scope
  });
  activeCleanup = () => cleanupOrphanedSnapshots(cwd, listRuns);
  const result = await launchCurrentGroup(cwd, run);
  activeCleanup = null;
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

function printStatus(runId) {
  const cwd = process.cwd();
  if (!runId) {
    const runs = listRuns(cwd).map(entry => ({
      runId: entry.runId,
      status: entry.run.status,
      scope: entry.run.scope,
      currentGroupIndex: entry.run.currentGroupIndex,
      activeStages: entry.run.activeStages || [],
      updatedAt: entry.run.updatedAt
    }));
    process.stdout.write(JSON.stringify({
      ok: true,
      runs
    }, null, 2) + '\n');
    return;
  }
  validateRunId(runId);
  let run = loadRun(cwd, runId);
  markDeadStageWorkers(cwd, run);
  run = loadRunWithLiveStatus(cwd, runId);
  process.stdout.write(JSON.stringify(run, null, 2) + '\n');
}

function cleanRuns(flags) {
  const cwd = process.cwd();
  const retention = loadUserConfig(cwd).retention;
  const completedRuns = listRuns(cwd).filter(entry => entry.run.status === 'completed');
  let logsRemoved = 0;
  let findingsRemoved = 0;

  for (const entry of completedRuns) {
    for (const stage of entry.run.stages) {
      const logsPath = stageLogsDir(cwd, entry.runId, stage.name);
      if (flags['logs-only'] || retention.deleteCompletedLogs) {
        if (fs.existsSync(logsPath)) {
          cleanupCompletedStageArtifacts(cwd, entry.runId, stage.name, {
            deleteCompletedLogs: true,
            deleteCompletedFindings: false
          });
          logsRemoved += 1;
        }
      }
      if (!flags['logs-only'] && retention.deleteCompletedFindings) {
        const findingsPath = stageFindingsQueueFile(cwd, entry.runId, stage.name);
        if (fs.existsSync(findingsPath)) {
          cleanupCompletedStageArtifacts(cwd, entry.runId, stage.name, {
            deleteCompletedLogs: false,
            deleteCompletedFindings: true
          });
          findingsRemoved += 1;
        }
      }
    }
  }

  const removedRuns = flags['logs-only'] ? [] : pruneCompletedRuns(cwd, retention);
  process.stdout.write(JSON.stringify({
    ok: true,
    logsRemoved,
    findingsRemoved,
    removedRuns
  }, null, 2) + '\n');
}

let activeCleanup = null;

function onTermSignal(signal) {
  if (activeCleanup) {
    try { activeCleanup(); } catch (_) {}
  }
  process.exit(signal === 'SIGINT' ? 130 : 143);
}

process.on('SIGINT', () => onTermSignal('SIGINT'));
process.on('SIGTERM', () => onTermSignal('SIGTERM'));

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv.includes('--help')) {
    printHelp();
    return;
  }

  const command = argv[0];
  const { flags, positional } = parseFlags(argv.slice(1));
  if (command === 'start') {
    return startRun(positional.join(' '));
  }
  if (command === 'start-stage') {
    return startSingleStage(positional.join(' '));
  }
  if (command === 'status') {
    return printStatus(flags.run || positional[0]);
  }
  if (command === 'complete-stage') {
    const result = completeStage(flags.run, flags.stage, flags.result);
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return;
  }
  if (command === 'next') {
    const result = await nextStage(flags.run || positional[0]);
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return;
  }
  if (command === 'next-finding') {
    const runId = requireFlag(flags, 'run');
    const result = await nextFinding(runId);
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return;
  }
  if (command === 'record-decision') {
    const runId = requireFlag(flags, 'run');
    const stage = requireFlag(flags, 'stage');
    const finding = requireFlag(flags, 'finding');
    const decision = requireFlag(flags, 'decision');
    const filesChanged = flags['files-changed']
      ? flags['files-changed'].split(',').map(f => f.trim()).filter(Boolean)
      : [];
    const result = await recordDecision(runId, stage, finding, {
      decision,
      action: flags.action || 'none',
      rationale: flags.rationale || '',
      filesChanged,
      evidence: flags.evidence || ''
    });
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return;
  }
  if (command === 'stop') {
    const runId = requireFlag(flags, 'run');
    const result = stopRun(runId);
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return;
  }
  if (command === 'clean') {
    return cleanRuns(flags);
  }
  throw new Error(`Unknown command: ${command}`);
}

main().catch(error => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
