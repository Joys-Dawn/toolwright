---
name: bug-fix-planning
description: Plans a bug fix before any code is written — maps root cause, change impact, minimal fix, and regression tests. Use when the user wants to plan a bug fix, asks "how should we fix this", or has a confirmed bug that needs a careful fix rather than a quick patch.
---

# Bug Fix Planning

Enter plan mode and produce a targeted, minimal fix plan. Do not write any code until the plan is approved.

## When to Use This vs. Systematic Debugging

- **systematic-debugging**: You don't know what's wrong yet. Use it to reproduce, isolate, and find the root cause.
- **bug-fix-planning** (this skill): You know (or strongly suspect) the root cause and need to plan the fix carefully — because the area is risky, the blast radius is unclear, or you want to prevent regressions.

If the root cause is unknown, start with systematic-debugging first. Come here once you have a confirmed or strongly suspected cause.

## Trigger

When this skill is invoked, **immediately enter plan mode** using the EnterPlanMode tool. All planning work happens inside plan mode.

## Scope

- **User describes a bug with known cause**: Validate the diagnosis against the codebase before planning the fix. The stated cause may be a symptom, not the root.
- **User describes symptoms only**: Spend time in the codebase confirming the root cause before planning. If you cannot confirm it, say so and recommend systematic-debugging instead.
- **Bug is in unfamiliar code**: Read the surrounding module, its tests, and its callers before proposing any change. Understand the design intent.

## Process

### 1. Confirm the Bug

- **What is the expected behavior?** What should happen?
- **What is the actual behavior?** What happens instead? (Error message, wrong output, crash, silent failure, data corruption)
- **Reproduction path**: Steps, environment, inputs, frequency (always vs. intermittent).
- If any of these are unclear, ask before continuing.
- Output: A one-paragraph bug statement covering expected vs. actual behavior and reproduction.

### 2. Identify Root Cause

Explore the codebase to confirm or find the root cause. Use Glob, Grep, and Read.

- Trace the code path from the trigger (user action, API call, cron job) to the failure point.
- Distinguish **root cause** from **symptoms**. The root cause is the earliest point where behavior diverges from intent. Symptoms are downstream effects.
- Check git blame/log on the affected area — was this a recent regression? Knowing when it broke narrows the cause.
- Output: The root cause with file path, line number, and a one-sentence explanation of why the current code is wrong.

### 3. Map Change Impact

Before designing the fix, map what the fix will touch and what might break. This is a focused version of the feature-planning change impact analysis — scoped to the fix, not a new feature.

- **Files to modify**: List every file the fix will change.
- **Callers / consumers**: For each modified function or interface, trace who calls it. Will they need changes too?
- **Implicit contracts**: Does the current (buggy) behavior have callers that accidentally depend on it? Fixing the bug could break code that adapted to the broken behavior.
- **Test coverage**: Do tests exist for the affected code path? Are they testing the buggy behavior (and will fail when you fix it)?
- **Related bugs**: Could the same root cause manifest elsewhere? Grep for similar patterns.

Output: A change impact summary. If the blast radius is larger than expected, flag it as a risk.

### 4. Design the Fix

Produce a minimal, targeted fix. The fix should change as little as possible while fully resolving the root cause.

- **Fix approach**: What changes, and why. Reference specific files and functions.
- **Why this approach over alternatives**: If there are multiple ways to fix it, briefly state why you chose this one. Common tradeoffs:
  - Fix at the source vs. add a guard at the call site
  - Strict fix (may break callers depending on buggy behavior) vs. lenient fix (preserves compatibility)
  - Minimal patch vs. small refactor that prevents the class of bug
- **What NOT to change**: Explicitly state anything in the affected area that you are intentionally leaving alone. This prevents scope creep during implementation.

### 5. Plan Tests

Every bug fix needs tests — both to verify the fix works and to cover any gaps the bug exposed.

- **Regression test**: A test that reproduces the original bug — it should fail before the fix and pass after. State inputs, expected output, and which test file it belongs in.
- **New tests for affected code**: If the change impact analysis revealed untested code paths that the fix touches, write tests for them. A bug in untested code means the surrounding code is likely untested too.
- **Existing test updates**: If current tests assert the buggy behavior (and will break when you fix it), note which ones need updating and what the correct assertions should be.

Delegate test writing to the appropriate skill based on what's being tested:
- **write-tests-frontend**: React components, hooks, RTL / Vitest
- **write-tests-deno**: Deno / Supabase Edge Functions
- **write-tests-pgtap**: Database migrations, RLS policies, SQL logic
- **write-tests**: Everything else (general-purpose, any language/framework)

### 6. Identify Risks

Flag anything that could go wrong with the fix:

- Callers that depend on the buggy behavior (breaking change risk)
- Data that was written by the buggy code path and may need correction
- Timing/deployment concerns (does this need to be coordinated with a migration, a feature flag, or a rollback plan?)
- Uncertainty in the root cause (if you're not 100% sure, say so)

## Output Format

Write the plan to the plan file with this structure:

```
# Bug Fix: [Short description]

## Bug Statement
**Expected**: [What should happen]
**Actual**: [What happens instead]
**Reproduction**: [Steps / environment / frequency]

## Root Cause
[File path, line number, one-sentence explanation of why the code is wrong]

## Change Impact
- **Files to modify**: [list]
- **Callers affected**: [list with notes on whether they need changes]
- **Implicit dependencies on buggy behavior**: [any code adapted to the broken behavior]
- **Test coverage**: [existing tests for this code path, if any]
- **Related patterns**: [same root cause elsewhere?]

## Fix
**Approach**: [What changes and why]
**Alternatives considered**: [Why not X]
**Out of scope**: [What is intentionally not changed]

## Implementation Steps
1. [Step — each should be a single commit]
2. ...

## Tests
- **Regression test**: [Reproduces the bug: inputs, expected output, test file]
- **New tests**: [Tests for affected code paths that lacked coverage]
- **Updated tests**: [Existing tests that assert buggy behavior and need correction]
- **Test skill**: [Which test skill to delegate to: write-tests-frontend / write-tests-deno / write-tests-pgtap / write-tests]

## Risks
- [Risk with mitigation]
```

## Rules

- **Plan mode first**: Always enter plan mode before doing any planning work.
- **No code**: Do not write implementation code during planning. The plan is the deliverable.
- **Minimal fix**: Fix the root cause with the smallest change that fully resolves the bug. Do not refactor surrounding code, add features, or "improve" unrelated things.
- **Read before planning**: Explore the affected code, its callers, and its tests before proposing any change.
- **Root cause, not symptoms**: Confirm the root cause before designing the fix. A fix aimed at symptoms will need to be re-fixed.
- **Every fix gets tests**: At minimum a regression test. If the fix touches untested code, add coverage for that too. Delegate to the appropriate test skill (write-tests-frontend, write-tests-deno, write-tests-pgtap, or write-tests).
- **Name what you're leaving alone**: Explicitly scope the fix. Prevent "while I'm in here" scope creep.
- **Honest about uncertainty**: If the root cause is not fully confirmed, say so. A "probably X" plan should note the uncertainty and include a verification step.
