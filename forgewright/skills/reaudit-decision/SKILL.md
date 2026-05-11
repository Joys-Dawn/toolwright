---
name: reaudit-decision
description: Decide whether to re-audit a workflow after end-of-pipeline diff stats. Used by forgewright workflow-lifecycle when reaudit.decisionMode = "leader".
---

# reaudit-decision

You are the leader agent's judgment surface for end-of-workflow re-audit decisions. The forgewright coordinator hands you snapshot-vs-current diff stats from the last pipeline phase. You decide whether the change pattern warrants another audit cycle, a partial replay, or escalation to the user.

## Inputs

The coordinator passes these stats (already in your prompt via the descriptor):

- `totalAdded` / `totalDeleted` / `totalDiffLines` — line-level numstat
- `totalLoc` — total LOC across changed files
- `ratio` — totalDiffLines / totalLoc (0..1)
- `changedFiles` — list of file paths
- `loopableStages` — stages allowed to replay (correctness, behavior, security, etc.)
- `reauditCycles` / `maxCycles` — current cycle count + cap

You also have the workflow's plan artifact at `artifacts/plan.md`. The most recent run's findings live under `.claude/audit-runs/<runId>/stages/<name>/` — use the `runId` you captured in step 1 of the most recent pipeline phase (forgewright does not record it on the workflow). Read whatever you need.

## Output

Output **JSON only**, no prose, with one of these shapes:

```json
{ "decision": "clean" }
```

— No replay needed. Workflow ends.

```json
{ "decision": "replay", "stages": ["correctness", "behavior"], "reason": "..." }
```

— Re-audit only the named stages (must be in `loopableStages`) with `--diff` scope.

```json
{ "decision": "replay-full", "reason": "..." }
```

— Re-run the full default pipeline. Use when the diff is broad or crosses domains.

```json
{ "decision": "escalate", "reason": "..." }
```

— Surface to the user, halt the workflow. Use when:
  - The diff suggests the implementation drifted from the plan (verify-plan would have caught this; if it didn't and you still see drift, escalate).
  - Cycles are spinning without convergence.
  - Findings from prior cycles named issues that re-appear in the diff.

## Decision rubric

| Diff pattern | Likely decision |
|---|---|
| Few lines (<5%), trivial cosmetic edits, no behavior shift | clean |
| Small diff in one domain (e.g. only correctness-relevant) | replay one stage |
| Medium diff touching multiple files in different domains | replay-full |
| Large diff, suggests scope creep beyond plan | escalate |
| Same files churning across cycles, findings not landing | escalate |

`reauditCycles >= maxCycles - 1` should bias toward escalate or clean — don't kick a cycle that won't run.

## Why JSON-only output

You hand the JSON to `workflow-advance --result completed --mcp-result '<json>'`. The coordinator's `handleReauditDecision` (in `coordinator/workflow-lifecycle.js`) reads `decision.decision` and routes:

- `clean` → workflow marked completed.
- `replay` (with optional `stages`) / `replay-full` → coordinator appends a fresh pipeline phase scoped to those stages with `--diff`, returns the new descriptor for you to drive.
- `escalate` → workflow paused with `escalationReason`; you surface the reason to the user.

Prose around the JSON breaks `JSON.parse`; the workflow surfaces an `error` descriptor.
