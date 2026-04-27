# Behavior Audit — Reference

Detailed scenario catalogs, bucket classification examples, and worked anti-patterns for the skill defined in `SKILL.md`.

---

## 1. The User-Perspective Discipline

Every finding in a behavior audit comes from one cognitive operation: **imagine a real user encountering this scenario, then judge whether what the code does makes sense for them.** The discipline below makes that operation reliable.

### Write expectations in user terms, not code terms

The expectation you write in step 3 (before tracing the code) determines whether you can spot a divergence in step 5. If the expectation is phrased in code terms, you've already anchored to the implementation.

✅ **User-term expectations:**
- "the user sees their streak preserved because the day isn't over"
- "the user expects their draft to be saved when they click Save"
- "the user expects the same answer when they refresh the page"
- "the user expects nothing to happen if they double-click — not two copies"
- "the user expects to be able to undo this for at least a few seconds"

❌ **Code-term expectations (anti-pattern):**
- "we shouldn't call `resetStreak()` in the login handler"
- "the `saveDraft()` mutation should be invoked"
- "the cache should not be invalidated"
- "the `submit()` function should be debounced"
- "an undo action should be queued"

The first set lets you notice when the code does something wrong even if the implementation is exotic. The second set only fires if the code matches your specific implementation guess.

### Write the expectation BEFORE reading the code

Trace order matters. Once you've read what the code does, your "reasonable user expectation" silently warps to fit. The discipline:

1. Pick the next scenario from the checklist.
2. Close your mental view of the code. Write down what a reasonable user would expect.
3. Now open the code, trace the scenario, write what actually happens.
4. Compare.

If you find yourself writing the expectation as "well, the code does X, so the user expects X" — stop. You've anchored. Re-write the expectation pretending the code doesn't exist yet.

---

## 2. Scenario Axis Catalogs

Each axis below lists scenarios to consider, with at least one worked example showing how the scenario surfaces a behavioral bug.

### 2a. Temporal — when does this happen?

How does the feature behave at different points in time?

