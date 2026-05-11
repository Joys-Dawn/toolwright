'use strict';

const { mutateWorkflow, loadWorkflow } = require('./workflow-ledger');
const { loadUserConfig } = require('./workflow-config');

/**
 * Returns the effective reaudit config for a workflow. Prefers the per-workflow
 * `reaudit` snapshot frozen at createWorkflow time; falls back to the global
 * config (handles workflows created before per-workflow reaudit existed) and
 * finally to an empty object. Field types are validated at config load
 * (validateReauditBlock) so downstream `reaudit.maxCycles || 0` reads are safe.
 */
function effectiveReaudit(workflow, cwd) {
  if (workflow && workflow.reaudit) return workflow.reaudit;
  const config = loadUserConfig(cwd);
  return config.reaudit || {};
}

/**
 * Returns the most recent pipeline phase, or null when the workflow has none.
 * No filter on `lastMcpResult` — callers that need deltas check the field
 * themselves and bail when it's missing (e.g., a custom workflow that ran
 * a pipeline phase but skipped `/agentwright:check-deltas`).
 */
function lastPipelinePhase(workflow) {
  if (!Array.isArray(workflow.phases)) return null;
  for (let i = workflow.phases.length - 1; i >= 0; i--) {
    const p = workflow.phases[i];
    if (p && p.type === 'pipeline') return p;
  }
  return null;
}

/**
 * Deterministic replay decision: replay if delta crosses the configured
 * thresholds AND we're under the cycle cap.
 */
function decideReplayDeterministic(deltas, { reauditCycles, reaudit }) {
  // Reaudit field types are validated at config load (validateReauditBlock),
  // so reads here trust them as numbers. Missing keys fall through the
  // resolveReaudit merge chain (workflow override → user config → DEFAULT).
  const maxCycles = reaudit.maxCycles || 0;
  if (reauditCycles >= maxCycles) {
    return { shouldReplay: false, reason: 'max-cycles-reached', deltas };
  }
  const minPct = (reaudit.minDeltaPercent || 0) / 100;
  const minLines = reaudit.minDeltaLines || 0;
  // Both thresholds disabled → deterministic replay is off. The natural read
  // of `minDeltaPercent: 0, minDeltaLines: 0` is "no threshold-based trigger";
  // a user wanting always-replay should use decisionMode:"leader" with a
  // reaudit-decision skill that always returns replay.
  if (minPct === 0 && minLines === 0) {
    return { shouldReplay: false, reason: 'thresholds-disabled', deltas };
  }
  const ratioCrossed = minPct > 0 && deltas.ratio >= minPct;
  const linesCrossed = minLines > 0 && deltas.totalDiffLines >= minLines;
  const anyCrossed = ratioCrossed || linesCrossed;
  return {
    shouldReplay: anyCrossed,
    reason: anyCrossed ? 'delta-threshold' : 'below-threshold',
    deltas,
  };
}

/**
 * Builds an LLM-facing prompt for the leader mode (reaudit-decision skill).
 * The skill reads the prompt and outputs one of: clean | replay [stages] | escalate.
 */
function buildReauditDecisionPrompt({ workflow, deltas, reaudit, reauditCycles }) {
  const changedFiles = Array.isArray(deltas.changedFiles) ? deltas.changedFiles : [];
  return [
    `Re-audit decision (cycle ${reauditCycles + 1}/${reaudit.maxCycles}):`,
    `  Workflow: ${workflow.workflowName} (${workflow.workflowId})`,
    `  Diff lines: +${deltas.totalAdded} -${deltas.totalDeleted} (total ${deltas.totalDiffLines})`,
    `  Total LOC across changed files: ${deltas.totalLoc}`,
    `  Change ratio: ${(deltas.ratio * 100).toFixed(2)}%`,
    `  Changed files (${changedFiles.length}): ${changedFiles.slice(0, 20).join(', ')}${changedFiles.length > 20 ? ', ...' : ''}`,
    `  Loopable stages: ${(reaudit.loopableStages || []).join(', ')}`,
    ``,
    `Invoke the "forgewright:reaudit-decision" skill via the Skill tool with these stats — it tells you the decision JSON shape to emit and how to pass it to workflow-advance.`,
  ].join('\n');
}

/**
 * If the workflow has finished its declared phases AND the most recent pipeline
 * phase was loopable AND deltas (captured by /agentwright:check-deltas during
 * that phase) cross the threshold AND we're under maxCycles, append a fresh
 * pipeline phase scoped to --diff and return its descriptor.
 *
 * Returns null when no replay is warranted (caller marks workflow completed).
 */
