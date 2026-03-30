# Bug Fix Planning — Reference

Common root cause patterns, fix quality criteria, and anti-patterns for the skill defined in `SKILL.md`.

---

## 1. Common Root Cause Patterns

These are the most frequent categories of bugs. When analyzing root cause, check whether the bug fits one of these patterns — it accelerates diagnosis and helps identify related occurrences.

| Pattern | Description | How to Spot | Fix Direction |
|---------|-------------|-------------|---------------|
| **Off-by-one** | Boundary condition wrong (< vs <=, 0-indexed vs 1-indexed, inclusive vs exclusive) | Fails only at boundaries; works for middle-of-range inputs | Fix the comparison; add boundary test cases |
| **Null/undefined access** | Accessing a property on a value that can be null/undefined at runtime | TypeError in logs; optional chain missing; DB column nullable but type says non-null | Guard at the source (make non-nullable) or handle at the access site; update types |
| **Race condition** | Two operations interleave in an unexpected order | Intermittent failure; works in isolation but fails under load or concurrent use | Serialize the critical section, use transactions, or make the operation idempotent |
| **Stale state** | UI or cache shows old data after a mutation | Works on refresh; shows wrong value briefly; optimistic update not rolled back | Invalidate/refetch after mutation; check cache TTL; verify optimistic update rollback |
| **Type coercion** | Implicit type conversion produces wrong value (string "0" is truthy, `==` vs `===`, JSON.parse on a non-JSON string) | Wrong branch taken; NaN propagation; unexpected truthiness | Explicit type checks; use strict equality; validate at parse boundaries |
| **Missing await** | Promise returned but not awaited; downstream code runs before async operation completes | Intermittent success; works in slow environments; `undefined` where a value was expected | Add `await`; check for fire-and-forget patterns in the call chain |
| **Wrong scope / closure capture** | Variable captured by reference in a loop or callback; gets the final value instead of the per-iteration value | Bug only manifests with multiple items; works with a single item | Use `let` instead of `var`; capture value in parameter; use `.map()` instead of loop with side effects |
| **Serialization boundary** | Data changes shape crossing JSON.stringify, API response, localStorage, or postMessage (Date→string, undefined dropped, BigInt throws) | Works in memory, breaks after round-trip; missing fields; wrong types | Validate/transform at the boundary; use a schema (Zod, pydantic) at parse points |
| **Environment mismatch** | Works in dev but fails in prod/CI due to env var, dependency version, OS, or config difference | "Works on my machine"; CI-only failures; staging vs prod discrepancy | Pin versions; validate env at startup; reproduce in matching environment |
| **Incorrect merge / regression** | Bug introduced by a merge that resolved a conflict incorrectly or overrode a recent fix | `git bisect` points to a merge commit; the fix existed in a prior commit but is absent now | Restore the correct code; add a regression test to prevent re-introduction |

---

## 2. Fix Quality Criteria

Self-check before exiting plan mode:

### Root Cause
- [ ] Root cause is stated with a specific file, line, and explanation — not "something in the auth flow."
- [ ] Root cause explains **why** the code is wrong, not just **what** it does wrong.
- [ ] If the root cause is uncertain, uncertainty is explicitly stated with a verification step in the plan.

### Fix Design
- [ ] Fix targets the root cause, not a symptom.
- [ ] Fix is the minimal change that fully resolves the bug — no unrelated changes bundled in.
- [ ] If callers depend on the buggy behavior, the plan addresses how to handle them (fix callers, deprecation, feature flag).
- [ ] "Out of scope" section exists and names tempting-but-unrelated improvements.

### Tests
- [ ] A regression test is described that reproduces the original bug (fails before fix, passes after).
- [ ] Untested code paths exposed by the change impact analysis have new tests planned.
- [ ] Existing tests that assert buggy behavior are identified and marked for update.
- [ ] The correct test skill is identified (test-frontend, test-deno, test-pgtap, or test-writing).

### Change Impact
- [ ] Every file to be modified is listed and verified to exist (Glob).
- [ ] Callers of modified functions were traced (Grep), not guessed.
- [ ] If the same root cause pattern exists elsewhere, those locations are flagged.

---

## 3. Common Fix Anti-Patterns

### Symptom Fix
Fixing the immediate error without understanding why it happens. Example: adding a null check at a crash site instead of figuring out why the value is null upstream.

**Signal**: The fix is a guard/check at the point of failure, but the question "why is this value wrong here?" is unanswered.

**Remedy**: Trace the bad value upstream to where it was set incorrectly. Fix there. The crash-site guard may still be warranted as defense-in-depth, but it is not the fix.

### Shotgun Fix
Changing multiple things at once because "one of these should fix it." When it works, you don't know which change was the actual fix. When it doesn't, you've muddied the debugging.

**Signal**: The plan modifies code in several unrelated areas "to be safe."

**Remedy**: One root cause → one fix. If multiple issues are found, plan them as separate fixes.

### Fix + Refactor Bundle
Fixing the bug and also refactoring surrounding code, adding features, or "improving" things while you're in the area. This makes the fix harder to review, harder to revert, and harder to verify.

**Signal**: Implementation steps include work unrelated to the bug.

**Remedy**: The bug fix is one PR. Refactoring is a follow-up PR. Keep them separate.

### No Tests
Fixing the bug without adding a test that reproduces it, or without testing the code paths the fix touches. The same bug (or a close variant) will return in a future change, and untested surrounding code hides the next bug.

**Signal**: Implementation steps end with the code change and don't include test steps.

**Remedy**: At minimum, a regression test that reproduces the original bug. Beyond that, test any affected code paths that lacked coverage. Delegate to the appropriate test skill (test-frontend, test-deno, test-pgtap, or test-writing).

### Compatibility Blindness
Fixing the bug without considering that callers may have adapted to the broken behavior. The fix is correct but breaks downstream code.

**Signal**: The change impact analysis has no "callers affected" entries for a function that is imported by multiple files.

**Remedy**: Grep for all call sites. Read how they use the return value. If any depend on the buggy behavior, plan how to migrate them.

### Cargo Cult Fix
Copying a fix from Stack Overflow / AI without understanding why it works. This introduces code the team cannot maintain and may mask the actual root cause.

**Signal**: The fix introduces patterns or APIs not used elsewhere in the codebase, with no explanation of why.

**Remedy**: Understand the fix before applying it. If it uses a new pattern, the plan should explain why it's necessary here.