- Start of day / mid-day / end of day
- Near midnight, near a billing period boundary, near a deadline
- Across timezone boundaries (user's local tz vs server tz vs UTC)
- Immediately after another action vs after long inactivity
- Before, during, and after a scheduled job runs (cron, daily reset, weekly digest)
- During a maintenance window
- The very first time vs the Nth time
- After a long delay between two parts of a multi-step flow

**Worked example — the streak case (canonical):**

- Feature: "If a user logs a day with no activity, their streak resets to 0."
- Scenario picked: User logs in at 9 AM with no activity yet today.
- User-perspective expectation: "I just woke up — my streak should still be intact. The day isn't over. I can still earn activity today."
- Actual behavior (from code trace): `loginHandler.ts:42` calls `checkActivityForToday()`. No activity found. `resetStreak()` is called. User sees "Streak: 0" on dashboard.
- Comparison: Hard mismatch. The rule "no activity for the day = reset streak" is correct in principle, but firing it at *login moment* — before the day is even over — punishes the user for not having done anything yet, instead of for failing to do anything by day's end.
- Severity: **Warning** — defensible rule fired at the wrong moment, creates real friction.
- Fix direction (for context, not part of the audit's job): apply the rule at end-of-day via a scheduled job, not at login.

### 2b. State — what state is the user in?

How does the feature behave for users in different states?

- Brand-new user with no history at all
- Returning user mid-flow (came back to a half-completed action)
- Power user with large data volumes (1000s of items)
- Empty state (no items, no history)
- Near-limit state (just under a quota)
- Just-past-limit state (just exceeded a quota — what changes?)
- Suspended, locked, or unverified user
- Free tier vs paid tier
- User who hit an error in this feature previously

**Worked example — empty state:**

- Feature: "Show the user a leaderboard of their most-active friends."
- Scenario picked: Brand-new user with zero friends.
- User-perspective expectation: "I just signed up — I'd expect to see a friendly empty state inviting me to add friends, or maybe a global leaderboard for context."
- Actual behavior: Component renders an empty `<ul>` with no message. Looks like the page is broken.
- Comparison: Empty UL is internally consistent code, but reads to the user as "this feature is broken" rather than "you have no friends yet."
- Severity: **Suggestion** — empty-state polish; not a bug, but a clear UX improvement.

### 2c. Sequence — what order did things happen in?

How does the feature behave under different action orderings?

- A then B vs B then A
- A repeated quickly (double-click, retry storm)
- A interrupted partway through (page refresh, navigation away)
- A and B happening concurrently (two tabs, two devices)
- A undone, then redone
- A from one session, B from another
- A from web, B from mobile

**Worked example — double-click on submit:**

- Feature: "Submit button creates a new order."
- Scenario picked: User double-clicks Submit before the first request returns.
- User-perspective expectation: "I clicked twice because the page felt slow. I expect one order, not two."
- Actual behavior: Two POST requests fire, both succeed, two orders are created and visible in the user's order list.
- Comparison: The code is consistent (each click triggers one submit), but the user sees a duplicate they did not intend.
- Severity: **Critical** — most users would consider this a bug, and it costs them real money.

### 2d. Failure injection — what if step N fails?

How does the feature behave when a step in the flow fails?

- Network error mid-flow — does the user end up in a half-committed state visible to them?
- Backend write succeeds, frontend state update fails — what does the user see?
- One of N parallel operations fails — partial success surfaced or hidden?
- Permission denied mid-flow — does the partial work persist or roll back?
- Validation error after a side effect already triggered (e.g., email already sent) — is the side effect reverted or just ignored?
- Database write succeeds, cache invalidation fails — stale data shown?
- Background job fails silently — does the user know?

**Worked example — partial-write visibility:**

- Feature: "Saving a profile updates display name, avatar, and email subscriptions in three writes."
- Scenario picked: First two writes succeed, third (email subscriptions) fails with a 500.
- User-perspective expectation: "Either the whole save worked, or I see an error and nothing changed. I shouldn't end up with a half-saved profile and no clear signal."
- Actual behavior: Display name and avatar update visibly. A toast says "Save failed." Email subscriptions are unchanged in the DB but the form shows the user's attempted values.
- Comparison: User now sees inconsistent state — the form shows new values for everything, but only some are persisted. They can't tell what saved and what didn't.
- Severity: **Critical** — partial state visible to the user; the feature must either be transactional or surface exactly which fields failed.

### 2e. Cross-feature interaction — what else does this touch?

How does the feature interact with other features that read or mutate the same state?

To enumerate this axis efficiently:

1. From the diff, list every shared resource the new code reads or writes: database tables, store/state keys, cache keys, event names, URL paths.
2. For each, Grep across the codebase for other call sites. Each unique caller is a candidate cross-feature scenario.
3. For each, ask: what happens to that other feature when this one runs?

**Worked example — cross-feature mutation breaks an invariant:**

- Feature: "Admin can mark a user as 'shadow-banned' — their posts are hidden from other users but they don't know."
- Scenario picked: Shadow-banned user uses the existing "Boost post" feature (which puts their post in the Trending feed).
- User-perspective expectation: "If shadow-banning hides my posts, it should hide them everywhere — including Trending. Otherwise the boost flow lies to the user."
- Actual behavior: Shadow-ban filter only applies to the main feed query. The Trending feed query in `feeds/trending.ts:88` doesn't include the filter. Boosted posts from shadow-banned users appear in Trending to everyone.
- Comparison: The new shadow-ban feature breaks the implicit invariant that hidden posts stay hidden everywhere. The cross-feature interaction wasn't considered.
- Severity: **Critical** — functional gap that contradicts the feature's stated purpose.

---

## 3. Severity Classification — Worked Examples

The same scenario can land at different severities depending on how badly the realized behavior fails the user. These examples calibrate the boundaries.

### Same feature, three severities

**Scenario:** A "Delete account" button.

**As Critical:**
- User-perspective expectation: "Delete account is a one-way scary operation. I expect to be asked to confirm, and I'd expect a grace period to recover if I clicked it by mistake."
- Actual: Click → instant irreversible delete with no confirmation modal.
- Why Critical: Almost every user would consider this a bug. Destructive irreversible action with no confirmation.

**As Warning:**
- Variant: Click → confirmation modal → immediate hard delete; user only finds out their data is gone when they try to recover something the next day.
- User-perspective expectation: "Even after I confirm, I'd expect a short grace period to undo this."
- Actual: Hard delete fires synchronously after the confirm; no recovery path.
- Why Warning: Defensible (the user did confirm), but a thoughtful design would still offer a short undo window. Real friction for users who confirm by mistake or change their mind.

**As Suggestion:**
- Variant: Click → confirmation modal → 7-day soft-delete with a "restore" link in the deletion email.
- User-perspective expectation: "I clicked delete and I want it gone."
- Actual: Account is in a 7-day soft-delete; if the user logs back in by accident, they get a "restore your account?" prompt.
- Why Suggestion: The implementation is defensible (and arguably better than the user's literal expectation), but a privacy-sensitive user might object to data persisting for 7 days. Worth surfacing for judgment, not blocking.

### When to use which severity

Use **Critical** when:
- A clear majority of users would call the behavior a bug if asked directly.
- The behavior contradicts the feature's stated purpose (e.g., "save draft" doesn't save).
- The behavior produces partial or inconsistent state that the user can see.
- The behavior fires a destructive or irreversible action without confirmation.

Use **Warning** when:
- The behavior is internally consistent and defensible in principle, but creates real friction or surprise for a typical user.
- A reasonable defense exists, but it conflicts with how a thoughtful user would expect things to work.
- *The streak example.* A defensible rule fires at the wrong moment.

Use **Suggestion** when:
- A minor rough edge or polish opportunity (empty states, small inconsistencies, edge-case wording).
- The user's reaction depends on context the audit can't see (their preferences, their other tools, their tier).
- The behavior is acceptable for most users but a thoughtful designer would have done it differently.

When unsure between two adjacent severities, pick the lower one. Don't pad findings to fill quotas.

---

## 4. Illustrative Anti-Patterns (Non-Exhaustive)

The patterns below recur in AI-generated implementations and frequently produce bad user experiences. They are **examples to prime your thinking — not a checklist, and far from a complete catalog.** The point of this skill is first-principles reasoning about a specific user in a specific scenario; these examples just illustrate the kind of behavior worth catching. A finding does not need to fit any of these patterns to be valid, and most real findings won't.

### Applying business rules at convenient code points instead of semantically correct ones

The streak example is the canonical case. The rule "no activity = reset streak" is correct as a rule. But it fires in the login handler — a code point that happens to be convenient because that's when the user appears, not because that's when the rule should evaluate.

Look for: business rules evaluated synchronously inside request handlers when they should run on a schedule, or evaluated on a schedule when they should run on user action.

### Treating the most recent state as authoritative without considering staleness

AI-generated code often reads from a cache or store, returns the value, and treats that as the current truth — without considering that the value may be stale by tens of seconds, the user's session may pre-date a permissions change, or two tabs may have diverged.

Look for: state reads where the user could have meaningfully different state than the cached/stored value, especially after permissions changes, cross-tab actions, or background updates.

### Optimistic UI without backend confirmation

AI code frequently updates UI state optimistically and either never reconciles, reconciles poorly, or shows the user "success" before the backend has confirmed.

Look for: UI state changes immediately after user action with no path that handles backend rejection or no clear visual signal that the action is pending vs confirmed.

### Treating absence of evidence as evidence of absence

AI code often interprets "no record found" as a definitive negative without considering that the record might not exist *yet*, might be filtered out by the current query's WHERE clause, or might be in a different table the query didn't check.

Look for: code that branches on "found vs not found" and takes a destructive or irreversible action in the "not found" branch.

### Mutating shared state without considering other consumers

AI code often makes a shared resource change to satisfy the immediate feature without checking what else reads or writes that resource. The shadow-ban example in 2e is canonical.

Look for: writes to shared tables, stores, caches, or event buses that don't have a paired check for what else depends on the invariant being changed.

### Literal compliance with a flawed instruction

AI implementers tend to comply with their instructions literally, even when the literal interpretation produces a behavior nobody actually wanted. The instruction may have been a feature request, a plan, a comment, or a ticket — the bias is the same: the implementer satisfied the words, not the intent. This is a key reason behavior-audit must reason from first principles. The audit's job is to ask "does this make sense for the user?" — not "did the implementer follow instructions?"

Look for: behaviors that look like they were copied verbatim from a feature request, with no adjustment for foreseeable user reactions.

---

## 5. Output Style — Worked Examples

### Well-written finding (user-perspective)

```
## Critical

### Submitting an order twice via double-click creates two orders

- **Expected (user perspective)**: Clicking Submit twice in quick succession creates one order. Users double-click when a page feels slow; they don't expect duplicate orders as a punishment.
- **Actual (from code trace)**: Each click triggers an independent `POST /orders` from `OrderForm.tsx:84`. The button is not disabled while the request is in flight. Two clicks → two orders, both visible in the user's order list within seconds.
- **Why this is wrong**: Duplicate orders cost users real money and create cleanup work for support. The fix (disable button while pending, or idempotency key on the request) is well-understood and the absence of it is a clear oversight.
- **Path**: `OrderForm.tsx:84`, `api/orders/post.ts:23`
```

### Poorly-written finding (code-perspective — do not write findings like this)

```
## Critical

### `submitOrder()` is not debounced

- **Issue**: `OrderForm.tsx:84` calls `submitOrder()` on click without debouncing.
- **Fix**: Wrap in `useDebouncedCallback` or disable the button.
- **Path**: `OrderForm.tsx:84`
```

The poor version describes the code. The good version describes the experience. The good version would be findable even if the implementation had been done with promises, RxJS, or a server-side rate limiter — because the audit started from the user's experience, not from a code pattern.

### Well-written Warning finding

```
## Warning

### Logging in resets the user's streak when no activity has been recorded yet today

- **Expected (user perspective)**: A user who logs in at 9 AM with no activity yet today expects their streak to be intact — the day isn't over and they could still earn activity.
- **Actual (from code trace)**: When the user logs in, `loginHandler.ts:42` checks for any activity record dated today. If none, `resetStreak()` runs immediately and the dashboard renders "Streak: 0". This happens whether the user logs in at 7 AM or 11 PM.
- **Why this is wrong**: The rule "no activity in a day → streak resets" is reasonable, but firing it at login moment punishes the user before the day is over. A user who logs in to start their day sees their streak destroyed for activity they haven't done yet. The fix is to apply the rule at end-of-day via a scheduled job, not synchronously at login.
- **Path**: `loginHandler.ts:42`, `streak/reset.ts:18`
```

This finding is a clean Warning because the rule is defensible in principle, but the user perspective clearly identifies a real problem the implementer didn't think through.
