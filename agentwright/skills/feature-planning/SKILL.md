---
name: feature-planning
description: Extensively plans a proposed feature before any code is written. Use when the user asks to plan, design, or spec out a feature, or when they say "plan this feature", "design this", or want to think through a feature before building it.
---

# Feature Planning

Enter plan mode and produce a thorough, implementation-ready feature plan. Do not write any code until the plan is approved.

## Trigger

When this skill is invoked, **immediately enter plan mode** using the EnterPlanMode tool. All planning work happens inside plan mode.

## Scope

- **User describes a feature**: Treat the description as the starting point. Explore the codebase to understand where the feature fits before designing anything.
- **Request is vague or ambiguous**: Ask clarifying questions using AskUserQuestion before proceeding. Do not assume intent. Common ambiguities to probe:
  - Who is the target user or actor?
  - What is the expected behavior vs. current behavior?
  - Are there constraints (performance, compatibility, platform)?
  - What is explicitly out of scope?
  - Are there related features this interacts with?
- **User provides a detailed spec**: Validate it against the codebase. Identify gaps, contradictions, or unstated assumptions and raise them before planning.

Do NOT skip clarification. A plan built on wrong assumptions wastes more time than a question.

## Process

### 1. Understand Context

- Read the project's SPEC.md, README, CLAUDE.md, and any relevant docs to understand the system's architecture, conventions, and existing features.
- Explore the codebase areas the feature will touch. Identify existing patterns, data models, state management, and UI conventions.
- Map out what already exists that the feature will interact with or depend on.
- **API/tech stack verification**: If the feature involves specific APIs, SDKs, or third-party services, look up the official documentation directly before designing anything. Check if available MCP tools (Supabase, Vercel, etc.) can accelerate this lookup. Never assume correct API usage from training knowledge alone — docs may have changed and wrong API usage produces security holes, not just bugs.
- Output: A brief summary of the current system context relevant to this feature.

### 2. Clarify Requirements

- If any of the following are unclear, ask before continuing:
  - **Functional requirements**: What exactly should the feature do? What are the inputs, outputs, and user flows?
  - **Non-functional requirements**: Performance targets, data volume expectations, offline behavior, accessibility.
  - **Boundaries**: What is in scope vs. out of scope for this iteration?
  - **Dependencies**: Does this require new APIs, services, migrations, or third-party integrations?
- Output: A clear, numbered list of confirmed requirements.

### 3. Design the Feature

Produce a plan that covers each of the following sections. Skip a section only if it genuinely does not apply.

#### 3a. User-Facing Behavior
- Describe the feature from the user's perspective: what they see, what they do, what happens.
- Cover the happy path end-to-end.
- Define error states and what the user sees when things go wrong (invalid input, network failure, permission denied, etc.).

#### 3b. Data Model Changes
- New types, interfaces, database tables, or schema changes.
- Migrations needed and their reversibility.
- Impact on existing data (backwards compatibility, data backfill).

#### 3c. Architecture & Module Design
- Which files/modules will be created or modified.
- How the feature integrates with the existing architecture (state management, routing, API layer, etc.).
- Clear responsibility boundaries: what each new module/function owns.

#### 3d. API & Integration Points
- New endpoints, webhooks, or external service calls.
- Request/response shapes.
- Authentication and authorization requirements.

#### 3e. State Management
- What state the feature introduces (local, global, persisted, cached).
- State transitions and lifecycle.
- How state syncs across components or with the backend.

#### 3f. Implementation Steps
- An ordered sequence of concrete implementation steps.
- Each step should be small enough to be a single commit.
- Note dependencies between steps (what must come before what).
- Identify which steps can be done in parallel.

### 4. Analyze Quality Dimensions

Proactively evaluate the proposed design against each of these dimensions. For each, explicitly state what risks exist and how the design addresses them. If a dimension does not apply, say so briefly. See [REFERENCE.md](REFERENCE.md) for named standards, plan quality criteria, templates, and anti-patterns.

#### Bugs & Correctness
*(Applies `correctness-audit` — Dimensions 1–9: Logic Bugs through Concurrency & Shared State)*

Review the design against the `correctness-audit` dimensions. State which are highest-risk for this feature:
- **Logic bugs**: off-by-one errors, boolean inversions, wrong operators in proposed conditional logic
- **Null / undefined**: fields that can be absent — are they guarded? Do nullable DB columns match their TypeScript types?
- **Async & Promise**: are concurrent async paths safe? Is there risk of fire-and-forget on critical writes?
- **Concurrency / TOCTOU**: can concurrent requests (multiple users, tabs, or duplicate submissions) corrupt shared state? Does any step read-check-act on data another operation could change between check and act?

#### Edge Cases
*(Applies `correctness-audit` — Dimensions 7 & 8: Edge Case Inputs, External Data & Network)*

- **Empty state**: what does the user see before any data exists for this feature?
- **Boundary values**: max field lengths, max collection sizes, numeric overflow — are they defined and enforced at both the API and database layers?
- **Network failures**: if an operation fails mid-way, what state is the system left in? Is partial completion visible to the user?
- **Reentrant / concurrent usage**: double-submit, multiple tabs, back-button navigation mid-flow.
- **External data**: any third-party API or webhook payload — is it validated as `unknown` before use, not cast directly to a typed shape?

#### Design Quality
*(SOLID — Robert C. Martin; Clean Architecture — Robert C. Martin & Martin Fowler)*

