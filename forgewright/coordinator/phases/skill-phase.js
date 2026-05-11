'use strict';

const { parseProduces, consumesStems } = require('../artifacts');

const TYPE = 'skill';

const PLANNING_SKILLS = new Set([
  'agentwright:feature-planning',
  'agentwright:bug-fix-planning',
  'agentwright:refactor-planning',
]);

const VERIFY_PLAN_SKILL = 'agentwright:verify-plan';

function planningClarificationBlock() {
  return [
    ``,
    `User Q&A — planning is interactive:`,
    `  - For every clarifying question, use AskUserQuestion. wrightward intercepts AskUserQuestion via a PreToolUse hook and routes to whichever channel (CLI / Discord) the user's most recent message came from. The user's answer is returned to you transparently in updatedInput.`,
    `  - Do not call wrightward_send_message(audience="user") for questions during planning — that is one-way, and breaks the AskUserQuestion answer return path. Reserve send_message for proactive notifications (checkpoints, failures, post-plan escalations).`,
    `  - If AskUserQuestion times out or returns an explicit "no answer" sentinel, surface a checkpoint and exit; the user resumes when ready.`,
  ].join('\n');
}

function verifyPlanFollowupBlock() {
  return [
    ``,
    `Deviation handling — the verify-plan skill walks Steps A→D for every finding. forgewright overlay on Step C ("fix obvious issues immediately"):`,
    `  - SMALL obvious fix (single test, single method, single import, revert one out-of-scope edit): apply it yourself, in this session. Cheap, local, verifies the plan; no peer needed.`,
    `  - BIG obvious fix (entire skipped implementation step, multi-file feature, architectural deviation that should have been a peer's task in the first place): do NOT do it yourself. Dispatch a side-channel handoff via wrightward_send_handoff with the leader-rules block embedded — same shape as a workflow handoff phase, just outside the phase machinery. task_ref: "<workflowId>:verify-plan-fix:<finding-id>". Wait for the ack via channel push. If no peer is available, fall back to executing yourself.`,
    `  - Step D ("defer judgment") items: do NOT fix or dispatch. Send wrightward_send_message(audience="user", body="<finding summary + your read of why it's ambiguous>") and pause for the user's call before advancing.`,
    `  - When the table reports zero findings or all are invalid/fixed: advance with --result completed.`,
    `  - When you dispatched corrective handoffs and they all completed: advance with --result completed.`,
    `  - When the user vetoed a deferred finding (told you to skip it) or you're blocked: advance with --result failed and a clear --mcp-result detail.`,
  ].join('\n');
}

function defaultInstruction(phase) {
  const lines = [
    `Invoke the "${phase.skillId}" skill via the Skill tool.`,
  ];
  if (phase.consumes) {
    // Multi-consume support: skill phases can declare consumes as either a
    // single string ("plan") or an array of stems (["research", "peer-opinions"]).
    // For the single-string case we keep the existing wording so the legacy
    // tests / instructions are stable; for arrays we emit one bullet per stem.
    const isArray = Array.isArray(phase.consumes);
    const stems = consumesStems(phase.consumes);
    if (!isArray) {
      // phase.consumes is a string here; preserve the original phrasing.
      const parsedConsumes = parseProduces(phase.consumes);
      const consumeEntry = parsedConsumes && parsedConsumes.kind === 'single' ? parsedConsumes.entries[0] : null;
      const consumeFilename = consumeEntry && consumeEntry.hasExtension
        ? `artifacts/${consumeEntry.filename}`
        : `artifacts/${phase.consumes}.{md,json}`;
      lines.push(`This phase consumes the "${consumeEntry ? consumeEntry.stem : phase.consumes}" artifact — read it from ${consumeFilename} under the workflow directory before invoking the skill.`);
    } else {
      const fileBullets = phase.consumes.map((entry) => {
        const parsed = parseProduces(entry);
        const entryEntry = parsed && parsed.kind === 'single' ? parsed.entries[0] : null;
        const filename = entryEntry && entryEntry.hasExtension
          ? `artifacts/${entryEntry.filename}`
          : `artifacts/${entry}.{md,json}`;
        const stem = entryEntry ? entryEntry.stem : entry;
        return `  - "${stem}" → ${filename}`;
      }).join('\n');
      lines.push(`This phase consumes ${stems.length} upstream artifacts — read all of them from under the workflow directory before invoking the skill:\n${fileBullets}`);
    }
  }
  if (phase.produces) {
    const parsedProduces = parseProduces(phase.produces);
    // Skills are single-output for now; if a workflow author put a multi map
    // on a skill, we just narrate the first entry and trust the skill.
    const produceEntry = parsedProduces ? parsedProduces.entries[0] : null;
    if (produceEntry && produceEntry.hasExtension) {
      lines.push(`This phase produces the "${produceEntry.stem}" artifact — write the skill's output to artifacts/${produceEntry.filename} and report the path back via \`workflow-advance --artifact-path <path>\`.`);
    } else {
      lines.push(`This phase produces the "${phase.produces}" artifact — write the skill's output to artifacts/${phase.produces}.{md,json} (pick the right extension) and report the path back via \`workflow-advance --artifact-path <path>\`.`);
    }
  }
  lines.push('When the skill finishes, call workflow-advance --result completed.');
  let body = lines.join(' ');
  if (PLANNING_SKILLS.has(phase.skillId)) {
    body += '\n' + planningClarificationBlock();
  }
  if (phase.skillId === VERIFY_PLAN_SKILL) {
    body += '\n' + verifyPlanFollowupBlock();
  }
  return body;
}

function buildDescriptor(phase, workflow) {
  if (!phase.skillId || typeof phase.skillId !== 'string') {
    throw new Error(`Skill phase ${phase.index} requires a "skillId".`);
  }
  return {
    kind: 'phase',
    type: TYPE,
    skillId: phase.skillId,
    workflowId: workflow.workflowId,
    phaseIndex: phase.index,
    phaseName: phase.name,
    produces: phase.produces || null,
    consumes: phase.consumes || null,
    instruction: phase.instruction || defaultInstruction(phase),
  };
}

function validateResult(result, phase) {
  if (!result || typeof result !== 'object') {
    throw new Error('Skill phase result must be an object.');
  }
  // --artifact-path is only required for bare-form produces (`"plan"`), where
  // the skill picks the extension at write time. Extension-form produces
  // (`"plan.md"`) is auto-registered from the produces config alone — same
  // behavior as command phases, mirroring workflow-lifecycle's auto-stamp at
  // line 176-178.
  if (phase.produces && !result.artifactPath) {
    const parsed = parseProduces(phase.produces);
    const requiresPath = parsed && parsed.kind === 'single' && !parsed.entries[0].hasExtension;
    if (requiresPath) {
      throw new Error(
        `Skill phase "${phase.skillId}" declares produces:"${phase.produces}" — ` +
        `--artifact-path is required (bare-form produces; skill picks the extension).`
      );
    }
  }
  return true;
}

module.exports = { TYPE, buildDescriptor, validateResult, defaultInstruction };
