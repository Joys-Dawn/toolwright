# forgewright

> Multi-agent workflow orchestrator. One Claude Code session is the **leader** that plans, drives audit pipelines, verifies, and talks to you. Other sessions are **peers** that pick up implementation handoffs. `/forgewright:workflow-run feature "..."` strings plan → plan-quality-review → checkpoint → handoff(implement) → verify-plan → audit pipeline → tests into one resumable orchestration.

**Version**: 0.1.0 · [Source](https://github.com/Joys-Dawn/toolwright/tree/master/forgewright) · [README](https://github.com/Joys-Dawn/toolwright/blob/master/forgewright/README.md)

## Install

```text
/plugin marketplace add Joys-Dawn/toolwright
/plugin install agentwright@Joys-Dawn/toolwright
/plugin install wrightward@Joys-Dawn/toolwright
/plugin install forgewright@Joys-Dawn/toolwright
/forgewright:config-init
```

`config-init` writes `.claude/forgewright.json` with every default populated and resolves the agentwright CLI path. Every later workflow start re-verifies agentwright and wrightward versions and refreshes the path automatically.

### Requirements

- Node.js ≥ 18
- agentwright ≥ 2.1.5
- wrightward ≥ 3.10.4
- One leader Claude Code session, plus zero or more peer sessions in the same repo. With zero peers, the leader executes handoff tasks itself.

> **Plain CLI sessions strongly recommended for the leader AND the peers.** wrightward's bus and Discord bridge work everywhere (CLI and IDE extensions alike). The piece extensions don't deliver is wrightward's between-turn **channel doorbell** — the wake-up ping that lets an idle session notice bus events without a new user prompt. Forgewright relies on it on both sides of a handoff: a leader in an extension falls back to a 15-min `ScheduleWakeup` cadence for idle peer-settle; a peer in an extension only sees a handoff on its next tool call, which means an idle peer effectively won't pick it up until you nudge them. Workflows still complete end-to-end in extensions; they're just not autonomous in the dispatch step. Run leaders and peers from plain CLI terminals for proper event-driven handoffs.

## Using it

```text
/forgewright:workflow-run feature "Add markdown export to the notes feature"
/forgewright:workflow-run bug-fix "API returns 500 on empty body"
/forgewright:workflow-run refactor "Split the user-service god class"
/forgewright:workflow-resume <workflow-id>                       # past a checkpoint or prompt
/forgewright:workflow-resume <workflow-id> --bump-reaudit-cycles 1   # grant another re-audit cycle
/forgewright:workflow-stop <workflow-id>                         # cancel + signal peers to abort
/forgewright:workflow-status                                     # list all workflows
/forgewright:workflow-status <workflow-id>                       # detail one
/forgewright:config-init                                         # write config + resolve agentwright path
```

A workflow ID looks like `2026-04-29T01-23-45-678Z-feature-a1b2c3d4`. Every skill that takes one accepts the full form.

## How it runs

A workflow is a sequence of typed phases. The leader walks them in order — for each phase the coordinator emits a descriptor describing what to do, the leader executes it, advances, and gets the next descriptor. You hear from the leader on Discord at checkpoints, on test failures, on deferred audit findings that need your judgment, and on completion.

The dividing line: **plan-driven implementation** (broad scope, multi-file, design intent) goes to peers via handoff (leader falls back to executing if none are available). **Audit-finding fixes** during pipeline phases stay with the leader — that's verification, not implementation. Deferred audit findings that are obvious industry-standard wins get applied by the leader; subjective tradeoffs are surfaced to you.

| Phase | What happens |
|---|---|
| `skill` | Leader invokes a named skill via the Skill tool. Any skill works — agentwright skills (what the built-in workflows use: `agentwright:feature-planning`, `agentwright:plan-quality-review`, `agentwright:verify-plan`, `agentwright:bug-fix-planning`, `agentwright:refactor-planning`, `agentwright:systematic-debugging`, …), wrightward skills, other plugins' skills, or your repo-local skills. Plugin skills require the `plugin:skill` form; bare names only resolve to repo-local skills. May `produce` an artifact (plan, diagnosis) or `consume` one. forgewright overlays extra guidance for a few known skill IDs (planning skills get `AskUserQuestion` routing rules; `agentwright:verify-plan` gets deviation-handling rules) but does not restrict which skill you can call. |
| `pipeline` | Leader drives an agentwright audit pipeline by invoking `/agentwright:audit-run` via the Skill tool — same Steps A→D verification flow as a hand-run audit. Forgewright does not spawn agentwright; the leader runs it in its own context so the audit rules load. After the pipeline, the leader calls `/agentwright:check-deltas` and passes the JSON back via `--mcp-result` so the end-of-workflow re-audit logic has diff stats to work with. |
| `handoff` | Leader decomposes the work, dispatches one task per available peer over wrightward (`wrightward_send_handoff`), and falls back to executing leftovers itself. Settles event-driven — wrightward's channel push wakes the leader on peer events; between wake-ups the leader works on tasks it kept. The leader reports a single batch result with each task's outcome. |
| `command` | Leader runs a shell command. `${TEST_CMD}` resolves to `tests.command` if set, else the leader infers it from the project. `${ARTIFACTS}` substitutes to the workflow's artifacts dir; `${ARTIFACT.<stem>}` substitutes to the registered path of a specific upstream artifact (throws at descriptor-build time if the stem isn't registered or the file is missing — silent failure mode killed). Optional `instruction` field tells the leader how to interpret the output beyond the exit code (e.g. "compare backtest Sharpe to baseline; accept if v2 wins by ≥0.05"). |
| `checkpoint` | Leader posts a Discord summary and exits cleanly. You resume when ready. |

