'use strict';

const fs = require('fs');
const path = require('path');
const { appendJsonLine, readJson } = require('../io');
const { workflowDir } = require('../paths');
const { validateHandoffBatchResult } = require('../wrightward-contract');
const { consumesStem } = require('../artifacts');

const TYPE = 'handoff';

/**
 * The handoff phase is the leader's "do the implementation" phase. The leader:
 *   1. Surveys live peers via wrightward.
 *   2. Decomposes the work — either (a) reads the artifact named by `consumes`
 *      and treats each item as a task, or (b) breaks the directive into
 *      subtasks itself.
 *   3. Dispatches tasks to peers (round-robin / availability-based).
 *   4. Falls back to executing tasks itself when no peers are available.
 *   5. Polls inbox for acks; re-dispatches on rejection/timeout.
 *   6. Reports a batch summary.
 *
 * This phase is NOT a fanout — there is no automatic algorithm. The leader
 * decides everything: how to split, who to send to, what to keep for itself.
 * The descriptor below provides the inputs (directive, consumes, files); the
 * slash command provides the runbook.
 */

function readConsumedItems(cwd, workflow, phase) {
  const consumes = phase.consumes;
  if (!consumes) return null; // null signals "no preset items — leader decomposes"
  // Consumes can be "plan" or "plan.md"; the registry stores by stem.
  const stem = consumesStem(consumes);
  // If consumes is set, the producing phase must have completed and registered
  // an artifact path. Missing path or missing file is an upstream contract
  // break (producing skill crashed, file deleted, path drift). Surface it
  // loudly instead of pretending the artifact had zero items — that would
  // silently skip dispatch and the leader would think there's nothing to do.
  const artifactRel = workflow.artifacts ? workflow.artifacts[stem] : null;
  if (!artifactRel) {
    throw new Error(
      `Handoff phase ${phase.index}: artifact "${consumes}" was never recorded by an upstream phase.`
    );
  }
  const wfDir = workflowDir(cwd, workflow.workflowId);
  const artifactAbs = path.isAbsolute(artifactRel) ? artifactRel : path.join(wfDir, artifactRel);
  if (!fs.existsSync(artifactAbs)) {
    throw new Error(
      `Handoff phase ${phase.index}: artifact "${consumes}" recorded at ${artifactRel} but the file is missing on disk.`
    );
  }
  // Best-effort JSON read; if the artifact is .md, the leader will read it itself.
  if (!artifactAbs.endsWith('.json')) return null;
  const data = readJson(artifactAbs);
  if (!data) return [];
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.items)) return data.items;
  return [];
}

function buildHeader(phase, workflow, items) {
  const directive = (phase.directive || '').trim();
  const consumesLine = phase.consumes
    ? `Items to dispatch live in the "${phase.consumes}" artifact (under .claude/forgewright/workflows/${workflow.workflowId}/). Each item should already name its scope.`
    : `No preset item list. You decompose the directive into independent subtasks based on the plan and current state.`;
  const itemsHint = items === null
    ? '(decomposition is up to you — read the plan, decide whether to split)'
    : `(${items.length} item${items.length === 1 ? '' : 's'} preset by the producing skill)`;
  return [
    `LEADER role — dispatch implementation; fall back to executing yourself when no peers are available.`,
    ``,
    `Directive: ${directive || '(see the consumed artifact)'}`,
    `Items: ${itemsHint}`,
    `${consumesLine}`,
    ``,
  ];
}

function buildStep1Survey() {
  return [
    `Step 1 — survey peers`,
    `  Call wrightward_whoami once to confirm your own handle (record it as <leader-handle>).`,
    `  Call wrightward_bus_status to discover live peer handles. Check wrightward_list_inbox once for any pending events you missed (the channel push will wake you for new ones; you do NOT need to keep polling).`,
    `  Available peers = any handle that has been active recently and is NOT yours.`,
    ``,
  ];
}

