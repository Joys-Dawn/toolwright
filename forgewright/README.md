# forgewright

Multi-agent workflow orchestrator for Claude Code. One Claude session is the **leader** — it plans, drives audit pipelines, verifies, and is the only session that talks to you. Other Claude sessions in the same repo are **peers** that pick up implementation handoffs. forgewright collapses the manual "now plan, now audit the plan, now have peer X implement step 1, now verify, now run the audit pipeline, now run tests" loop into a single resumable command.

```
You ↔ Leader Claude  ──── plans, audits, verifies, posts to Discord
              │
              │ wrightward_send_handoff
              ▼
       Peer Claude(s) ──── implement, ack the leader (or — zero peers — the leader does it)
```

- **One command per workflow.** `/forgewright:workflow-run feature "..."` runs plan → plan-quality-review → checkpoint → handoff(implement) → verify-plan → audit pipeline → tests → update-docs end-to-end.
- **Plan-driven implementation goes to peers.** The leader decomposes the plan into independent tasks and dispatches them across whatever peer sessions are connected. With zero peers, the leader executes the tasks itself.
- **Audit fixes stay with the leader.** Mechanical, narrow-scope fixes happen during pipeline phases on the same Steps A→D verification flow as `/agentwright:audit-run`. Subjective tradeoffs are surfaced to you on Discord.
- **You stay in the loop on Discord.** The leader posts at every checkpoint, on test failures, on deferred audit findings that need your judgment, and on completion.
- **Resumable.** Walk away mid-workflow. State persists; resume with `/forgewright:workflow-resume <workflow-id>`.
- **Built on agentwright + wrightward.** Audit pipelines come from agentwright; peer messaging and Discord routing come from wrightward.

## Installation

```
/plugin marketplace add Joys-Dawn/toolwright
/plugin install agentwright@Joys-Dawn/toolwright    # audit pipelines
/plugin install wrightward@Joys-Dawn/toolwright     # peer bus + Discord
/plugin install forgewright@Joys-Dawn/toolwright
/forgewright:config-init
```

`config-init` writes [.claude/forgewright.json](forgewright.default.json) with every default populated and resolves the agentwright CLI path. Every subsequent workflow start re-verifies agentwright and wrightward versions and refreshes the path automatically — you don't need to re-run `config-init` after an agentwright upgrade.

### Requirements

- Node.js ≥ 18
- agentwright ≥ 2.1.5
- wrightward ≥ 3.11.0
- One leader Claude Code session, plus zero or more peer sessions in the same repo. With zero peers connected the leader does all the work itself.