Walk away mid-workflow at any time — the leader exits cleanly at checkpoints and between phases. State persists in `.claude/forgewright/workflows/<id>/`. Resume re-enters at the last unfinished phase; re-running a phase that already side-effected prompts you first (re-run / skip / abort).

After the last declared phase, the leader measures changes since the audit pipeline ran (from the `check-deltas` JSON captured during the pipeline phase). If the change crosses `reaudit.minDeltaPercent` or `reaudit.minDeltaLines`, a fresh audit pipeline runs on `reaudit.loopableStages` with `--diff`. Capped at `reaudit.maxCycles`; when the cap is hit the workflow pauses with a "Reaudit cap reached" reason — resume with `--bump-reaudit-cycles N` to grant N more cycles atomically (no hand-editing `workflow.json`). Set `reaudit.decisionMode: "leader"` to let the leader judge case-by-case via the `reaudit-decision` skill (`clean` / `replay [stages]` / `replay-full` / `escalate`).

## User comms

Two channels depending on direction:

- **Reactive Q&A** during planning uses Claude's native `AskUserQuestion`. wrightward intercepts via a `PreToolUse` hook and routes the question to whichever channel (CLI or Discord) you most recently replied on; the answer comes back to the leader transparently.
- **Proactive notifications** (checkpoints, failures, deferred-finding decisions, peer escalations, scope expansions) use `wrightward_send_message(audience="user")` and always go to Discord.

Past the plan-review checkpoint the leader has implementation autonomy, but it still surfaces ambiguity, deferred findings that aren't clear industry-standard wins, peer escalations, and scope-expansion calls.

## Built-in workflows

| Workflow | Phases (in order) |
|---|---|
| `feature` | plan → plan-quality-review → **plan-review checkpoint** → handoff(implement) → verify-plan → audit pipeline (default, `--diff`, loopable) → tests |
| `bug-fix` | systematic-debugging → bug-fix-planning → **fix-plan-review checkpoint** → handoff(implement fix) → verify-plan → audit pipeline (default, `--diff`, loopable) → tests |
| `refactor` | refactor-planning → plan-quality-review → **refactor-plan-review checkpoint** → `test-coverage` pipeline (writes characterization tests) → pre-refactor-tests → handoff(refactor) → verify-plan → audit pipeline (default, `--diff`, loopable) → post-refactor-tests |

`refactor` writes characterization tests **before** the refactor so behavior preservation is enforced — those tests must keep passing through the refactor. `feature`'s audit pipeline includes `test-coverage`, so the leader writes any missing tests in-line via the audit-run decision loop — no separate test-writing handoff phase is needed.

