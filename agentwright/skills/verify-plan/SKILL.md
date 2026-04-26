---
name: verify-plan
description: Verify that an approved plan was implemented faithfully — surfaces silent skips, undeclared additions, scope violations, missing tests, and fabricated claims by cross-checking the plan, the implementer's transcript, and the actual diff. Use after a plan-driven implementation finishes.
argument-hint: [--plan-path <path>] [--against <git-ref>]
---

!`node ${CLAUDE_PLUGIN_ROOT}/scripts/extract-plan-context.js ${CLAUDE_SESSION_ID} $ARGUMENTS`

Dispatch the plan-verifier agent to independently check that the plan from this session was implemented faithfully.

The preprocessing block above ran `extract-plan-context.js`. Its stdout is a single line: the absolute path to a temp directory containing three artifacts (`plan.md`, `report.md`, `tool-trace.txt`) extracted from the session transcript. **Do not read those files yourself** — pass the temp dir path to the subagent and let it read them. If the script printed warnings to stderr (e.g., "degraded extraction"), surface them to the user so they understand the report's confidence level.

If the preprocessing block exited non-zero, the script printed an error to stderr explaining why (no plan attachment, plan file missing, session JSONL not found, etc.). Surface that error to the user verbatim and stop — do not invoke the subagent.

Otherwise, launch the Agent tool with `subagent_type` set to exactly `agentwright:plan-verifier`. In the `prompt`, include:

1. **The temp dir path** — the single line from the preprocessing block's stdout. Tell the subagent the artifacts inside are `plan.md`, `report.md`, and `tool-trace.txt`.
2. **The diff scope** — if the user passed `--against <ref>` in `$ARGUMENTS`, forward that ref to the subagent so it diffs against the right base. Otherwise tell it to use uncommitted changes (default).

The subagent does NOT have access to this conversation. Provide all necessary context in the prompt.

After the subagent returns, report its findings to the user **verbatim** — do not soften, summarize, or filter the output. The whole point of this skill is independent verification; collapsing the structured report into a paraphrase defeats it.

If the subagent flags `unreported_*` items or `fabricated_claims`, do not silently fix them. Surface them clearly so the user can decide whether each is a real omission or a false positive.