> **Plain CLI sessions strongly recommended for smoothest operation — both for the leader and for any peers.** wrightward's bus and Discord bridge work everywhere (CLI and IDE extensions alike). The piece that extensions don't deliver is wrightward's between-turn **channel doorbell**, the wake-up ping that lets an idle session notice bus events without a new user prompt. Forgewright relies on that doorbell on both sides of a handoff:
>
> - **Leader in an extension** — the idle peer-settle in `handoff` phases falls back to a 15-min `ScheduleWakeup` cadence instead of waking on each peer ack. The leader still settles; it just reacts slower.
> - **Peer in an extension** — bus events (including the leader's handoff) only land on the peer's next tool call, i.e. when you next prompt that peer. An idle peer waiting on a handoff effectively doesn't pick it up until you nudge them, which defeats the point of autonomous dispatch.
>
> Run leaders and peers from plain CLI terminals for proper event-driven handoffs. IDE extensions can still run a workflow end-to-end — they're just not autonomous in the dispatch step.

## Quick start

In one Claude Code session (the leader):

```
/forgewright:workflow-run feature "Add markdown export to the notes feature"
```

Open additional Claude Code sessions in the same repo as peers — implementation handoffs auto-route to them. Zero peers is fine too; the leader will do the work itself.

## How it works

### Phases

A workflow is a sequence of typed phases. Each phase produces a **descriptor** that tells the leader what to do; the leader executes it and advances. The five phase types:

| Phase | What happens |
|---|---|
| `skill` | Leader invokes a named skill via the Skill tool. Any skill works — agentwright skills (`agentwright:feature-planning`, `agentwright:plan-quality-review`, `agentwright:verify-plan`, `agentwright:bug-fix-planning`, `agentwright:refactor-planning`, `agentwright:systematic-debugging`, etc. — what the built-in workflows use), wrightward skills, other plugins' skills, or your repo-local skills (the `plugin:` prefix is required for plugin skills; bare names only resolve to repo-local). May `produce` an artifact for downstream phases or `consume` one. forgewright recognises a few skill IDs and overlays extra guidance (planning skills get `AskUserQuestion` routing rules; `agentwright:verify-plan` gets the deviation-handling rules), but it does not restrict which skill you can call. |
| `pipeline` | Leader drives an agentwright audit pipeline — the same Steps A→D verification flow as `/agentwright:audit-run`. Forgewright does not spawn agentwright itself; the leader invokes `/agentwright:audit-run` via the Skill tool so the audit rules load into its context. After the pipeline runs, the leader calls `/agentwright:check-deltas` and passes the JSON back via `--mcp-result` so the end-of-workflow re-audit logic has diff stats to work with. |
| `handoff` | Leader fans out implementation tasks to available peers via `wrightward_send_handoff`. Tasks with no available peer run on the leader. The leader settles event-driven (no polling — wrightward's channel push wakes it on peer events), and reports a single batch result with each task's outcome (`by: peer:<handle>` or `by: self`, `status: completed/failed/skipped`). |
| `command` | Leader runs a shell command. `${TEST_CMD}` resolves to the workflow's `tests.command` if set, otherwise the leader infers it from the project (run-tests skill → package.json scripts → pytest.ini → Cargo.toml → go.mod → Makefile → CI config → README). `${ARTIFACTS}` substitutes to the workflow's artifacts directory; `${ARTIFACT.<stem>}` substitutes to the registered path of an upstream artifact (throws at descriptor-build time if the stem isn't registered, so a missing or renamed upstream artifact fails loudly instead of silently breaking the command). Optional `instruction` field tells the leader how to interpret the command's output beyond the exit code (e.g. "compare backtest Sharpe to baseline; advance with summary.decision='accept' if v2 wins by >0.05"). |
| `checkpoint` | Leader posts a Discord summary and exits cleanly. You resume when ready. |

### Leader vs peer

The dividing line: **plan-driven implementation** (broad scope, multi-file, design intent) → decompose and dispatch to peers via handoff (leader falls back to executing if none). **Audit-finding fixes** during pipeline phases → leader applies them directly. Deferred audit findings that are clear industry-standard wins → leader applies them; subjective tradeoffs → leader surfaces to you on Discord.

Peers never initiate user contact. They ack the leader when done; the leader decides what reaches you.

### Discord routing

The leader uses two channels depending on direction:

- **Reactive Q&A** (clarifying questions during planning) — uses Claude's native `AskUserQuestion` tool. wrightward intercepts via a `PreToolUse` hook and routes the question to whichever channel (CLI or Discord) you most recently replied on, so you can answer wherever you are. The answer comes back to the leader transparently.
- **Proactive notifications** (checkpoints, failures, deferred-finding decisions, peer escalations, scope-expansion calls) — uses `wrightward_send_message(audience="user")`, which always goes to Discord.

Once you've approved the plan past the plan-review checkpoint the leader has implementation autonomy. It will still ping you for: deferred audit findings that aren't clear industry-standard wins, ambiguity that the plan doesn't resolve, peer escalations, and scope expansions.

### Resume

Walk away mid-workflow at any time. The leader exits cleanly at every checkpoint and between phases. `/forgewright:workflow-resume <id>` re-enters at the last unfinished phase. Re-running a phase that already side-effected (e.g. dispatched handoffs, wrote a plan) prompts you first — re-run / skip / abort.

### Peer dispatch behaviour

Inside a `handoff` phase the leader:

1. Calls `wrightward_bus_status` to find live peers (handles other than its own) and drains `wrightward_list_inbox` once.
2. Decomposes the work — by `consumes` artifact items, or by directive if no artifact.
3. Dispatches to peers round-robin with `wrightward_send_handoff`. Every dispatched task tells the peer: don't contact the user, ping the leader on ambiguity, send a progress message at least every 15 min, and ack on completion.
4. Settles event-driven: wrightward's channel push wakes the leader when a peer acks or messages it. Between wake-ups the leader works on tasks it kept for itself. When everything is dispatched and self-tasks are done it calls `ScheduleWakeup` for 15 minutes (silent-peer check) and returns control — channel push wakes it sooner if peers ack.
5. On every wake: silent peers (no ack and no progress message in 15+ min) get pinged once for a status check. They either reply or the send fails synchronously — both are unambiguous.
6. Reports a batch result via `--mcp-result`. Per-task audit trail is logged to `.claude/forgewright/workflows/<id>/peer-handoffs.jsonl`.

### Peer ↔ leader challenge protocol

Peers and the leader are colleagues, not subordinates rubber-stamping each other. When either side genuinely doubts a claim, the dispute is resolved through a formal challenge instead of back-and-forth bickering or silent compliance:

- A peer that disagrees with a leader claim or directive sends `wrightward_send_message` to the leader with a `[CHALLENGE-REQUEST]` body that quotes the claim and cites the evidence.
- The leader resolves it by running the [`agentwright:challenge`](https://github.com/Joys-Dawn/toolwright/blob/master/agentwright/skills/challenge/SKILL.md) skill on the disputed claim, then replies with `[CHALLENGE-VERDICT] <upheld|overturned|partial>: <rationale>`.
- The verdict is final. The reverse direction runs the same way — when the leader doubts a peer's claim, the leader runs the challenge themselves and posts the verdict to the peer.
- The leader also calls out repeated peer mistakes directly.

Cooperative-but-skeptical peer etiquette (the framing the protocol sits on top of) is injected into every Claude Code session on startup by wrightward 3.11+. The challenge-specific instructions ride along with every `handoff` phase the leader runs.

### End-of-workflow re-audit

After the last declared phase, the leader measures changes since the audit pipeline ran (from the `check-deltas` JSON it captured during the pipeline phase). If the change is large enough — past `reaudit.minDeltaPercent` or `reaudit.minDeltaLines` — a fresh audit pipeline runs scoped to the `reaudit.loopableStages`. Capped at `reaudit.maxCycles`. When the cap is hit the workflow pauses with a "Reaudit cap reached" reason; resume with `/forgewright:workflow-resume <id> --bump-reaudit-cycles N` to grant N more cycles atomically (no hand-editing `workflow.json`).

Switch `reaudit.decisionMode` to `"leader"` and the leader runs the [`reaudit-decision`](skills/reaudit-decision/SKILL.md) skill on each cycle, deciding case-by-case whether to `clean` (no replay), `replay` specific stages, `replay-full`, or `escalate` to you.

Setting BOTH `reaudit.minDeltaPercent: 0` and `reaudit.minDeltaLines: 0` disables deterministic replay entirely. Use `decisionMode: "leader"` if you want non-threshold replay rules.

## Skills

Forgewright exposes everything as skills (invoke via `/forgewright:<name>` or via the `Skill` tool):

| Skill | Args | Purpose |
|---|---|---|
| `/forgewright:workflow-run` | `<workflow-name> [args]` | Start a workflow (leader role). |
| `/forgewright:workflow-resume` | `<workflow-id> [--bump-reaudit-cycles <n>]` | Re-enter a paused or interrupted workflow at the last unfinished phase. `--bump-reaudit-cycles N` atomically raises the workflow's frozen `reaudit.maxCycles` by N — use it to grant more cycles after a "Reaudit cap reached" pause. |
| `/forgewright:workflow-stop` | `<workflow-id>` | Cancel. Marks the workflow `cancelled` and (if it had in-flight peer handoffs) broadcasts an abort signal to peers so they stop work. |
| `/forgewright:workflow-status` | `[workflow-id]` | List workflows, or detail one. |
| `/forgewright:config-init` | `[--force]` | Write `.claude/forgewright.json` and resolve the agentwright CLI path. |
| `/forgewright:reaudit-decision` | (auto-invoked) | Leader judgment for end-of-workflow re-audit when `decisionMode: "leader"`. Given diff stats, outputs `clean` / `replay [stages]` / `replay-full` / `escalate`. Driven by the workflow loop; not normally called by hand. |

A workflow ID looks like `2026-04-29T01-23-45-678Z-feature-a1b2c3d4` (`<ISO timestamp>-<workflow name>-<8 hex>`). Every skill that takes one accepts the full form.

## Built-in workflows

### `feature`

End-to-end feature development.

1. `plan` — `agentwright:feature-planning` skill produces `plan.md`.
2. `plan-quality-review` — `agentwright:plan-quality-review` skill audits the plan for completeness, design soundness, and risk coverage.
3. `plan-review` — **checkpoint.** Leader posts plan + review findings to Discord. You review.
4. `implement` — handoff. Leader decomposes the plan into independent tasks and dispatches to peers (or executes them itself if none).
5. `verify` — `agentwright:verify-plan` skill confirms the implementation matches the plan. Small drifts the leader fixes itself; large drifts trigger corrective handoffs.
6. `audit` — pipeline (default: implementation → correctness → best-practices → behavior → test-coverage). Loopable (eligible for end-of-workflow re-audit). The leader writes missing tests in-line via the audit-run decision loop, so no separate test-writing handoff phase is needed.
7. `tests` — command (`${TEST_CMD}`).
8. `docs` — `agentwright:update-docs` skill closes README / architecture / setup / docstring drift before the workflow exits.

```
/forgewright:workflow-run feature "Add markdown export to the notes feature"
```

### `bug-fix`

Diagnose → plan → audit-the-plan → checkpoint → fix → verify → audit → tests.

1. `diagnose` — `agentwright:systematic-debugging` skill produces `diagnosis.md`.
2. `plan` — `agentwright:bug-fix-planning` skill consumes the diagnosis and produces `plan.md`.
3. `plan-quality-review` — `agentwright:plan-quality-review` audits the fix plan for completeness and risk coverage.
4. `fix-plan-review` — checkpoint.
5. `implement` — handoff (fix per plan).
6. `verify` — `agentwright:verify-plan`.
7. `audit` — pipeline (default, `--diff`, loopable).
8. `tests` — command (`${TEST_CMD}`).

### `refactor`

Plan → review → checkpoint → write characterization tests first → refactor → verify → audit → tests → update docs. The pre-refactor `test-coverage` pipeline drives the leader to write characterization tests for any uncovered code, and the resulting tests must keep passing through the refactor — that's how behavior preservation is enforced.

1. `plan` — `agentwright:refactor-planning` skill produces `plan.md`.
2. `plan-quality-review` — `agentwright:plan-quality-review`.
3. `refactor-plan-review` — checkpoint.
4. `characterization-tests` — pipeline (`test-coverage`, `--all`). Leader writes missing tests in-line.
5. `pre-refactor-tests` — command (`${TEST_CMD}`). Snapshot of test results before the refactor.
6. `refactor` — handoff. Per the plan, behavior must remain identical.
7. `verify` — `agentwright:verify-plan`.
8. `audit` — pipeline (default, `--diff`, loopable).
9. `post-refactor-tests` — command (`${TEST_CMD}`). Compare to step 5.
10. `docs` — `agentwright:update-docs` closes documentation drift after the structural change.

### `idea-exploration`

Go/no-go evaluation for an idea you're not yet committed to building. Research the domain, sketch a tentative plan, adversarially critique it, then research again to fact-check which critiques are real. Ends at a decision checkpoint — no implementation phases.

1. `research` — `agentwright:research` skill investigates the problem domain, prior art, market validation, technical feasibility. Produces `research.md`.
2. `plan` — `agentwright:project-planning` consumes the research and produces a tentative `plan.md`.
3. `critique` — `agentwright:critique` adversarially pokes at the plan (assumptions, missing failure modes, scope creep, prior-art collisions). Produces `critique.md`.
4. `verify-critique` — `agentwright:research` consumes the critique and investigates each point against current literature and prior art. Produces `critique-verification.md` scoring each critique VALID / PARTIAL / INVALID with citations.
5. `decision` — terminal checkpoint. User reviews all four artifacts and decides build vs shelve. If build → start `greenfield` (new project) or `feature` (existing codebase). If shelve → `workflow-stop` to mark this run cancelled.

```
/forgewright:workflow-run idea-exploration "Should we build a weekly retro CLI tool?"
```

### `greenfield`

Build a project or major subsystem from scratch when the idea is already validated. Same shape as `feature` but with `project-planning` instead of `feature-planning`. Run `idea-exploration` first if you haven't yet decided whether to build the idea.

1. `plan` — `agentwright:project-planning` skill produces `plan.md`.
2. `plan-quality-review` — `agentwright:plan-quality-review` audits the plan.
3. `plan-review` — checkpoint.
4. `implement` — handoff (build per plan).
5. `verify` — `agentwright:verify-plan`.
6. `audit` — pipeline (default, `--diff`, loopable).
7. `tests` — command (`${TEST_CMD}`).
8. `docs` — `agentwright:update-docs` writes the project's first-pass docs.

### Custom workflows

Define your own under `workflows.<name>` in `.claude/forgewright.json`. See [forgewright.example.json](forgewright.example.json) for the full shape. Every phase requires a `name` field — non-empty, identifier-safe (`[A-Za-z][A-Za-z0-9_-]*`), and unique within the workflow. Names show up in status output, log lines, peer `task_ref` strings, and idempotence prompts; pick something readable (`"plan"`, `"implement"`, `"audit"`).

All five phase types are available. Phase fields:

- **`type`** (required) — `skill` / `pipeline` / `command` / `handoff` / `checkpoint`.
- **`name`** (required) — see above.
- **`idempotent`** (optional, default `false`) — if `false`, resuming after a partial execution prompts the user to re-run / skip / abort instead of silently re-executing.
- **`produces`** — declares an output artifact. Accepts a bare name (`"plan"` — leader picks the extension and passes `--artifact-path` on advance), an explicit filename (`"plan.md"` — auto-registered, no `--artifact-path` needed), or a `{ name: filename }` map for command phases that write multiple files (e.g. `{ "metrics": "metrics.json", "model": "model.bin" }` — each entry registers under its stem).
- **`consumes`** — declares a dependency on upstream artifacts. String form (`"plan"`) on skill / handoff phases; string OR array of strings on command phases. The named stems are validated to be registered AND present on disk at descriptor-build time.

Type-specific fields:

- `skill.skillId` — any skill ID resolvable via the Skill tool. Plugin skills require the `plugin:skill` form (`agentwright:feature-planning`, `agentwright:plan-quality-review`, `agentwright:verify-plan`, `wrightward:collab-context`, …); bare names only resolve to repo-local skills.
- `pipeline.pipelineName` — agentwright pipeline name (`default`, `full`, or any custom pipeline defined in `.claude/agentwright.json`).
- `pipeline.scope` — `--diff`, `--all`, or a path.
- `pipeline.loopable` — `true` to make the pipeline eligible for end-of-workflow re-audit replay.
- `command.command` — shell string. Supports `${TEST_CMD}`, `${ARTIFACTS}`, `${ARTIFACT.<stem>}` substitution.
- `command.instruction` — optional overlay telling the leader how to interpret the command's output (read produced artifacts, structured decision into `--mcp-result.summary`).
- `handoff.directive` — free-form text describing the work. Required unless `consumes` is set.
- `checkpoint.summary` — text shown in the Discord notification and in the terminal at pause.

Custom workflow names take precedence over built-in ones — redefining `feature` overrides the built-in entirely.

## Configuration

`.claude/forgewright.json` (all fields optional). Run `/forgewright:config-init` to drop a fully-defaulted file into your repo — see [forgewright.default.json](forgewright.default.json) for what gets written, and [forgewright.example.json](forgewright.example.json) for a copyable example of custom workflows.

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
| `workflows.<name>.tests` | — | Per-workflow override of `tests.command` (and any future `tests.*` keys). Same shallow-merge + freeze semantics. Useful when a workflow needs a different test command than the project default (e.g. a smoke suite). |
| `reaudit.maxCycles` | 1 | Cap on end-of-workflow re-audit replays. |
| `reaudit.minDeltaPercent` | 5 | Replay if `(added+deleted lines) / total LOC ≥ this`. Set to 0 to disable the percent threshold. |
| `reaudit.minDeltaLines` | 0 | Replay if absolute changed lines ≥ this. Set to 0 to disable the line-count threshold. Either active threshold triggers replay; setting BOTH to 0 turns deterministic replay off — use `decisionMode: "leader"` for non-threshold replay rules. |
| `reaudit.decisionMode` | `"deterministic"` | `"deterministic"` (threshold-based) or `"leader"` (leader runs `reaudit-decision`). |
| `reaudit.loopableStages` | `["correctness", "behavior", "security"]` | Stages eligible for replay. |
| `agentwright.path` | resolved by `config-init` | Absolute path to agentwright's CLI. Auto-refreshed at every workflow start; falls back to a plugin-cache walk if unset. |
| `tests.command` | null | Explicit `${TEST_CMD}` value. null = leader infers from the project. |
| `retention.keepCompletedWorkflows` | 2 | Newest N completed workflows always kept regardless of age. |
| `retention.maxWorkflowAgeDays` | 7 | Prune older completed workflows. |

## State

Each workflow lives under `.claude/forgewright/workflows/<workflowId>/`:

- `workflow.json` — phase status, current phase index, args, frozen `reaudit` and `tests` configs, artifact registry, timestamps. Drives `workflow-status` and `workflow-resume`.
- `artifacts/` — files produced by phases (`plan.md`, `diagnosis.md`, `metrics.json`, etc.). Each registered by stem so downstream phases can `consume` them.
- `peer-handoffs.jsonl` — one line per dispatched task: phase index/name, `task_ref`, peer handle or `"self"`, ack id, status, detail.

Pruned per the retention policy at every workflow start. Resumable across sessions.

## License

Apache-2.0
