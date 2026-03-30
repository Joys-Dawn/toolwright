# Feature Planning — Reference

Detailed standards, plan quality criteria, templates, and anti-patterns for the skill defined in `SKILL.md`.

---

## 1. Design Methodologies

### C4 Model (Simon Brown)
*Applicable to: Architecture & Module Design section*

Use C4 vocabulary to describe architecture at the right level of detail. Don't describe implementation-level detail in architecture, or architecture-level detail in a code comment.

- **System Context**: How the feature fits in the broader product and what external systems it touches.
- **Container**: Major runtime components (web app, API server, database, message queue, cache). A new Edge Function or a new Supabase table is a container-level concern.
- **Component**: Key modules within a container (e.g., `useNotifications` hook, `NotificationService` class). Most features are designed at this level.
- **Code**: Only describe at this level for non-obvious or algorithmically critical parts.

When writing the Architecture section, identify which C4 level is appropriate. A simple UI tweak is Code-level. A new backend service is Container-level.

### Architecture Decision Records (ADR)
*Applicable to: any significant or non-obvious design choice in the plan*

When the plan makes a non-obvious design choice (e.g., "use Realtime instead of polling", "store as JSONB instead of normalized columns"), embed a mini-ADR in the rationale:

```
**Decision**: [What was chosen]
**Context**: [Why a decision was needed; what problem this solves; what alternatives were considered]
**Consequences**: [What becomes easier; what becomes harder; what is explicitly ruled out]
```

This prevents "we chose X" from becoming tribal knowledge. The next developer reading the code needs to know *why*, not just *what*.

### RFC-Style Specification
*Applicable to: complex or high-risk features affecting multiple systems or teams*

For features that significantly affect multiple teams or carry high design risk, structure the plan to include:

- **Abstract**: 2–3 sentence summary of the feature and its purpose.
- **Motivation**: Why this is needed now. What problem it solves. Why existing solutions are insufficient.
- **Drawbacks**: Reasons not to build this, or not to build it this way.
- **Alternatives**: Other approaches considered and why they were rejected.

---

## 2. Plan Quality Criteria

A plan section is "done" when it meets these criteria. Self-check before calling `ExitPlanMode`.

### Context
- [ ] References actual file paths, function names, and patterns from the real codebase (not generic descriptions).
- [ ] Identifies all existing systems the feature will interact with or depend on.
- [ ] Notes which existing files will change, not just what will be added.

### Requirements
- [ ] Functional requirements describe observable behavior (inputs, outputs, user flows) — not implementation details.
- [ ] Non-functional requirements name specific targets ("p95 latency < 200ms", "works offline for up to 24h") — not vague aspirations ("it should be fast").
- [ ] Out of scope is stated explicitly for anything a reader might reasonably assume is included.

### User-Facing Behavior
- [ ] Happy path is described end-to-end from the user's perspective.
- [ ] Every error state has an explicit description of what the user sees — not "show an error" but "display 'Something went wrong. Try again.' with a retry button."
- [ ] Empty state is defined (what the user sees before any data exists for this feature).
- [ ] Loading / pending state is defined if the feature involves async operations.

### Data Model Changes
- [ ] New tables include all columns with types, nullability, defaults, CHECK constraints, and FK `ON DELETE` behavior.
- [ ] RLS requirements are stated for every new table.
- [ ] Index requirements are stated based on the query access patterns described in the plan.
- [ ] Migration is characterized as destructive / non-destructive, and whether a data backfill is needed.

### Architecture
- [ ] Lists specific files to be created and specific existing files to be modified.
- [ ] Responsibility of each new module is stated in one sentence.
- [ ] Dependency graph between new modules is described (what imports what).
- [ ] No circular dependencies introduced.

### API & Integration Points
- [ ] Endpoint paths, HTTP methods, request bodies, and response shapes are defined.
- [ ] Auth requirements are stated per endpoint.
- [ ] Error response shapes and status codes are defined (not just the 200 case).

### Implementation Steps
- [ ] Each step is small enough to be a single commit.
- [ ] Dependencies between steps are noted (what must come before what).
- [ ] Steps that can be parallelized are identified.
- [ ] The first step is always safe to merge independently (non-breaking change).

---

## 3. Plan Section Templates

### Data Model Changes

**Bad** (too vague):
> We'll add a notifications table.

**Good** (specific):
> **New table**: `notifications`
>
> | Column | Type | Constraints |
> |--------|------|-------------|
> | `id` | `UUID` | `PRIMARY KEY DEFAULT gen_random_uuid()` |
> | `user_id` | `UUID` | `NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE` |
> | `type` | `TEXT` | `NOT NULL CHECK (type IN ('quest_complete', 'reward_earned', 'system'))` |
> | `read_at` | `TIMESTAMPTZ` | nullable — null means unread |
> | `created_at` | `TIMESTAMPTZ` | `NOT NULL DEFAULT now()` |
>
> **RLS**: `USING (user_id = auth.uid())` for SELECT; no UPDATE/DELETE for users.
> **Index**: `(user_id, created_at DESC)` — supports the "latest N unread for user" query.
> **Migration**: Non-destructive (new table). No backfill required.

---