async function maybeAppendReauditPhase(cwd, workflowId) {
  const wf = loadWorkflow(cwd, workflowId);
  const lastPipe = lastPipelinePhase(wf);
  if (!lastPipe || !lastPipe.loopable) return null;

  const reaudit = effectiveReaudit(wf, cwd);
  const reauditCycles = wf.reauditCycles || 0;
  if (reauditCycles >= (reaudit.maxCycles || 0)) return null;

  // Deltas were captured by /agentwright:check-deltas during the last pipeline
  // phase and stored on phase.lastMcpResult by advanceWorkflow. If they're
  // missing, we have nothing to base a replay decision on — bail rather than
  // re-spawning a fresh agentwright run just to compute them.
  const deltas = lastPipe.lastMcpResult;
  if (!deltas || typeof deltas.totalDiffLines !== 'number') return null;

  if (reaudit.decisionMode === 'leader') {
    return {
      kind: 'reaudit-decision',
      workflowId,
      reauditCycles,
      maxCycles: reaudit.maxCycles || 0,
      deltas,
      loopableStages: reaudit.loopableStages || [],
      prompt: buildReauditDecisionPrompt({ workflow: wf, deltas, reaudit, reauditCycles }),
      respondInstruction:
        `Invoke the "forgewright:reaudit-decision" skill via the Skill tool — follow its rubric end-to-end (it covers the JSON shape, the workflow-advance call, and the routing). ` +
        `Workflow id for the workflow-advance call: ${workflowId}. Continue your descriptor loop on whatever workflow-advance returns.`,
    };
  }

  const decision = decideReplayDeterministic(deltas, { reauditCycles, reaudit });
  if (!decision.shouldReplay) return null;

  const newPhase = buildReplayPipelinePhase(reaudit.loopableStages, reauditCycles);
  await appendReplayPhaseAndBumpCycles(cwd, workflowId, newPhase);
  // Signal to the lifecycle caller that a phase was pushed and the next
  // descriptor must be rebuilt. The previous design called back into
  // workflow-lifecycle via a lazy `require` to dodge the import cycle —
  // returning a sentinel here lets the call graph flow in one direction.
  return { kind: 'replay-appended', workflowId };
}

/**
 * Atomically appends a freshly-built replay pipeline phase to the workflow,
 * bumps reauditCycles, and (optionally) attaches `lastReauditDecision`. Both
 * deterministic and leader paths use this so push+bump semantics live in one
 * place — future telemetry/validation hooks add here, not in two callers.
 */
async function appendReplayPhaseAndBumpCycles(cwd, workflowId, newPhase, extraFields = {}) {
  await mutateWorkflow(cwd, workflowId, w => {
    const newIndex = w.phases.length;
    // Names must stay unique within the workflow. The buildReplayPipelinePhase
    // default ("reaudit-N") collides only if the user happened to declare a
    // phase by that exact name — vanishingly rare, but not zero. Suffix until
    // unique so the invariant holds.
    const taken = new Set(w.phases.map(p => p && p.name).filter(Boolean));
    let uniqueName = newPhase.name;
    let suffix = 2;
    while (taken.has(uniqueName)) {
      uniqueName = `${newPhase.name}-r${suffix++}`;
    }
    w.phases.push({
      ...newPhase,
      name: uniqueName,
      index: newIndex,
      status: 'pending',
    });
    w.reauditCycles = (w.reauditCycles || 0) + 1;
    for (const [k, v] of Object.entries(extraFields)) {
      w[k] = v;
    }
    return w;
  });
}

/**
 * Builds a reaudit replay pipeline phase. agentwright's `start` subcommand has
 * no `--stages` flag — it accepts a comma-separated stage list as the FIRST
 * positional, with scope as the second positional. So the stages live in
 * `pipelineName`, not in `scope`. `validateScope` in agentwright would reject
 * any multi-flag scope like `--diff --stages X,Y,Z`.
 */
function buildReplayPipelinePhase(loopableStages, reauditCycles) {
  const stages = Array.isArray(loopableStages)
    ? loopableStages.filter(s => typeof s === 'string' && s.length > 0)
    : [];
  const pipelineName = stages.length > 0 ? stages.join(',') : 'default';
  const cycle = reauditCycles + 1;
  return {
    type: 'pipeline',
    // Auto-generated, unique by cycle — matches PHASE_NAME_PATTERN. Workflows
    // can never declare a phase named "reaudit-N" themselves (validateWorkflowDefinition
    // accepts the shape, but the reaudit-applier owns the namespace at runtime
    // — collision would require the user to manually craft `reaudit-1` in
    // their workflow AND hit reaudit cycle 1, which is acceptable since they'd
    // get a clear duplicate-name error at append time via name uniqueness).
    name: `reaudit-${cycle}`,
    pipelineName,
    scope: '--diff',
    loopable: true,
    idempotent: false,
    reauditCycle: cycle,
  };
}

// --- Decision-branch helpers -------------------------------------------------
// Each one handles ONE decision branch from a leader-mode reaudit-decision
// payload. Each takes (cwd, workflowId, decisionPayload[, ctx]) and returns
// the next descriptor. handleReauditDecision below is a small dispatcher.

