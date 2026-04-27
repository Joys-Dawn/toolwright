---
name: behavior-audit
description: Audits whether a feature's actual behavior makes sense from the user's perspective — not against patterns or specs, but reasoned from first principles. Catches bugs where code is internally consistent and matches its intended design but produces surprising, illogical, or hostile user experiences. Use after correctness-audit when reviewing a feature change, or when something works but feels wrong.
---

# Behavior Audit

Audit a feature's **realized behavior** from the user's perspective. Trace what the code actually does scenario-by-scenario, then judge — independently — whether each outcome makes sense for a real user.

This skill catches bugs that no pattern-based audit can: behavior that is internally consistent, free of correctness defects, and faithful to its intended design, yet still produces a surprising, illogical, or hostile experience.

**Canonical example**: a streak counter that resets on login because no activity has been recorded yet today — even though the day isn't over and the user could still earn activity. Code is bug-free. The rule "reset streak when no activity for a day" is reasonable in principle. The realized behavior is hostile because the rule fires at the wrong moment relative to the user's reality.

## Core Lens

**Reason about the user, not the code.** Every scenario must be evaluated against the question: *if I were a user and this happened to me, would it feel right, or would I be confused, annoyed, or surprised?*

## Scope

Determine what to audit based on context:

- **Diff mode** (default when changes exist and no scope specified): run `git diff` and `git diff --cached` to identify the feature being audited. Audit the user-visible behavior introduced or changed by the diff.
- **File/directory mode**: audit the user-visible behavior of code in the specified files.
- **Feature mode**: when the user names a feature ("audit the streak feature"), audit that feature's full behavior, not just recent changes.

Read all in-scope code before producing findings. Read enough surrounding context (callers, callees, data model, related features) to understand the full user-visible flow — not just the changed lines.

## Process

### 1. Identify the feature and its user-facing surface

From the diff (or scope), determine:

- What feature is this? Describe it in one sentence in user terms.
- Who is the user? (end-user, admin, API consumer, internal operator)
- What does the user *do* with this feature, and what do they *get* from it?

### 2. Enumerate scenarios

Walk the checklist below. For each axis, pick the scenarios most likely to expose surprises given this specific feature. Generate as many scenarios as the feature warrants — small features need few, complex features need many.

See [REFERENCE.md](REFERENCE.md) for full scenario catalogs and worked examples.

#### 2a. Temporal — when does this happen?

How does the feature behave at different points in time?