Define your own under `workflows.<name>` in `.claude/forgewright.json` — see [`forgewright.example.json`](https://github.com/Joys-Dawn/toolwright/blob/master/forgewright/forgewright.example.json). All five phase types are available. Every phase needs a `name` (identifier-safe `[A-Za-z][A-Za-z0-9_-]*`, unique within the workflow) — it shows up in status, logs, and peer `task_ref` strings.

`produces` and `consumes` thread artifacts between phases:

- `produces` accepts a bare name (`"plan"` — leader picks the extension), an explicit filename (`"plan.md"` — auto-registered, no `--artifact-path` needed), or a `{ name: filename }` map for command phases that write multiple files.
- `consumes` is a string on skill / handoff phases; string OR array of strings on command phases. The named stems are validated to be registered AND present on disk at descriptor-build time, so a missing or renamed upstream artifact fails loudly instead of silently breaking the dependent phase.

Custom workflow names override built-in ones — redefining `feature` replaces the built-in entirely.

## Skills

Forgewright exposes everything as skills (invoke via `/forgewright:<name>` or via the `Skill` tool):

| Skill | Args | Purpose |
|---|---|---|
| `/forgewright:workflow-run` | `<workflow-name> [args]` | Start a workflow (leader role). |
| `/forgewright:workflow-resume` | `<workflow-id> [--bump-reaudit-cycles <n>]` | Re-enter a paused or interrupted workflow at the last unfinished phase. `--bump-reaudit-cycles N` atomically raises the workflow's frozen `reaudit.maxCycles` by N — used to grant more cycles after a "Reaudit cap reached" pause. |
| `/forgewright:workflow-stop` | `<workflow-id>` | Cancel. Marks the workflow `cancelled` and (if it had in-flight peer handoffs) broadcasts an abort signal to peers. Peer cancel is best-effort — peers may not see it until their next wrightward poll. |
| `/forgewright:workflow-status` | `[workflow-id]` | List workflows or detail one. |
| `/forgewright:config-init` | `[--force]` | Write `.claude/forgewright.json` and resolve the agentwright CLI path. |
| `/forgewright:reaudit-decision` | (auto-invoked) | Leader judgment for end-of-workflow re-audit when `decisionMode: "leader"`. Given diff stats, outputs `clean` / `replay [stages]` / `replay-full` / `escalate`. Driven by the workflow loop; not normally called by hand. |

## Config

`.claude/forgewright.json` (all fields optional). Run `/forgewright:config-init` to drop a fully-defaulted example into your repo; see [`forgewright.example.json`](https://github.com/Joys-Dawn/toolwright/blob/master/forgewright/forgewright.example.json).

```json
{
  "workflows": {
    "solo-feature": { "phases": [...] }
  },
  "reaudit": {
    "maxCycles": 1,
    "minDeltaPercent": 5,
    "minDeltaLines": 0,
    "decisionMode": "deterministic",
    "loopableStages": ["correctness", "behavior", "security"]
  },
  "agentwright": { "path": null },
  "tests": { "command": null },
  "retention": {
    "keepCompletedWorkflows": 2,
    "maxWorkflowAgeDays": 7
  }
}
```

| Key | Default | Description |
|---|---|---|
| `workflows.<name>.phases` | — | Custom workflow definition. |
| `workflows.<name>.reaudit` | — | Per-workflow override of any `reaudit.*` key (shallow merge over the top-level block). Frozen onto the workflow at start; later edits don't retroactively change a running workflow. |
| `workflows.<name>.tests` | — | Per-workflow override of `tests.command` (and future `tests.*` keys). Same shallow-merge + freeze semantics. |
| `reaudit.maxCycles` | 1 | Cap on end-of-workflow re-audit replays. |
| `reaudit.minDeltaPercent` | 5 | Replay if `(added+deleted lines) / total LOC ≥ this`. Set to 0 to disable the percent threshold. |
| `reaudit.minDeltaLines` | 0 | Replay if absolute changed lines ≥ this. Set to 0 to disable. Either active threshold triggers replay; setting BOTH to 0 turns deterministic replay off. |
| `reaudit.decisionMode` | `"deterministic"` | `"deterministic"` (threshold-based) or `"leader"` (leader runs `reaudit-decision`). |
| `reaudit.loopableStages` | `["correctness","behavior","security"]` | Stages eligible for replay. |
| `agentwright.path` | resolved by `config-init` | Absolute path to agentwright's CLI. Auto-refreshed at every workflow start; falls back to a plugin-cache walk if unset. |
| `tests.command` | null | Explicit `${TEST_CMD}` value; null = leader infers from the project. |
| `retention.keepCompletedWorkflows` | 2 | Newest N completed workflows always kept regardless of age. |
| `retention.maxWorkflowAgeDays` | 7 | Prune older completed workflows. |

## State

Each workflow lives under `.claude/forgewright/workflows/<workflowId>/`:

- `workflow.json` — phase status, current phase index, args, frozen `reaudit` and `tests` configs, artifact registry, timestamps. Drives `workflow-status` and `workflow-resume`.
- `artifacts/` — files produced by phases (`plan.md`, `diagnosis.md`, `metrics.json`, etc.). Each registered by stem so downstream phases can `consume` them.
- `peer-handoffs.jsonl` — one line per dispatched task: phase index/name, `task_ref`, peer handle or `"self"`, ack id, status, detail.

Pruned per the retention policy at every workflow start. Resumable across sessions.
