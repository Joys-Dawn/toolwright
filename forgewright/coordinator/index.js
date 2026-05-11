#!/usr/bin/env node
'use strict';

const { parseFlags, requireFlag } = require('./cli-utils');
const {
  validateWorkflowId,
  validateWorkflowName,
} = require('./paths');
const {
  loadUserConfig,
  resolveWorkflowDefinition,
  resolveReaudit,
  resolveTests,
  listAvailableWorkflows,
} = require('./workflow-config');
const {
  createWorkflow,
  loadWorkflow,
  mutateWorkflow,
  listWorkflows,
  pruneTerminalWorkflows,
} = require('./workflow-ledger');
const {
  buildAndPersistDescriptor,
  advanceWorkflow,
  resumeWorkflow,
  isTerminal,
} = require('./workflow-lifecycle');
const {
  requireAgentwright,
} = require('./agentwright-bridge');

// Mirror of agentwright-bridge.js#REQUIRED_VERSION: the minimum wrightward
// version forgewright depends on. Surfaced in the busProbeInstruction so the
// LLM tells the user exactly which version to install when the MCP server is
// missing or out of date.
const WRIGHTWARD_MIN_VERSION = '3.10.4';

function printHelp() {
  process.stdout.write([
    'Usage:',
    '  node coordinator/index.js workflow-start <workflow-name> [args]',
    '  node coordinator/index.js workflow-advance --workflow <id> --result <completed|failed> [--artifact-path <path>] [--mcp-result <json>]',
    '  node coordinator/index.js workflow-advance --workflow <id> --skip',
    '  node coordinator/index.js workflow-resume --workflow <id> [--force] [--bump-reaudit-cycles <n>]',
    '  node coordinator/index.js workflow-status [--workflow <id>]',
    '  node coordinator/index.js workflow-stop --workflow <id>',
    '  node coordinator/index.js --help',
  ].join('\n') + '\n');
}

function parseMcpResult(raw) {
  if (raw === undefined || raw === null) return null;
  if (raw === true) return null; // bare --mcp-result without a value
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`--mcp-result must be valid JSON. Got: ${raw}`);
  }
}

async function workflowStart(positional) {
  const cwd = process.cwd();
  const workflowName = positional[0];
  if (!workflowName) {
    throw new Error('workflow-start requires a workflow name. Available: ' + listAvailableWorkflows(cwd).join(', '));
  }
  validateWorkflowName(workflowName);

  // Verify agentwright is installed (hard requirement at workflow-start).
  const { cli, version } = requireAgentwright(cwd);

  const config = loadUserConfig(cwd);
  pruneTerminalWorkflows(cwd, config.retention);

  const definition = resolveWorkflowDefinition(workflowName, cwd, config);
  if (!definition) {
    throw new Error(
      `Unknown workflow: "${workflowName}". ` +
      `Available: ${listAvailableWorkflows(cwd, config).join(', ')}.`
    );
  }

  const args = positional.slice(1).join(' ').trim();
  const wf = createWorkflow(cwd, {
    workflowName,
    args,
    definition,
    reaudit: resolveReaudit(definition, config),
    tests: resolveTests(definition, config),
    busPresenceRequired: true,
  });

  const descriptor = await buildAndPersistDescriptor(cwd, wf.workflowId);
  process.stdout.write(JSON.stringify({
    ok: true,
    workflowId: wf.workflowId,
    workflowName,
    args,
    agentwrightCli: cli,
    agentwrightVersion: version,
    busPresenceRequired: true,
    busProbeInstruction:
      'Before executing the first descriptor, call ' +
      'mcp__plugin_wrightward_wrightward-bus__wrightward_whoami to confirm the wrightward MCP server is bound to this session. ' +
      'If it errors with "MCP server not bound" or the tool is missing, surface the install instructions to the user and abort: ' +
      `forgewright requires wrightward >= ${WRIGHTWARD_MIN_VERSION} — install via /plugin install wrightward@Joys-Dawn/toolwright. ` +
      'wrightward\'s bus and Discord work in CLI and IDE extensions alike; only wrightward\'s between-turn channel doorbell is CLI-only, and that applies to peers as much as to the leader (idle peers in extensions only see handoffs on their next user-driven turn). For autonomous dispatch, run leader AND peers from plain CLI terminals.',
    descriptor,
  }, null, 2) + '\n');
}