async function applyCleanDecision(cwd, workflowId, decisionPayload) {
  await mutateWorkflow(cwd, workflowId, w => {
    w.status = 'completed';
    w.completedAt = new Date().toISOString();
    w.lastReauditDecision = decisionPayload;
    return w;
  });
  return { kind: 'done', workflowId };
}

async function applyEscalateDecision(cwd, workflowId, decisionPayload) {
  await mutateWorkflow(cwd, workflowId, w => {
    w.status = 'paused';
    w.escalationReason = decisionPayload.reason || null;
    w.lastReauditDecision = decisionPayload;
    return w;
  });
  return {
    kind: 'paused',
    workflowId,
    prompt: `Reaudit escalated: ${decisionPayload.reason || '(no reason given)'}`,
    respondInstruction:
      `Surface the escalation reason to the user via wrightward_send_message(audience="user"), ` +
      `then either /forgewright:workflow-stop ${workflowId} to abort, ` +
      `or /forgewright:workflow-resume ${workflowId} once the user resolves the underlying concern.`,
  };
}

async function applyReplayCapDecision(cwd, workflowId, decisionPayload, { reauditCycles, maxCycles }) {
  // The leader picked "replay" but we are at the cycle cap. Silently marking
  // the workflow completed would lie to the user — surface as escalation so
  // the user can either bump maxCycles (resume) or accept current state (stop).
  const reason = decisionPayload.reason
    ? `Leader requested another reaudit cycle ("${decisionPayload.reason}") but maxCycles=${maxCycles} is reached.`
    : `Leader requested another reaudit cycle but maxCycles=${maxCycles} is reached.`;
  await mutateWorkflow(cwd, workflowId, w => {
    w.status = 'paused';
    w.escalationReason = reason;
    w.lastReauditDecision = decisionPayload;
    return w;
  });
  return {
    kind: 'paused',
    workflowId,
    reauditCycles,
    maxCycles,
    suppressedDecision: decisionPayload,
    prompt: `Reaudit cap reached. ${reason}`,
    respondInstruction:
      `Surface this to the user via wrightward_send_message(audience="user") with the suppressed decision and reason. ` +
      `If the user wants more cycles, run \`/forgewright:workflow-resume ${workflowId} --bump-reaudit-cycles 1\` ` +
      `(replace 1 with N to grant N more cycles — the flag atomically bumps the workflow's frozen maxCycles, ` +
      `since edits to .claude/forgewright.json do not affect a running workflow). ` +
      `If the user accepts the current state, run /forgewright:workflow-stop ${workflowId}.`,
  };
}

async function applyReplayDecision(cwd, workflowId, decisionPayload, { reauditCycles, reaudit }) {
  const stages = decisionPayload.decision === 'replay-full'
    ? []
    : (Array.isArray(decisionPayload.stages)
        ? decisionPayload.stages.filter(s => typeof s === 'string' && s.length > 0)
        : (reaudit.loopableStages || []));
  const newPhase = buildReplayPipelinePhase(stages, reauditCycles);
  await appendReplayPhaseAndBumpCycles(cwd, workflowId, newPhase, {
    lastReauditDecision: decisionPayload,
  });
  return { kind: 'replay-appended', workflowId };
}

/**
 * Consumes a leader-mode reaudit decision when the workflow is at end-of-phases.
 * Dispatches to one of four branch handlers based on `decisionPayload.decision`.
 * Returns the next descriptor (done / phase / paused / error).
 */
async function handleReauditDecision(cwd, workflowId, decisionPayload) {
  const wf = loadWorkflow(cwd, workflowId);
  const reaudit = effectiveReaudit(wf, cwd);
  const reauditCycles = wf.reauditCycles || 0;
  const maxCycles = reaudit.maxCycles || 0;
  const decision = decisionPayload.decision;

  if (decision === 'clean') {
    return applyCleanDecision(cwd, workflowId, decisionPayload);
  }
  if (decision === 'escalate') {
    return applyEscalateDecision(cwd, workflowId, decisionPayload);
  }
  if (decision === 'replay' || decision === 'replay-full') {
    if (reauditCycles >= maxCycles) {
      return applyReplayCapDecision(cwd, workflowId, decisionPayload, { reauditCycles, maxCycles });
    }
    return applyReplayDecision(cwd, workflowId, decisionPayload, { reauditCycles, reaudit });
  }
  return {
    kind: 'error',
    workflowId,
    code: 'invalid-reaudit-decision',
    detail: `Unknown reaudit decision: ${JSON.stringify(decision)}. Expected one of: clean, replay, replay-full, escalate.`,
  };
}

module.exports = {
  lastPipelinePhase,
  decideReplayDeterministic,
  buildReauditDecisionPrompt,
  maybeAppendReauditPhase,
  handleReauditDecision,
  buildReplayPipelinePhase,
};
