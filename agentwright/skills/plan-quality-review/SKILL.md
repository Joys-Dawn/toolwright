---
name: plan-quality-review
description: Review an implementation plan document for completeness and design soundness before code is written. Dispatches the plan-quality-reviewer agent to catch missing impact analysis, weak test plans, unverifiable file references, vague scope, and bad design choices.
argument-hint: <path to plan file>
---

Dispatch the plan-quality-reviewer agent to independently review the plan document.

Launch the Agent tool with `subagent_type` set to exactly `agentwright:plan-quality-reviewer`. In the `prompt`, include:

1. **Path to the plan file** — if the user passed `$ARGUMENTS`, forward it verbatim. If `$ARGUMENTS` is empty and you didn't just make a plan in plan mode, ask the user which plan to review before dispatching. If you just made a plan in plan mode use that path.

2. **Project working directory** — the absolute path of the repo so the agent can ground every claim in the actual codebase (`Glob`, `Grep`, `Read` against the live tree).
3. **Session ID** — include `${CLAUDE_SESSION_ID}` so the agent can optionally read this conversation's context if it needs to disambiguate which plan was meant.

The agent does NOT have access to this conversation. Provide all necessary context in the prompt.

## After the agent returns

You are the verifier/fixer for the live plan document. The agent ran read-only; never blindly accept its claims. For every Critical and Warning finding, walk these steps **in order**:

**Step A — Verify the claim**. Re-read the plan section the agent cited and the cited codebase file/symbol/version. Confirm:
- The plan really says (or really fails to say) what the agent claims.
- The codebase claim is true — the file/line/API/symbol the agent says is wrong is actually wrong at the project's pinned version. For dimension 4 (file-list verifiability) and dimension 11 (constraint awareness), this means running the actual `Glob` / `Grep` / `Read` / docs lookup yourself.
- The agent didn't miss a section that already addresses the gap (e.g., a "Risks" section that covers the missing-risk finding, an "Out of Scope" entry that explains the omission).

**Step B — Try to contradict it**. Look actively for reasons the finding is wrong:
- Did the agent flag a "reinvented wheel" without checking whether the named alternative actually fits the project's runtime/license/version?
- Did it flag "naive design" against a project convention (CLAUDE.md, README) that justifies the choice?
- Did it cite a missing file path that does exist under a slightly different name?
If you find a contradiction, classify the finding as `invalid` and skip steps C/D.

**Step C — Fix obvious issues immediately by editing the plan document** when the correct change is unambiguous. Examples:
- File-list verifiability (D4) findings where the cited path is wrong: correct the path to the verified one.
- Reinventing the wheel (D8) findings where the agent named a specific battle-tested alternative that fits the project: replace the proposed custom code with the named alternative in the plan, including a one-line justification.
- Constraint awareness (D11) findings where a load-bearing claim is verifiably false: rewrite the affected section to respect the actual constraint.
- Missing test plan / risk section / out-of-scope section where the project clearly wants one and the structure is templated by sibling planning skills: add it using the project's evident conventions.
- Vague implementation step that should be split into concrete sub-steps the implementer can checkpoint: rewrite it.

**Step D — Defer judgment calls**. Only when the finding flags a real trade-off and no option is obviously better: i.e. design dimensions (D7 unnecessary indirection, D9 naive design, D10 disproportionate complexity) where the agent's alternative is plausible but the original may also be valid.

## Final report

Post the agent's full report (every Critical / Warning / Suggestion finding) verbatim, then a per-finding table:

| # | Severity | Dimension | Finding | Verification | Decision | Action |
|---|----------|-----------|---------|--------------|----------|--------|

Where Decision is `invalid` / `fixed` / `needs your call` and Action is one short phrase (e.g. "corrected path to src/auth/middleware.ts", "swapped custom retry for p-retry", "no — finding misread plan section 3"). After the table, list every `needs your call` item with full context so the user can decide.