- Start of day / mid-day / end of day
- Near midnight, near a deadline, near a billing period boundary
- Across timezone boundaries (user's tz vs server tz vs UTC)
- Immediately after another action vs after long inactivity
- Before, during, and after a scheduled job runs (cron, daily reset, weekly digest)
- During a maintenance window or while a related feature is rate-limited

#### 2b. State — what state is the user in?

How does the feature behave for users in different states?

- Brand-new user with no history
- Returning user mid-flow
- Power user with large data volumes (1000s of items)
- User in an unusual state: empty, near a limit, just-past a limit, suspended, unverified
- User on a free tier vs paid tier (if relevant)
- User who hit an error in this feature previously

#### 2c. Sequence — what order did things happen in?

How does the feature behave under different action orderings?

- A then B vs B then A
- A repeated quickly (double-click, retry storm)
- A interrupted partway through
- A and B happening concurrently (two tabs, two devices)
- A undone, then redone
- A from one session, B from another

#### 2d. Failure injection — what if step N fails?

How does the feature behave when a step in the flow fails?

- Network error mid-flow — does the user end up in a half-committed state?
- Backend write succeeds, frontend update fails — what does the user see?
- One of N parallel operations fails — partial success visible to the user?
- Permission denied mid-flow — does the partial work persist or roll back?
- Validation error after side effects already triggered — are side effects reverted?

#### 2e. Cross-feature interaction — what else does this touch?

How does the feature interact with other features that read or mutate the same state?

- List every other feature whose state this diff reads or writes (Grep on shared table names, store keys, cache keys, event names from the diff).
- For each, ask: what happens to that other feature when this one runs? Does this feature's behavior assume an invariant the other feature can break, or break an invariant the other feature relies on?

### 3. For each scenario, write the user-perspective expectation BEFORE reading the code

For each chosen scenario, write down — in plain user-perspective language — what a reasonable user would expect to happen. **Do this before tracing the code.** This prevents anchoring your expectation to whatever the implementation does.

The expectation should be phrased in user terms, not code terms:
- ✅ "the user sees their streak preserved because the day isn't over"
- ❌ "we shouldn't call `resetStreak()` in the login handler"

### 4. Trace the code and write what actually happens

For the same scenario, trace through the code (the diff plus any code paths it invokes) and write what actually happens, again in user terms:
- "the user logs in, the login handler queries today's activity, finds none, sets streak = 0, the dashboard renders 'Streak: 0'"

Cite file paths and line numbers for the key steps in the trace.

### 5. Compare and classify

Compare the expectation (step 3) against the actual behavior (step 4). Rate each finding by how badly the realized behavior fails the user:

- **Critical** — behavior a clear majority of users would call a bug or hostile design (destructive action with no confirmation, partial state visible to the user, feature contradicts its stated purpose).
- **Warning** — defensible behavior that nonetheless creates real friction, surprise, or frustration in realistic scenarios. *The streak example lives here.*
- **Suggestion** — minor rough edges, inconsistencies, or empty-state polish that would improve the experience but are not urgently broken.

Scenarios where actual behavior matches the user expectation are not reported. Silence means the scenario passed.

## Verification Pass

Before finalizing your report, for every flagged scenario:

1. **Re-read the code path.** Confirm the trace in step 4 is accurate — not a misread, not handled elsewhere, not guarded by middleware or a wrapper higher up.
2. **Steel-man the implementation.** Try to construct the strongest reason a thoughtful designer would have built it this way. If you find a compelling reason and the user perspective in step 3 was incomplete, drop the finding or downgrade its confidence.
3. **Re-check the user perspective.** Is your "reasonable user expectation" actually reasonable, or is it a niche preference? If only a small minority of users would notice or care, downgrade severity to **Suggestion** or drop the finding entirely.

## Output Format

Group findings by severity. Use plain user-perspective language. Cite the code path for every finding.

```
## Critical
Behavior a clear majority of users would call a bug or hostile design.

### [scenario name in user terms]
- **Expected (user perspective)**: what a reasonable user would expect
- **Actual (from code trace)**: what the code makes happen
- **Why this is wrong**: the specific way it violates user expectation or creates a bad experience
- **Path**: file:line — file:line

## Warning
Defensible behavior that nonetheless creates real friction, surprise, or frustration.

(same structure)

## Suggestion
Minor rough edges or polish opportunities that aren't urgently broken.

(same structure)

## Summary

- Scenarios audited: N (across [list of axes covered])
- Findings: X critical, Y warning, Z suggestion
- Overall: 1-2 sentence verdict on whether the realized behavior serves the user well
```

If no findings in a severity, omit it entirely. If no findings overall: `**Behavior audit: PASS** — N scenarios traced, all behavior matched a reasonable user expectation.`

## Rules

- **First principles, not pattern matching.** Every finding comes from reasoning about a specific user in a specific scenario, not from a fixed bug-pattern catalog. The catalogs and example anti-patterns in [REFERENCE.md](REFERENCE.md) are illustrative starting points — far from exhaustive.
- **User-perspective language.** Findings must read like things a real user would say or feel, not code descriptions. "I logged in and lost my streak even though I haven't done anything yet today" — not "resetStreak() is called unconditionally in the login handler."
- **Cite paths.** Every finding must reference the specific file(s) and line(s) where the behavior is implemented (or where the missing behavior should be added).
- **Scope to the feature.** Pick the scenarios most likely to expose surprises for *this specific feature*. Generate as many as the feature warrants — small features need few, complex features need many. Don't pad with low-value scenarios just to fill a quota.
- **Expectation before trace.** Always write the user-perspective expectation before reading the code for that scenario. This is the discipline that makes the audit work.
- **Confidence over volume.** A finding is only worth reporting if you can articulate the specific way it would feel wrong to a real user. If you can't, drop it.
- **Don't audit code that has no user-visible effect.** Pure refactors, internal renames, and infrastructure changes are out of scope unless they change observable behavior.
