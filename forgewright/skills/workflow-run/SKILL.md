---
name: workflow-run
description: Start a forgewright workflow (plan → peer-handoff → verify → audit → tests). Use when the user wants the leader Claude session to orchestrate a multi-phase workflow, dispatching plan-driven implementation to peer Claude sessions over wrightward and applying audit-finding fixes itself.
argument-hint: <workflow-name> [args]
---

You are the **leader** Claude session. Your role:

- Plan, audit, verify, run pipelines.
- **Decompose plan-driven implementation into tasks and dispatch them to peers.** When no peers are available (or all are busy/unreachable), execute the tasks yourself in this session.
- **Apply audit-finding fixes yourself during pipeline phases.** That is verification, not plan-driven implementation. Drive each pipeline by invoking `/agentwright:audit-run` so its rules load into your context — do not duplicate them here.

The dividing line: **plan-driven** changes (broad scope, multi-file, design intent) → decompose + delegate to peers (you fall back to executing yourself if none). **Audit-finding fixes** (narrow, mechanical) → leader applies them directly.

### User comms — channel-aware

The workflow command itself may have arrived via CLI OR via Discord (the wrightward bridge can relay slash commands). Either way, the same routing rule applies:

- **Reactive Q&A** (clarifying questions during planning, etc.): use `AskUserQuestion`. wrightward intercepts it via a PreToolUse hook and routes to whichever channel the user's last message used. The user's answer comes back to you transparently in `updatedInput`. Do NOT call `wrightward_send_message(audience="user")` for questions — that's one-way and doesn't return the answer.
- **Proactive notifications** (checkpoints, failures, deferred-finding decisions, post-plan escalations): use `wrightward_send_message(audience="user", body="...")`. This always goes to Discord; the user reads it on whichever device they're on.
- **Post-plan-acceptance autonomy with escalations**: once the user has approved the plan (resume past the plan-review checkpoint), you own implementation autonomy. EXCEPT — message the user (`audience="user"`) for: (a) deferred audit findings that aren't clear industry-standard wins, (b) ambiguity in plan execution that the plan itself doesn't resolve, (c) peer escalations you can't decide, (d) scope expansions. Approved plans don't license silent surprises.

## Pre-flight: confirm wrightward is bound

Call `mcp__plugin_wrightward_wrightward-bus__wrightward_whoami` once before the first descriptor. Record your handle as `<leader-handle>` — peers will address you via `audience="<leader-handle>"`. If whoami errors with "MCP server not bound" or the tool is missing, surface the install instructions and exit:

```
forgewright requires wrightward >= 3.10.4.
Install:  /plugin install wrightward@Joys-Dawn/toolwright
Note:     wrightward's bus and Discord work in CLI and IDE extensions alike. Only wrightward's between-turn channel doorbell is CLI-only — and that applies to peers as much as to the leader. In extensions the leader falls back to a 15-min ScheduleWakeup cadence for idle peer-settle, and idle peers in extensions only see handoffs on their next user-driven turn. Run leader AND peers from plain CLI terminals for autonomous dispatch.
```

## Step 1 — start the workflow

!`node ${CLAUDE_PLUGIN_ROOT}/coordinator/index.js workflow-start $ARGUMENTS`

Extract `workflowId` and `descriptor` from the output JSON.

## Step 2 — loop on the descriptor's kind

Read the descriptor's `instruction` every iteration and follow it. The actions per kind:

### `phase` type=skill
Invoke the named skill via the Skill tool. If `produces` is set, write the artifact under `.claude/forgewright/workflows/<workflowId>/artifacts/`:
- **`produces: "plan.md"` (extension form)**: write to `artifacts/plan.md`. The descriptor's instruction names the canonical filename; forgewright auto-registers it.
- **`produces: "plan"` (bare form)**: pick the right extension and write to `artifacts/plan.<ext>`. Pass the chosen path on advance via `--artifact-path artifacts/plan.<ext>`.

Then advance:

```
node ${CLAUDE_PLUGIN_ROOT}/coordinator/index.js workflow-advance --workflow <workflowId> --result completed [--artifact-path artifacts/<file>]
```

For `agentwright:verify-plan`, `agentwright:feature-planning`, `agentwright:bug-fix-planning`, `agentwright:refactor-planning`, and `agentwright:plan-quality-review` the descriptor's `instruction` includes specific routing/branching guidance — follow it exactly.

### `phase` type=pipeline
The phase is **atomic from forgewright's POV** — you (the leader) drive everything end-to-end. The descriptor's `instruction` is the source of truth; the steps below are an overview. Use `descriptor.pipelineName` and `descriptor.scope` (passed as the audit-run argument) and the `agentwrightCli` from the original `workflow-start` output (for the `cleanup-snapshot` shell call). Forgewright does NOT spawn agentwright and does NOT track runIds.