function buildStep2Decompose(phase) {
  const decomposeLine = phase.consumes
    ? `  Read the "${phase.consumes}" artifact. Treat each item as one task. If items don't name a skill or scope, infer from the plan/context.`
    : `  Read the plan + relevant context. Break the directive into INDEPENDENT subtasks (each with disjoint file scope). If the work is small, leave it as a single task — don't over-decompose.`;
  return [
    `Step 2 — decompose`,
    decomposeLine,
    `  Each task gets a stable key (e.g. "task-1", or the item's "key" field).`,
    ``,
    `Step 2.5 — choose dispatch shape\n  - Small directive (single module / few files): execute yourself.\n  - Larger directive (multi-module, multi-file): dispatch to peers per disjoint scope. The plan-step boundaries are usually the right split.`,
    ``,
  ];
}

function buildStep3Dispatch(taskRefBase) {
  return [
    `Step 3 — dispatch`,
    `  For each task you DON'T keep for yourself:`,
    `    - If a peer is available: wrightward_send_handoff with`,
    `        to:             "<peer handle>"`,
    `        task_ref:       "${taskRefBase}:<task-key>"`,
    `        next_action:    <task body — see leader-rules below>`,
    `        files_unlocked: <task's file scope>`,
    `      Record the returned handoff id alongside the task key.`,
    `    - If all peers are busy / no peers connected: execute the task yourself in this session, the same way you would if no orchestrator were running.`,
    `  Round-robin across peers; one task per peer at a time when possible.`,
    ``,
  ];
}

function buildLeaderRules() {
  return [
    `Leader-rules to include in every dispatched next_action body:`,
    `  """`,
    `  You are working under a leader (handle: <leader-handle>).`,
    `  - Do NOT contact the user (audience="user"). The leader owns user comms.`,
    `  - If you need a decision, hit ambiguity, or want to expand scope, ask the leader via`,
    `    wrightward_send_message(audience="<leader-handle>", body="..."). Do not improvise.`,
    `  - Send the leader a brief progress message at least every 15 minutes while working — even if`,
    `    it's just "still on it, currently editing X". If you fall silent past 15 min the leader will`,
    `    ping you asking for a status update — reply promptly so you don't get marked unresponsive.`,
    `  - When done, call wrightward_ack on this handoff id.`,
    `  - Surface findings (bugs, gotchas) via wrightward_send_note(kind="finding").`,
    `  Task: <task body>`,
    `  Files in your scope: <files>`,
    `  """`,
    ``,
  ];
}

function buildStep4Settle(workflowId) {
  return [
    `Step 4 — settle (event-driven, no polling)`,
    `  The wrightward channel push will wake you when peers ack or message you. Between wake-ups, work on tasks you kept for yourself.`,
    `  - On wake-up, call wrightward_list_inbox once to drain pending events. For each dispatched task:`,
    `    - accepted ack → mark task completed, by: "peer:<handle>".`,
    `    - rejected ack → re-dispatch to a different peer; if none available, do it yourself.`,
    `    - peer message asking a decision → reply via wrightward_send_message(audience="<peer-handle>", body="..."). You can also proactively ping peers (audience="<peer-handle>") to clarify scope, share progress, or coordinate.`,
    `    - peer progress message → record the timestamp; the silent-peer check below uses it.`,
    `  - Self-executed tasks are marked by: "self".`,
    `  - Idle behavior: when all dispatches are out, all self-tasks done, and there's nothing else to do, call ScheduleWakeup(delaySeconds=900, reason="silent-peer check", prompt="/forgewright:workflow-resume ${workflowId}") and return control. The wake-up fires in 15 minutes; channel push will wake you sooner if a peer event arrives. Resume — not run — because the workflow already exists; workflow-run takes a workflow NAME (no dots) while the ID contains dots.`,
    `  - Silent-peer check (on every wake): any peer that has not acked AND has not sent a progress message in the last 15 minutes — send wrightward_send_message(audience="<peer-handle>", body="status check — still on it?"). They'll either reply (alive) or the send fails synchronously (peer not bound, agent gone). Both are unambiguous; no second timeout layer is needed.`,
    ``,
  ];
}

