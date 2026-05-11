'use strict';

const { mutateWorkflow, loadWorkflow } = require('./workflow-ledger');
const skillPhase = require('./phases/skill-phase');
const pipelinePhase = require('./phases/pipeline-phase');
const commandPhase = require('./phases/command-phase');
const checkpointPhase = require('./phases/checkpoint-phase');
const handoffPhase = require('./phases/handoff-phase');
const { validateHandoffBatchResult } = require('./wrightward-contract');
const {
  maybeAppendReauditPhase,
  handleReauditDecision,
  buildReplayPipelinePhase,
} = require('./reaudit-applier');
const { parseProduces, consumesStems } = require('./artifacts');

const PHASE_HANDLERS = {
  [skillPhase.TYPE]: skillPhase,
  [pipelinePhase.TYPE]: pipelinePhase,
  [commandPhase.TYPE]: commandPhase,
  [checkpointPhase.TYPE]: checkpointPhase,
  [handoffPhase.TYPE]: handoffPhase,
};

function getHandler(type) {
  const handler = PHASE_HANDLERS[type];
  if (!handler) {
    throw new Error(`Unknown phase type: ${type}`);
  }
  return handler;
}

function isTerminal(workflow) {
  return workflow.status === 'completed'
    || workflow.status === 'cancelled'
    || workflow.status === 'failed';
}

function terminalDescriptor(workflow) {
  if (workflow.status === 'completed') {
    return { kind: 'done', workflowId: workflow.workflowId };
  }
  if (workflow.status === 'cancelled') {
    return { kind: 'cancelled', workflowId: workflow.workflowId };
  }
  return {
    kind: 'error',
    workflowId: workflow.workflowId,
    code: 'workflow-failed',
    detail: 'Workflow is in a failed state.',
  };
}

/**
 * Builds the descriptor for the workflow's CURRENT phase (no advance).
 * If the index points past the last phase, considers re-audit replay before
 * marking the workflow completed. Phase status (running) is persisted; if the
 * phase is a checkpoint, workflow.status is set to "paused".
 */
async function buildAndPersistDescriptor(cwd, workflowId) {
  // Snapshot read for terminal / end-of-phases — these cases either return
  // immediately or hand off to maybeAppendReauditPhase, which itself takes
  // the workflow lock. Doing them inside the active-phase lock below would
  // either deadlock (mutateWorkflow inside mutateWorkflow) or hold the lock
  // across nested re-audit work that doesn't need it.
  const wf = loadWorkflow(cwd, workflowId);
  if (isTerminal(wf)) return terminalDescriptor(wf);

  if (wf.currentPhaseIndex >= wf.phases.length) {
    const replayDescriptor = await maybeAppendReauditPhase(cwd, workflowId);
    if (replayDescriptor) {
      // 'replay-appended' is a sentinel from reaudit-applier — it pushed a
      // pipeline phase and needs us to build the descriptor for it. Anything
      // else (reaudit-decision prompt) is a descriptor proper.
      if (replayDescriptor.kind === 'replay-appended') {
        return buildAndPersistDescriptor(cwd, workflowId);
      }
      return replayDescriptor;
    }
    await mutateWorkflow(cwd, workflowId, w => {
      w.status = 'completed';
      w.completedAt = new Date().toISOString();
      return w;
    });
    return { kind: 'done', workflowId };
  }

  // Active phase: take the workflow lock across the read-build-persist
  // sequence so phase status and startedAt land atomically. Pipeline phases
  // are descriptor-only since the LLM drives /agentwright:audit-run via the
  // Skill tool — no subprocess spawned here, no agentwright runId to track.
  let descriptor;
  await mutateWorkflow(cwd, workflowId, async (w) => {
    if (w.currentPhaseIndex >= w.phases.length) {
      // Index advanced under us — bail; the caller re-enters from the top.
      return w;
    }
    const phase = w.phases[w.currentPhaseIndex];
    const handler = getHandler(phase.type);
    descriptor = await handler.buildDescriptor(phase, w, { cwd });
    if (!descriptor) return w;

    if (descriptor.kind === 'checkpoint') {
      phase.status = 'awaiting-resume';
      w.status = 'paused';
    } else {
      phase.status = 'running';
      phase.startedAt = phase.startedAt || new Date().toISOString();
      w.status = 'running';
    }
    return w;
  });

  if (!descriptor) {
    return buildAndPersistDescriptor(cwd, workflowId);
  }
  return descriptor;
}

/**
 * Records the result of the current phase and advances to the next.
 * Returns the next descriptor (or done/cancelled/error).
 *
 * Special case: when the workflow is at end-of-phases (after a leader-mode
 * reaudit-decision prompt), an mcpResult.decision payload is consumed here
 * rather than being treated as a phase result. The decision drives whether
 * the workflow is marked complete, escalated, or extended with a fresh
 * pipeline phase.
 */