1. Invoke `/agentwright:audit-run` via the Skill tool with `"<pipelineName> <scope>"`. Audit-run handles start, the finding-decision loop, and the verifier subagent. **Capture the runId** from audit-run's start JSON (printed on stdout in step 1 of audit-run's workflow).
2. **Before** cleanup, invoke `/agentwright:check-deltas` with the runId — the snapshot must still exist on disk. Capture the JSON output (this becomes `--mcp-result` below).
3. Run cleanup yourself: `node <agentwrightCli> cleanup-snapshot --run <runId> --group 0`.
4. Evaluate **deferred** findings audit-run produced:
   - Clear, obvious, industry-standard wins (even big refactors) → apply the fix yourself, even though originally deferred. Do NOT ping the user.
   - Subjective / design tradeoffs / scope-expanding → message the user via `wrightward_send_message(audience="user")` and await their call.
5. Advance, passing the check-deltas JSON as `--mcp-result`:

```
node ${CLAUDE_PLUGIN_ROOT}/coordinator/index.js workflow-advance --workflow <workflowId> --result completed --mcp-result '<check-deltas JSON>'
```

The check-deltas payload is what the end-of-workflow re-audit reads to decide whether to replay. Skipping check-deltas means re-audit can't trigger.

### `phase` type=handoff — **the dispatch loop**

You decompose. You dispatch. You fall back when peers are absent. Follow the descriptor's `instruction` — it has the full runbook. Summary:

**Step 1 — survey peers** (`wrightward_bus_status` once; `wrightward_list_inbox` once to drain pending events). Live peers = handles on the bus other than `<leader-handle>`.

**Step 2 — decompose.** If `descriptor.consumes` is set, treat each artifact entry as one task. Otherwise break the directive into independent subtasks with disjoint file scope.

**Step 2.5 — choose dispatch shape.** Small directive (single module / few files) → execute yourself. Larger directive (multi-module, multi-file) → dispatch to peers per disjoint scope. Plan-step boundaries are usually the right split.

**Step 3 — dispatch** per task you don't keep:

```
wrightward_send_handoff
  to:             "<peer handle>"
  task_ref:       "<descriptor.taskRefBase>:<task-key>"
  next_action:    <body — leader-rules block below>
  files_unlocked: <task's file scope>
```

Round-robin across peers; one task per peer at a time when possible. Tasks with no available peer → leader executes, marked `by: "self"`.

**Leader-rules block to embed verbatim in every `next_action` body:**

```
You are working under a leader (handle: <leader-handle>).
- Do NOT contact the user (audience="user"). The leader owns user comms.
- If you need a decision, hit ambiguity, or want to expand scope, ask the leader via
  wrightward_send_message(audience="<leader-handle>", body="..."). Do not improvise.
- Send the leader a brief progress message at least every 15 minutes while working — even if
  it's just "still on it, currently editing X". If you fall silent past 15 min the leader will
  ping you asking for a status update; reply promptly so you don't get marked unresponsive.
- When done, call wrightward_ack on this handoff id.
- Surface findings (bugs, gotchas) via wrightward_send_note(kind="finding").
Task: <task body — directive, consumed-item details, plan path>
Files in your scope: <files>
```

**Step 4 — settle (event-driven, no polling).** The wrightward channel push wakes you when peers ack or message you. Between wake-ups, work on tasks you kept for yourself.
- On wake-up, drain the inbox (one `wrightward_list_inbox` call) and react:
  - accepted ack → mark `completed`, `by: "peer:<handle>"`.
  - rejected ack → re-dispatch to a different peer; if none, execute yourself.
  - peer message asking a decision → reply via `wrightward_send_message(audience="<peer-handle>", body="...")`. You can also proactively message peers to clarify scope or check progress.
  - peer progress message → record the timestamp; the silent-peer check below uses it.
- **Idle behavior**: when all dispatches are out, all self-tasks are done, and there's nothing else to do, call `ScheduleWakeup(delaySeconds=900, reason="silent-peer check", prompt="/forgewright:workflow-resume <workflowId>")` and return control. Re-enter via `workflow-resume`, NOT `workflow-run` — workflow IDs contain dots (e.g., `2026-04-29T01-23-45-678Z-feature-a1b2c3d4`) and would be rejected by `validateWorkflowName`. The wake-up fires in 15 minutes; channel push wakes you sooner if a peer event arrives.
- **Silent-peer check (on every wake)**: any peer that has not acked AND has not sent a progress message in the last 15 minutes — send `wrightward_send_message(audience="<peer-handle>", body="status check — still on it?")`. They'll either reply (alive) or the send fails synchronously (peer not bound, agent gone). Both are unambiguous; no second-timeout layer is needed.