### Implementation Steps

**Bad** (too vague):
> 1. Build the backend.
> 2. Build the frontend.
> 3. Add tests.

**Good** (specific):
> 1. **[Migration]** Add `notifications` table and RLS policy. Non-destructive; safe to ship independently.
> 2. **[Edge Function]** `POST /notifications/mark-read` — Zod-validated body, updates `read_at`, returns 204. Blocked by step 1.
> 3. **[React hook]** `useNotifications()` — Realtime subscription scoped to `auth.uid()`. Can be built in parallel with step 2.
> 4. **[UI]** `<NotificationBell>` — badge count, dropdown list, "mark all read" action. Blocked by step 3.
> 5. **[Test]** Integration test: verify user A cannot read user B's notifications (RLS enforcement). Blocked by step 1.

---

### API Endpoint

> **`POST /api/quests/:questId/complete`**
> - **Auth**: Requires valid JWT; `getUser()` server-side (not `getSession()`).
> - **Authorization**: Verify `quest.user_id === authenticatedUser.id` before any mutation.
> - **Request body**: `{ evidence: string }` — validated with Zod; `evidence` max 500 chars, non-empty.
> - **Response (200)**: `{ coinsAwarded: number, newBalance: number }`
> - **Response (404)**: Quest not found or does not belong to caller. (Do not distinguish between the two — prevents enumeration.)
> - **Response (409)**: Quest already completed.
> - **Response (422)**: Schema validation failure with field-level errors.

---

### Architecture Decision Record (inline)

> **Decision**: Use Supabase Realtime for live notification updates instead of polling.
> **Context**: The feature requires users to see new notifications without refreshing. Polling every N seconds introduces latency and unnecessary load. Realtime is already available in the project infrastructure.
> **Consequences**: Simpler client code (no polling interval to manage); subscription must be cleaned up on component unmount to avoid leaks; does not work for users behind restrictive firewalls (acceptable for this use case).

---

## 4. Common Planning Anti-Patterns

### Premature Generalization
*(YAGNI — Extreme Programming, Kent Beck & Ron Jeffries)*

The plan designs a general-purpose system for one concrete use case. Examples: building a "plugin architecture" when one integration is needed; an "event bus" when one event type exists; an "action system" for a single action type.

**Signal**: The architecture section describes abstractions (interfaces, factories, registries) where no concrete second implementation exists or is planned.

**Remedy**: Design for the concrete case. Note in Out of Scope that generalization is deferred until a second concrete case exists.

---

### Over-Complex Control Flow
*(KISS — Clarence Johnson)*

The design requires a developer to trace through several interacting systems to follow one user action. Each hop (component → service → event → consumer → database) multiplies failure modes and debugging surface.

**Signal**: Implementation steps require more than 3 conceptual layers for a straightforward operation.

**Remedy**: Simplify the call chain. Prefer direct calls over event-driven patterns until the added complexity is justified by a concrete requirement (e.g., "multiple independent consumers", "decoupled deployment").

---

### Missing Error States in User-Facing Behavior
*(Defensive Programming — Steve McConnell, Code Complete)*

The user-facing behavior section describes only the happy path. Network failures, validation errors, empty states, and permission-denied cases are left undefined. These become inconsistent behavior implemented ad-hoc during implementation.

**Signal**: The user-facing behavior section has no "when X fails, the user sees…" entries.

**Remedy**: For every user-visible action, add an explicit error state: what message appears, where it appears, and whether the user can recover (retry vs. dead end).

---

### Unstated Assumptions
*(The Pragmatic Programmer — Hunt & Thomas: "Don't Assume, Check")*

The plan assumes an external API contract, an existing service capability, a team decision, or an infrastructure arrangement that has not been confirmed. These become discovered blockers during implementation.

**Signal**: Phrases like "we'll integrate with X", "X already supports this", or "the infra team will handle Y" without a reference or confirmation.

**Remedy**: Flag every unconfirmed assumption as an explicit open question in Risks & Open Questions, with a named owner and a decision deadline if possible.

---

### Circular Module Dependencies
*(Clean Architecture — Robert C. Martin)*

The architecture introduces a dependency cycle: A imports B, B imports C, C imports A. This prevents independent testing, makes initialization order fragile, and is a source of "works but nobody knows why" bugs.

**Signal**: In the dependency graph, any arrow forms a loop.

**Remedy**: Extract the shared dependency into a third module that neither A nor C depend on, or invert one dependency using an interface (Dependency Inversion Principle).

---

### Data Model Without Constraints
*(Defensive Programming; database design best practices)*

New tables are defined without `NOT NULL`, `CHECK`, or explicit FK `ON DELETE` behavior. Constraints are the last line of defense — they enforce correctness even when the application layer has a bug or is bypassed (e.g., a direct DB migration, a future code path).

**Signal**: A table definition where any column that should always have a value lacks `NOT NULL`; a financial amount column without a `CHECK (amount > 0)` constraint; a FK without a stated `ON DELETE` policy.

**Remedy**: For every new column, explicitly state: nullable or not, default value, and any domain constraint. For every FK: `CASCADE`, `SET NULL`, or `RESTRICT` — never leave it unstated.