- **SRP**: does each new module have one clearly stated reason to change?
- **OCP**: can new behavior be added by extension without modifying existing modules?
- **DIP**: do high-level modules depend on abstractions, not concrete implementations?
- **Dependency direction**: do dependencies point inward (domain ← application ← infrastructure)? No domain module should depend on a framework or I/O layer.
- Does the design follow existing project patterns, or introduce a new one? If new, is the justification explicitly stated?

#### Maintainability
*(Clean Code — Robert C. Martin; The Pragmatic Programmer — Hunt & Thomas)*

- Will a developer unfamiliar with this feature understand it from the plan alone, without asking the author?
- Are proposed module and function names self-documenting?
- Are non-obvious design decisions explained in the plan's rationale, not left as tribal knowledge?
- Are implicit contracts between modules made explicit (typed interfaces, documented invariants)?

#### Modularity
*(SOLID — SRP, ISP, DIP; UNIX philosophy)*

- Can each new component be unit-tested in isolation, without the full stack?
- Are new module dependencies unidirectional? Does the design introduce any circular imports?
- Could any new module be replaced or reused independently of the others?

#### Simplicity
*(KISS — Clarence Johnson, 1960; YAGNI — Extreme Programming, Kent Beck & Ron Jeffries)*

- **KISS**: is this the simplest design that satisfies the stated requirements?
- **YAGNI**: are there components designed for hypothetical future requirements not in scope for this iteration?
- Does the language or framework already provide something the design is building from scratch?
- Is there unnecessary indirection — interfaces, factories, registries — with only one concrete implementation?

#### Scalability
*(Applies `correctness-audit` — Dimensions 10–12: Algorithmic Complexity, Database & I/O, Memory & Throughput)*

- Will this design function correctly at 10× the current data volume without architectural changes?
- Are there unbounded database queries (no `LIMIT`) or full-collection loads into memory?
- Are there N+1 query patterns that will emerge as data grows?
- Is any coordination state stored in-memory in a way that breaks under horizontal scale-out?

#### Security
*(Applies `security-audit` — use the relevant domains for each new design element)*

Map each new element of the design to the applicable security-audit domains:
- **New API endpoint** → §2 Authorization, §5 Input Validation, §6 API Security, §8 Rate Limiting
- **New database table or function** → §7 Database Security (RLS, REVOKE, CHECK constraints)
- **New auth flow or session handling** → §1 Authentication & Session Management
- **New external service call or webhook** → §6 API7 SSRF, §10 webhook deduplication & signature
- **New financial operation** → §10 Financial & Transaction Integrity, §9 Concurrency & Race Conditions
- **New user data stored or transmitted** → §13 Data Privacy & Retention, §4 Cryptography & Secrets

### 5. Identify Risks & Open Questions

- List anything that could go wrong or that you're uncertain about.
- Flag technical risks (performance cliffs, migration dangers, dependency on unstable APIs).
- Flag product risks (user confusion, feature conflicts, scope creep).
- For each risk, suggest a mitigation or note that it needs a decision.

## Output Format

Write the plan to the plan file with this structure:

```
# Feature: [Name]

## Context
[Brief summary of current system state relevant to this feature]

## Requirements
1. [Confirmed requirement]
2. ...

## Design

### User-Facing Behavior
[Description with happy path and error states]

### Data Model Changes
[Types, schemas, migrations]

### Architecture
[Modules, files, integration points]

### API & Integration Points
[Endpoints, external calls]

### State Management
[State shape, transitions, sync]

### Implementation Steps
1. [Step with description]
2. ...

## Quality Analysis

### Bugs & Correctness
[Risks and mitigations]

### Edge Cases
[Identified edge cases and how they're handled]

### Design Quality
[Assessment]

### Maintainability
[Assessment]

### Modularity
[Assessment]

### Simplicity
[Assessment]

### Scalability
[Assessment]

### Security
[Assessment]

## Risks & Open Questions
- [Risk/question with proposed mitigation or decision needed]

## Out of Scope
- [What this plan explicitly does not cover]
```

## Rules

- **Plan mode first**: Always enter plan mode before doing any planning work. The plan is written to the plan file, not output as chat.
- **No code**: Do not write implementation code during planning. The plan is the deliverable.
- **Ask, don't assume**: If the request is ambiguous, ask clarifying questions. Prefer one round of good questions over multiple rounds of back-and-forth.
- **Read before designing**: Explore the codebase thoroughly. Reference actual file paths, function names, and patterns from the project.
- **Be concrete**: Implementation steps should reference specific files and modules, not vague descriptions like "update the backend."
- **Be honest about uncertainty**: If you're unsure about something, flag it as an open question rather than making a guess that will become the plan.
- **Respect existing patterns**: The plan should extend the project's architecture, not fight it. If a new pattern is warranted, justify why.
- **Scope boundaries**: Clearly state what is and isn't included. Prevent scope creep by naming it.
- **Verify API usage against official docs**: Before finalizing any design that uses a specific SDK, API, or third-party service, consult the official documentation to confirm correct usage. Use available MCP tools (Supabase, Vercel, etc.) where possible. Do not rely on training knowledge — incorrect API usage is a design flaw that silently becomes a security vulnerability.
- **Name the pattern**: when the design follows or introduces a named pattern (Repository, Strategy, ADR, C4 Container), name it and note its source so the rationale is traceable.
- **Delegate to audit skills**: the quality analysis does not re-describe what the audit skills cover in detail — it identifies which domains apply and defers to those skills for the specific checklist.