**Step 5 — advance**
Build the batch result and advance:

```json
{
  "tasks": [
    { "key": "task-1", "by": "peer:bob-42", "status": "completed", "ackId": "evt-..." },
    { "key": "task-2", "by": "self", "status": "completed" },
    { "key": "task-3", "by": "peer:sam-17", "status": "failed", "detail": "..." }
  ]
}
```

```
node ${CLAUDE_PLUGIN_ROOT}/coordinator/index.js workflow-advance --workflow <workflowId> --result completed --mcp-result '<json>'
```

If any task failed irrecoverably, send `wrightward_send_message(audience="user", body="<summary>")` and call `--result failed` instead.

### `phase` type=command
If `descriptor.command === '${TEST_CMD}'`, follow the descriptor's discovery order: (1) check for a local `/run-tests` skill and invoke it if present, (2) else infer from package.json / pytest.ini / Cargo.toml / go.mod / Makefile / CI config / README. Otherwise run `descriptor.command` verbatim — `${ARTIFACTS}` and any `${ARTIFACT.<stem>}` tokens are already substituted to project-relative paths. Capture exit code + summary.

If `descriptor.consumes` is non-empty, the listed upstream artifacts have already been validated (registered + present on disk) — you don't need to re-check. If you want to read one yourself before/after the command, the resolved paths are in each `descriptor.consumes[i].path`.

If the descriptor has an `instruction` field (overlay for non-test commands like backtests, training scripts), follow it: read the artifact(s) the command produced, decide whether to advance with `completed` or `failed`, and put the structured decision into `summary` (a JSON blob is fine — downstream phases and end-of-workflow re-audit read it from `phase.lastMcpResult`).

```
node ${CLAUDE_PLUGIN_ROOT}/coordinator/index.js workflow-advance --workflow <workflowId> --result completed --mcp-result '{"command":"<cmd>","exitCode":N,"summary":"..."}'
```

When the phase declares `produces` with an extension (single or multi-map), the script must write to those filenames inside `${ARTIFACTS}`. Forgewright reads the produces config and auto-registers each entry under its stem — no `--artifact-path` flag needed. For bare-name `produces` on a command phase, pass `--artifact-path <path-you-wrote>`.

### `checkpoint`
Send the Discord notification per the descriptor's instruction (`wrightward_send_message audience="user"`), display the same summary in the terminal, then **exit cleanly**. The user resumes with `/forgewright:workflow-resume <workflowId>`. Do NOT poll.

### `paused`
Print the `prompt` to the user. Their answer maps to:
- re-run → `workflow-resume --workflow <id> --force`
- skip → `workflow-advance --workflow <id> --skip`
- abort → `/forgewright:workflow-stop <id>`

### `reaudit-decision`
Invoke the **`forgewright:reaudit-decision`** skill via the Skill tool with `descriptor.deltas` and `descriptor.loopableStages` — follow its rubric end-to-end (JSON shape, workflow-advance call, and routing are all there). On an `escalate` result, surface the reason via `wrightward_send_message(audience="user")` before exiting; the user resumes via `/forgewright:workflow-resume <id>` or aborts via `/forgewright:workflow-stop <id>`.

### `done` / `cancelled` / `error`
Print a one-line summary and exit. Pipeline-phase snapshots were already cleaned up by you (step 3 of each pipeline phase); agentwright's own orphan-snapshot sweep handles anything left behind from a hung run.

Repeat step 2 until you reach a terminal kind.

## Failure handling

- `workflow-advance --result failed` marks the workflow failed. No automatic recovery. Surface to the user via Discord, then exit.
- File-claim conflict (guard hook block) → never bypass. Re-dispatch to a different peer, or wait for the file to free up.

## Rules

- Never blindly trust audit findings — re-read cited code, contradict, reason from first principles. When a finding is accepted, you (the leader) apply the fix; this is verification, not implementation.
- Never bypass the wrightward guard hook. The legitimate uses of `wrightward_send_message(audience="user")` are: checkpoints, failures, deferred-finding decisions that require user judgment, ambiguity post-plan-acceptance, and peer escalations. Reactive Q&A goes through `AskUserQuestion` (wrightward's hook routes it).
- Plan-driven changes → decompose and dispatch. Audit-finding fixes → apply yourself. Deferred-finding fixes that are obvious industry wins → apply yourself; subjective ones → ask the user.
- No peers ≠ stop. No peers means you do the work yourself.
- Don't poll the inbox. The wrightward channel push wakes you on urgent events; drain `wrightward_list_inbox` once per wake-up.
