'use strict';

const TYPE = 'checkpoint';

function buildInstruction(workflow, phase) {
  const summary = phase.summary || '(no summary provided)';
  const taskRef = workflow.workflowId;
  const discordBody = [
    `[workflow:${workflow.workflowName}/${taskRef}] checkpoint: ${phase.name}`,
    summary,
    ``,
    `Resume: /forgewright:workflow-resume ${taskRef}`,
    `Abort:  /forgewright:workflow-stop ${taskRef}`,
  ].join('\n');
  return [
    `Workflow paused at checkpoint: ${phase.name}`,
    ``,
    summary,
    ``,
    `Step 1 — notify the user via Discord:`,
    `  Call mcp__plugin_wrightward_wrightward-bus__wrightward_send_message with:`,
    `    audience: "user"`,
    `    body:`,
    `${discordBody.split('\n').map(l => '      ' + l).join('\n')}`,
    ``,
    `Step 2 — display the same summary in the terminal and EXIT cleanly. Checkpoints are user-driven resumption points; do NOT poll, do NOT auto-advance.`,
    ``,
    `Resume:  /forgewright:workflow-resume ${taskRef}`,
    `Abort:   /forgewright:workflow-stop ${taskRef}`,
  ].join('\n');
}

function buildDescriptor(phase, workflow) {
  if (!phase.name || typeof phase.name !== 'string') {
    throw new Error(`Checkpoint phase ${phase.index} requires a "name".`);
  }
  return {
    kind: 'checkpoint',
    name: phase.name,
    summary: phase.summary || '',
    workflowId: workflow.workflowId,
    workflowName: workflow.workflowName,
    phaseIndex: phase.index,
    resumeCommand: `/forgewright:workflow-resume ${workflow.workflowId}`,
    stopCommand: `/forgewright:workflow-stop ${workflow.workflowId}`,
    discordAudience: 'user',
    instruction: buildInstruction(workflow, phase),
  };
}

function validateResult(_result, _phase) {
  // Checkpoints have no result — they're advanced past by workflow-resume.
  return true;
}

module.exports = { TYPE, buildDescriptor, validateResult, buildInstruction };
