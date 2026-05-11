---
name: workflow-resume
description: Resume a paused forgewright workflow. Use after a checkpoint, after the user resolves a non-idempotent re-run prompt, or after walking away from a workflow mid-run. The leader Claude session re-enters at the last unfinished phase and continues the descriptor loop.
argument-hint: <workflow-id>
---

Resume a workflow paused at a checkpoint, or re-enter a workflow you walked away from. You are the **leader** session — same role as `/forgewright:workflow-run`.

## Pre-flight

Call `mcp__plugin_wrightward_wrightward-bus__wrightward_whoami` once. Record your handle as `<leader-handle>`. If unbound, surface install instructions and exit.

## Step 1 — resume

!`CLAUDE_PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT}" node "${CLAUDE_PLUGIN_ROOT}/coordinator/index.js" workflow-resume --workflow $ARGUMENTS`

If the user passes `--bump-reaudit-cycles N` after the workflow ID (used to escape a "Reaudit cap reached" pause), forgewright will atomically raise the workflow's frozen `reaudit.maxCycles` by N before resuming. The shell already forwards the flag through `$ARGUMENTS` — no special handling needed.

The output JSON includes a `descriptor`. Branch on its `kind` per the descriptor loop documented in `/forgewright:workflow-run`:

- `phase` (skill / pipeline / command / handoff) — execute per its `instruction`. For `handoff`, you decompose, dispatch to peers, fall back to executing yourself if none, and report the batch.
- `checkpoint` — send the Discord notification, display the summary, exit cleanly.
- `paused` — non-idempotent phase that was previously started. The user picks re-run / skip / abort.
- `reaudit-decision` — invoke the `forgewright:reaudit-decision` skill via the Skill tool on the deltas and follow its rubric end-to-end (JSON shape, workflow-advance call, and routing are all there). On an `escalate` result, surface the reason to the user via `wrightward_send_message` before exiting.
- `done` / `cancelled` / `error` — print summary, exit.

## Step 2 — continue the descriptor loop

After every `workflow-advance` or `workflow-resume`, the coordinator returns the next descriptor. Repeat the branch until you reach a terminal kind.

## Reminder — leader role

- **Plan-driven implementation**: decompose into tasks, dispatch to available peers via `wrightward_send_handoff`. If no peers are connected (or all are busy), execute the tasks yourself.
- **Audit-finding fixes** (during pipeline phases): apply them yourself. This is verification. Drive each pipeline by invoking `/agentwright:audit-run` so its rules load. Deferred findings: industry-standard wins → fix yourself; subjective tradeoffs → ask the user.
- **User comms**: reactive Q&A goes through `AskUserQuestion` (wrightward's hook routes to the user's current channel). Proactive notifications (checkpoints, failures, deferred-finding decisions, post-plan ambiguity, peer escalations) go through `wrightward_send_message(audience="user")`. Once the user has approved the plan, you have implementation autonomy — but surface anything subjective.
- Don't poll the inbox; the wrightward channel push wakes you on events.
- Never bypass the wrightward guard hook on file-claim conflicts.
