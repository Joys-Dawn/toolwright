---
name: refactor-planning
description: Plans a refactor before any code is changed — identifies what to restructure, maps the blast radius, defines a safe transformation sequence, and specifies how to verify behavior is preserved. Use when the user wants to reorganize code, extract modules, reduce coupling, consolidate duplication, or migrate patterns.
---

# Refactor Planning

Enter plan mode and produce a safe, sequenced refactor plan. Do not write any code until the plan is approved.

## Trigger

When this skill is invoked, **immediately enter plan mode** using the EnterPlanMode tool. All planning work happens inside plan mode.

## Scope

- **User names a specific refactor**: "Extract the auth logic into its own module", "Split this God class", "Move from callbacks to async/await." Explore the code to understand the current state before planning the transformation.
- **User names a problem, not a solution**: "This file is doing too much", "There's a lot of duplication in these handlers." Diagnose first — identify the specific structural issue and propose a concrete refactor target before planning steps.
- **Request is vague**: Ask clarifying questions using AskUserQuestion. Common ambiguities:
  - What's the motivation? (readability, testability, performance, upcoming feature needs)
  - What's the desired end state?
  - Are there constraints? (can't change public APIs, must stay backwards-compatible, can't touch file X)
  - Is behavior change acceptable or is this strictly structural?

Do NOT skip clarification. A refactor planned against wrong constraints creates more problems than it solves.

## Process

### 1. Understand the Current State

Read all code involved in the refactor. Map:

- **What the code does** — the actual behavior, not just the structure
- **Who depends on it** — grep for imports, function calls, type references. List every consumer.
- **What tests exist** — identify tests that exercise the code being refactored. These are your safety net.
- **What tests are missing** — if critical behavior has no tests, the refactor plan must include writing them FIRST (before the refactor), using the appropriate `write-tests-*` skill

### 2. Define the Target State

Describe concretely what the code should look like after the refactor:

- New file/module boundaries
- New function/class responsibilities
- What moves where
- What gets renamed
- What gets deleted

Be specific — "better organized" is not a target state. "Auth validation moves to `lib/auth/validate.ts`, session management stays in `lib/auth/session.ts`, the current `auth.ts` becomes a re-export barrel" is.

### 3. Map the Blast Radius

For every change in the target state:

- **Direct consumers**: files that import/call the thing being changed
- **Indirect consumers**: files that depend on the direct consumers' behavior
- **Configuration**: build configs, test configs, CI, dependency injection setup
- **External contracts**: public APIs, database schemas, event formats — anything that crosses a system boundary

Classify each as:
- **Must update** — will break if not changed alongside the refactor
- **Should verify** — might be affected, needs checking
- **Safe** — unaffected

### 4. Sequence the Transformations

Order changes so the code **stays working after every step**. Each step should be independently committable and testable.

Prefer this ordering:
1. **Add tests** for any untested behavior that the refactor touches (safety net first)
2. **Introduce the new structure** alongside the old (new files, new functions — don't delete anything yet)
3. **Migrate consumers** to the new structure one at a time
4. **Remove the old structure** once all consumers are migrated
5. **Clean up** — remove re-exports, temporary bridges, dead code

If a step can't be done without temporarily breaking something, note exactly what breaks and for how long.

### 5. Define Verification

For each step, specify how to confirm behavior is preserved:

- Which test suites to run
- Manual checks if automated tests don't cover it
- Build/lint commands
- For API changes: how to verify consumers still work

## Output

Write the plan to the plan file with this structure:

```
# Refactor: [one-line description]

## Motivation
Why this refactor is needed. What problem it solves.

## Current State
How the code is structured now. Key files, responsibilities, dependencies.

## Target State
How the code should be structured after. New boundaries, responsibilities, file layout.

## Blast Radius
| File/Module | Impact | Action |
|---|---|---|
| ... | Must update / Should verify / Safe | ... |

## Steps

### Step 1: [description]
- **Changes**: [what to do]
- **Verify**: [how to confirm it works]

### Step 2: [description]
...

## Risks
- [What could go wrong and how to mitigate it]
```