function buildStep5Advance(workflowId) {
  return [
    `Step 5 — advance`,
    `  Build a batch result:`,
    `    { tasks: [`,
    `        { key: "<task-key>", by: "peer:<handle>"|"self", status: "completed"|"failed"|"skipped", ackId?: "<id>", detail?: "..." },`,
    `        ...`,
    `      ] }`,
    `  Then:`,
    `    node \${CLAUDE_PLUGIN_ROOT}/coordinator/index.js workflow-advance \\`,
    `      --workflow ${workflowId} --result completed --mcp-result '<json>'`,
    `  If any task ultimately failed (rejected by every available peer AND the leader couldn't complete it),`,
    `  send wrightward_send_message(audience="user", body="<failure summary>") and call workflow-advance --result failed.`,
  ];
}

// Composes the leader instruction from per-step builders. Reads as a table
// of contents: header → 5 steps + the leader-rules block dispatched peers
// must echo. Each builder is independently scannable / editable; small
// per-section tweaks no longer require counting offsets inside a 70-line
// array literal.
function buildInstruction(phase, workflow, items) {
  const taskRefBase = `${workflow.workflowId}:phase-${phase.name}`;
  return [
    ...buildHeader(phase, workflow, items),
    ...buildStep1Survey(),
    ...buildStep2Decompose(phase),
    ...buildStep3Dispatch(taskRefBase),
    ...buildLeaderRules(),
    ...buildStep4Settle(workflow.workflowId),
    ...buildStep5Advance(workflow.workflowId),
  ].join('\n');
}

function buildDescriptor(phase, workflow, ctx = {}) {
  const hasDirective = typeof phase.directive === 'string' && phase.directive.trim().length > 0;
  const hasConsumes = typeof phase.consumes === 'string' && phase.consumes.length > 0;
  if (!hasDirective && !hasConsumes) {
    throw new Error(`Handoff phase ${phase.index} requires "directive" or "consumes" (or both).`);
  }
  const cwd = ctx.cwd || process.cwd();
  const items = readConsumedItems(cwd, workflow, phase);
  return {
    kind: 'phase',
    type: TYPE,
    workflowId: workflow.workflowId,
    phaseIndex: phase.index,
    phaseName: phase.name,
    directive: phase.directive || null,
    consumes: phase.consumes || null,
    taskRefBase: `${workflow.workflowId}:phase-${phase.name}`,
    presetItemCount: Array.isArray(items) ? items.length : null,
    instruction: buildInstruction(phase, workflow, items),
  };
}

function validateResult(result, phase) {
  if (!result || typeof result !== 'object') {
    throw new Error('Handoff phase result must be an object.');
  }
  if (!result.mcpResult) {
    throw new Error(
      `Handoff phase ${phase.index} requires --mcp-result <batch-json> on completion.`
    );
  }
  validateHandoffBatchResult(result.mcpResult);
  return true;
}

/**
 * Logs the dispatched handoffs to peer-handoffs.jsonl for resume idempotence
 * and post-hoc auditability. Writes one line per task in the batch.
 */
function recordBatch(cwd, workflow, phase, batch) {
  if (!batch || !Array.isArray(batch.tasks)) return;
  try {
    const file = path.join(workflowDir(cwd, workflow.workflowId), 'peer-handoffs.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const recordedAt = new Date().toISOString();
    for (const task of batch.tasks) {
      appendJsonLine(file, {
        phaseIndex: phase.index,
        phaseName: phase.name,
        taskRef: `${workflow.workflowId}:phase-${phase.name}:${task.key}`,
        taskKey: task.key,
        by: task.by || null,
        status: task.status,
        ackId: task.ackId || null,
        detail: task.detail || null,
        recordedAt,
      });
    }
  } catch (err) {
    // Best-effort: do not fail the workflow on audit-log write errors (disk
    // full, permission, EIO), but surface to stderr so the operator can see
    // that peer-handoff auditability is degraded for this phase.
    process.stderr.write(
      `forgewright: failed to record peer-handoff audit for phase "${phase.name}" (${phase.index}): ${err.message}\n`
    );
  }
}

module.exports = { TYPE, buildDescriptor, validateResult, buildInstruction, recordBatch, readConsumedItems };