async function workflowAdvance(flags) {
  const workflowId = validateWorkflowId(requireFlag(flags, 'workflow'));
  const cwd = process.cwd();
  const skip = !!flags.skip;
  if (skip && (flags.result || flags['artifact-path'] || flags['mcp-result'])) {
    throw new Error('--skip is mutually exclusive with --result / --artifact-path / --mcp-result.');
  }
  const params = {
    skip,
    result: skip ? null : (flags.result || null),
    artifactPath: typeof flags['artifact-path'] === 'string' ? flags['artifact-path'] : null,
    mcpResult: parseMcpResult(flags['mcp-result']),
  };
  if (!skip && !params.result) {
    throw new Error('workflow-advance requires --result <completed|failed> or --skip.');
  }
  const descriptor = await advanceWorkflow(cwd, workflowId, params);
  process.stdout.write(JSON.stringify({ ok: true, workflowId, descriptor }, null, 2) + '\n');
}

async function workflowResume(flags) {
  const workflowId = validateWorkflowId(requireFlag(flags, 'workflow'));
  const cwd = process.cwd();
  const force = !!flags.force;
  // --bump-reaudit-cycles N: atomically raise the workflow's frozen
  // reaudit.maxCycles by N before resuming. Lets the user bump past the
  // cap-reached pause without hand-editing the internal workflow.json file.
  const bumpRaw = flags['bump-reaudit-cycles'];
  if (bumpRaw !== undefined && bumpRaw !== true) {
    const bump = Number(bumpRaw);
    if (!Number.isInteger(bump) || bump < 1) {
      throw new Error(`--bump-reaudit-cycles must be a positive integer (got: ${bumpRaw}).`);
    }
    await mutateWorkflow(cwd, workflowId, w => {
      if (!w.reaudit || typeof w.reaudit !== 'object') {
        throw new Error(
          `Workflow ${workflowId} has no frozen reaudit config — cannot bump maxCycles. ` +
          `Re-run the workflow with reaudit configured in .claude/forgewright.json or the workflow definition.`
        );
      }
      w.reaudit.maxCycles = Number(w.reaudit.maxCycles || 0) + bump;
      return w;
    });
  }
  const descriptor = await resumeWorkflow(cwd, workflowId, { force });
  process.stdout.write(JSON.stringify({ ok: true, workflowId, descriptor }, null, 2) + '\n');
}

function workflowStatus(flags, positional) {
  const cwd = process.cwd();
  const workflowId = flags.workflow || positional[0];
  if (!workflowId) {
    const all = listWorkflows(cwd).map(entry => {
      const phases = entry.workflow.phases || [];
      const currentPhase = phases[entry.workflow.currentPhaseIndex];
      return {
        workflowId: entry.workflowId,
        workflowName: entry.workflow.workflowName,
        status: entry.workflow.status,
        currentPhaseIndex: entry.workflow.currentPhaseIndex,
        currentPhaseName: currentPhase ? (currentPhase.name || null) : null,
        totalPhases: phases.length,
        updatedAt: entry.workflow.updatedAt,
      };
    });
    process.stdout.write(JSON.stringify({ ok: true, workflows: all }, null, 2) + '\n');
    return;
  }
  const wf = loadWorkflow(cwd, workflowId);
  process.stdout.write(JSON.stringify(wf, null, 2) + '\n');
}

async function workflowStop(flags) {
  const workflowId = validateWorkflowId(requireFlag(flags, 'workflow'));
  const cwd = process.cwd();
  const wf = loadWorkflow(cwd, workflowId);
  if (isTerminal(wf)) {
    // broadcastNeeded:false signals the skill to skip the peer broadcast —
    // a terminal workflow has no in-flight peers to abort.
    process.stdout.write(JSON.stringify({
      ok: true,
      workflowId,
      status: wf.status,
      broadcastNeeded: false,
      message: 'Workflow already terminal.',
    }, null, 2) + '\n');
    return;
  }
  // Pipeline phases are atomic from forgewright's POV — the LLM's audit-run
  // skill drives `cleanup-snapshot` itself once verification finishes. Any
  // leftover snapshots from a hung pipeline phase get swept by agentwright's
  // own orphan-snapshot cleanup the next time it runs.
  await mutateWorkflow(cwd, workflowId, w => {
    w.status = 'cancelled';
    w.cancelledAt = new Date().toISOString();
    return w;
  });
  process.stdout.write(JSON.stringify({
    ok: true,
    workflowId,
    status: 'cancelled',
    broadcastNeeded: true,
  }, null, 2) + '\n');
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    printHelp();
    return;
  }
  const command = argv[0];
  const { flags, positional } = parseFlags(argv.slice(1));

  switch (command) {
    case 'workflow-start':
      return workflowStart(positional);
    case 'workflow-advance':
      return workflowAdvance(flags);
    case 'workflow-resume':
      return workflowResume(flags);
    case 'workflow-status':
      return workflowStatus(flags, positional);
    case 'workflow-stop':
      return workflowStop(flags);
    default:
      throw new Error(`Unknown command: ${command}. Run with --help for usage.`);
  }
}

main().catch(err => {
  process.stderr.write(`${err.message}\n`);
  process.exit(1);
});