async function advanceWorkflow(cwd, workflowId, params) {
  const { result, artifactPath, mcpResult, skip } = params || {};

  // Leader-mode reaudit-decision: at end-of-phases with a decision payload.
  const wfPre = loadWorkflow(cwd, workflowId);
  if (
    !isTerminal(wfPre) &&
    wfPre.currentPhaseIndex >= wfPre.phases.length &&
    !skip &&
    result === 'completed' &&
    mcpResult && typeof mcpResult.decision === 'string'
  ) {
    const decisionResult = await handleReauditDecision(cwd, workflowId, mcpResult);
    if (decisionResult && decisionResult.kind === 'replay-appended') {
      return buildAndPersistDescriptor(cwd, workflowId);
    }
    return decisionResult;
  }

  await mutateWorkflow(cwd, workflowId, w => {
    if (w.currentPhaseIndex >= w.phases.length) return w;
    const phase = w.phases[w.currentPhaseIndex];
    if (!phase) return w;

    if (phase.type === 'checkpoint') {
      throw new Error(
        'Cannot advance past a checkpoint via workflow-advance. Use workflow-resume to continue past a checkpoint.'
      );
    }

    if (skip) {
      phase.status = 'skipped';
      phase.completedAt = new Date().toISOString();
    } else if (result === 'completed') {
      const handler = getHandler(phase.type);
      handler.validateResult({ artifactPath, mcpResult }, phase);
      phase.status = 'completed';
      phase.completedAt = new Date().toISOString();
      // Artifact registration. Two paths:
      //   1. Leader passed --artifact-path AND produces is single → register by stem.
      //      Keeps the existing skill contract working (skill picks the file
      //      and reports its actual path; supports cases where extension is
      //      decided at write time, e.g., "plan" → "plan.md" or "plan.json").
      //   2. produces is multi (object map) OR single with extension → forgewright
      //      knows the canonical path(s) from the produces config alone, so we
      //      auto-register all entries that have explicit filenames.
      if (phase.produces) {
        const parsed = parseProduces(phase.produces);
        if (parsed) {
          w.artifacts = w.artifacts || {};
          // Auto-register every entry that has an explicit filename. Path is
          // workflow-scoped: <wfDir>/artifacts/<filename>, recorded relative
          // to the workflow dir (matches how readConsumedItems resolves).
          const explicit = parsed.entries.filter(e => e.hasExtension);
          for (const entry of explicit) {
            w.artifacts[entry.stem] = `artifacts/${entry.filename}`;
          }
          // Single + extension: also stamp phase.artifactPath for back-compat.
          if (parsed.kind === 'single' && parsed.entries[0].hasExtension) {
            phase.artifactPath = `artifacts/${parsed.entries[0].filename}`;
          }
          // Leader-supplied --artifact-path takes precedence on single shape
          // (skill that chose its own path / extension at write time).
          if (artifactPath && parsed.kind === 'single') {
            phase.artifactPath = artifactPath;
            w.artifacts[parsed.entries[0].stem] = artifactPath;
          }
        }
      }
      if (mcpResult !== undefined) {
        phase.lastMcpResult = mcpResult;
        // For handoff phases, log the batch to peer-handoffs.jsonl for auditability.
        if (phase.type === 'handoff') {
          try {
            const batch = validateHandoffBatchResult(mcpResult);
            handoffPhase.recordBatch(cwd, w, phase, batch);
          } catch (err) {
            // Workflow advance is the primary path; audit-log writes are
            // best-effort. Surface the failure to stderr instead of silently
            // dropping it — auditability is a documented goal.
            process.stderr.write(
              `forgewright: failed to record handoff batch for phase "${phase.name}" (${phase.index}): ${err.message}\n`
            );
          }
        }
      }
    } else if (result === 'failed') {
      phase.status = 'failed';
      phase.failedAt = new Date().toISOString();
      w.status = 'failed';
      return w;
    } else {
      throw new Error(`Unknown result: ${result}. Expected "completed" or "failed".`);
    }
    w.currentPhaseIndex += 1;
    return w;
  });

  return buildAndPersistDescriptor(cwd, workflowId);
}

/**
 * Resumes a workflow. If the current phase is a checkpoint, advance past it.
 * If the current phase is non-idempotent and was previously started, return a
 * paused prompt sentinel. Otherwise build the next descriptor.
 */
