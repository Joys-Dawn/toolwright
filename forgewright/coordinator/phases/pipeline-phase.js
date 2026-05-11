'use strict';

const { requireAgentwright } = require('../agentwright-bridge');
const { validatePipelinePhaseResult } = require('../wrightward-contract');

const TYPE = 'pipeline';

function buildInstruction(pipelineName, scope, workflowId) {
  const skillArgs = `${pipelineName} ${scope}`.trim();
  return [
    `Run an agentwright audit pipeline atomically. Pipeline: "${pipelineName}", scope: "${scope}".`,
    ``,
    `Steps:`,
    `  1. Invoke /agentwright:audit-run via the Skill tool with the argument "${skillArgs}". The skill handles start, finding-decision loop, and verifier subagent dispatch.`,
    `  2. Capture the runId from audit-run's start JSON (audit-run prints it on stdout from step 1 of its workflow).`,
    `  3. After the verifier completes — but BEFORE cleanup-snapshot — invoke /agentwright:check-deltas via the Skill tool with the runId as the argument. Capture the JSON output. The snapshot must still exist on disk.`,
    `  4. Clean up the snapshot:`,
    `     node <agentwright-cli> cleanup-snapshot --run <runId> --group 0`,
    `  5. Evaluate any DEFERRED findings audit-run produced:`,
    `     - Clear, obvious, industry-standard wins (even big refactors) → apply the fix yourself, even though they were originally deferred. Do NOT ping the user.`,
    `     - Anything subjective (design tradeoffs, naming choices, architectural style, scope-expanding rewrites) → message the user via wrightward_send_message(audience="user") with a concise summary; await their call before fixing or skipping.`,
    `  6. Advance the workflow, passing the check-deltas JSON as the mcp-result:`,
    `     node <forgewright-cli> workflow-advance --workflow ${workflowId} --result completed --mcp-result '<check-deltas JSON output>'`,
    ``,
    `Use --result failed if any audit stage errors out irrecoverably. Use --result completed even if some findings were deferred; deferred-but-resolved findings are not failures.`,
  ].join('\n');
}

async function buildDescriptor(phase, workflow, { cwd }) {
  if (!phase.pipelineName || typeof phase.pipelineName !== 'string') {
    throw new Error(`Pipeline phase ${phase.index} requires "pipelineName".`);
  }
  // Verify agentwright is installed and meets the minimum version. We do not
  // spawn agentwright here — the LLM drives /agentwright:audit-run via the
  // Skill tool, which discovers its own CLI path through CLAUDE_PLUGIN_ROOT.
  // This call exists only to fail fast at descriptor-build time when the
  // user is missing agentwright entirely.
  requireAgentwright(cwd);
  const scope = phase.scope || '--diff';
  return {
    kind: 'phase',
    type: TYPE,
    pipelineName: phase.pipelineName,
    scope,
    workflowId: workflow.workflowId,
    phaseIndex: phase.index,
    phaseName: phase.name,
    instruction: buildInstruction(phase.pipelineName, scope, workflow.workflowId),
  };
}

function validateResult(result, _phase) {
  if (!result || typeof result !== 'object') {
    throw new Error('Pipeline phase result must be an object.');
  }
  // mcpResult carries the check-deltas JSON. It's optional when present —
  // older custom workflows or users skipping check-deltas should not break.
  // When present, the shape must match check-deltas's emission so reaudit
  // logic can consume it without defensive parsing.
  if (result.mcpResult && typeof result.mcpResult === 'object') {
    validatePipelinePhaseResult(result.mcpResult);
  }
  return true;
}

module.exports = { TYPE, buildDescriptor, validateResult, buildInstruction };
