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

## After the subagent returns

You are the verifier/fixer for the live repo. The subagent ran read-only against extracted artifacts; never blindly accept its claims. For every entry in every `unreported_*` bucket and every `fabricated_claims` item, walk these steps **in order**:

**Step A — Verify the claim**. Read the cited file/diff yourself. Re-search the report (`report.md` in the temp dir) for any acknowledgment the subagent might have missed. Re-search the tool trace (`tool-trace.txt`) for the operation the subagent says is missing. Confirm:
- The skip / addition / out-of-scope touch / missing test / fabricated claim is actually true against the live repo and the transcript.
- The report really is silent on it (not just phrased differently).
- The `--against` base is correct so the diff isn't lying.

**Step B — Try to contradict it**. Did the subagent misread? Was the work done in a different file or under a different name? Is there a Bash invocation that satisfies the claim the subagent dismissed? Is the "out of scope" entry actually about a different file? If you find a contradiction, classify the finding as `invalid` and skip steps C/D.

**Step C — Fix obvious issues immediately** when the right action is unambiguous. Examples:
- `unreported_missing_tests` where the plan named the exact behavior to cover and the test target is a single function/route → write the test.
- `unreported_skips` where the plan spelled out a mechanical step and the implementer just forgot it → implement the step.
- `unreported_out_of_scope` where the plan explicitly listed the touched file/area as off-limits → revert that change.
- `fabricated_claims` where the underlying work clearly didn't happen (e.g., "ran tests" but no test command in the trace) → actually do it.

**Step D — Defer judgment calls**. Only when multiple valid responses exist and no option is obviously correct: an undisclosed addition that might be a reasonable side-effect *or* unwanted scope creep; a fabricated claim where the work plausibly happened in a way the trace didn't capture; a missing test where the right layer or approach is genuinely ambiguous.

## Final report

Post the subagent's full report (verdict + every bucket) verbatim, then a per-finding table:

| # | Bucket | Finding | Verification | Decision | Action |
|---|--------|---------|--------------|----------|--------|

Where Decision is `invalid` / `fixed` / `needs your call` and Action is one short phrase (e.g. "wrote auth.test.ts:42-58", "reverted change to config.ts", "no — auditor misread Edit on line 12"). After the table, list every `needs your call` item with full context so the user can decide.