async function resumeWorkflow(cwd, workflowId, { force = false } = {}) {
  const wf = loadWorkflow(cwd, workflowId);
  if (isTerminal(wf)) return terminalDescriptor(wf);

  if (wf.currentPhaseIndex >= wf.phases.length) {
    const replayDescriptor = await maybeAppendReauditPhase(cwd, workflowId);
    if (replayDescriptor) {
      if (replayDescriptor.kind === 'replay-appended') {
        return buildAndPersistDescriptor(cwd, workflowId);
      }
      return replayDescriptor;
    }
    await mutateWorkflow(cwd, workflowId, w => {
      w.status = 'completed';
      w.completedAt = new Date().toISOString();
      return w;
    });
    return { kind: 'done', workflowId };
  }

  const phase = wf.phases[wf.currentPhaseIndex];

  if (phase.type === 'checkpoint') {
    await mutateWorkflow(cwd, workflowId, w => {
      const p = w.phases[w.currentPhaseIndex];
      if (p) {
        p.status = 'completed';
        p.completedAt = new Date().toISOString();
      }
      w.currentPhaseIndex += 1;
      return w;
    });
    return buildAndPersistDescriptor(cwd, workflowId);
  }

  if (!force && phase.idempotent === false && phase.startedAt) {
    return {
      kind: 'paused',
      workflowId,
      phaseIndex: phase.index,
      phaseType: phase.type,
      prompt: buildIdempotencePrompt(phase, wf),
      respondInstruction:
        `Display the prompt to the user. If the user wants to re-run, call ` +
        `\`node coordinator/index.js workflow-resume --workflow ${workflowId} --force\`. ` +
        `If the user wants to skip the phase, call ` +
        `\`node coordinator/index.js workflow-advance --workflow ${workflowId} --skip\`. ` +
        `If the user wants to abort, call /forgewright:workflow-stop ${workflowId}.`,
    };
  }

  // --force on a non-idempotent phase that already started means "actually
  // re-run from fresh", per the prompt wording. Forgewright now treats every
  // pipeline phase as atomic from the LLM's POV — there is no agentwright
  // runId tracked here, so resetting the phase to pending is enough; the
  // re-built descriptor will tell the LLM to invoke /agentwright:audit-run
  // afresh, which spawns a new agentwright run with its own runId+snapshot.
  if (force && phase.idempotent === false && phase.startedAt) {
    await resetPhaseForRerun(cwd, workflowId, phase.index);
  }

  return buildAndPersistDescriptor(cwd, workflowId);
}

async function resetPhaseForRerun(cwd, workflowId, phaseIndex) {
  await mutateWorkflow(cwd, workflowId, w => {
    const phase = w.phases[phaseIndex];
    if (!phase) return w;
    phase.startedAt = null;
    phase.status = 'pending';
    return w;
  });
}

/**
 * Returns the artifact stems a phase consumes. Delegates to the shared
 * `consumesStems` helper so every phase type (skill, handoff, command)
 * uses the same string-or-array normalization. Returns [] when consumes
 * is absent or unparseable.
 */
function consumeStemsOf(phase) {
  if (!phase || !phase.consumes) return [];
  try {
    return consumesStems(phase.consumes);
  } catch {
    // Defensive: config validation has already rejected malformed consumes
    // by the time we get here, so the throw is only reachable via direct
    // calls from outside the lifecycle path. Treat as "no recognizable stems".
    return [];
  }
}

/**
 * Finds every later phase whose `consumes` references one of the given
 * produce stems. Used by buildIdempotencePrompt to warn the user that
 * skipping a producer phase will break downstream consumers (otherwise the
 * skip succeeds and the next consumer's descriptor build throws a cryptic
 * "artifact was never recorded" error).
 */
function findDownstreamConsumers(produceStems, phases, currentIndex) {
  const out = [];
  if (!Array.isArray(phases) || produceStems.length === 0) return out;
  for (let i = currentIndex + 1; i < phases.length; i++) {
    const p = phases[i];
    if (!p) continue;
    for (const stem of consumeStemsOf(p)) {
      if (produceStems.includes(stem)) {
        out.push({ phaseName: p.name, phaseIndex: i, stem });
      }
    }
  }
  return out;
}

function buildIdempotencePrompt(phase, workflow) {
  const parts = [
    `Phase "${phase.name}" (${phase.type}, index ${phase.index}) is non-idempotent and was previously started.`,
    `Re-running may regenerate snapshots, dispatch handoffs again, or re-execute side effects.`,
  ];
  // Surface downstream impact when this phase produces an artifact later
  // phases consume. Without this, picking "skip" silently advances past the
  // producer and the next consumer's descriptor-build throws "artifact was
  // never recorded" — leaving the user unable to connect their skip choice
  // to the cascade failure that follows.
  if (phase.produces && workflow && Array.isArray(workflow.phases)) {
    const parsed = parseProduces(phase.produces);
    if (parsed) {
      const produceStems = parsed.entries.map(e => e.stem);
      const consumers = findDownstreamConsumers(produceStems, workflow.phases, phase.index);
      if (consumers.length > 0) {
        const grouped = consumers
          .map(c => `"${c.stem}" needed by phase "${c.phaseName}" (index ${c.phaseIndex})`)
          .join(', ');
        parts.push(
          `Skipping will break downstream phase(s) that depend on this phase's artifact(s): ${grouped}.`
        );
      }
    }
  }
  parts.push(`Re-run, skip, or abort?`);
  return parts.join(' ');
}

module.exports = {
  PHASE_HANDLERS,
  getHandler,
  buildAndPersistDescriptor,
  advanceWorkflow,
  resumeWorkflow,
  buildIdempotencePrompt,
  findDownstreamConsumers,
  isTerminal,
  // Re-exported from reaudit-applier so existing test imports keep working
  // and external callers don't need to know which module owns these.
  maybeAppendReauditPhase,
  buildReplayPipelinePhase,
  handleReauditDecision,
};
