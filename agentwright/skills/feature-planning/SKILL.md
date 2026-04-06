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

### 2. Change Impact Analysis

Before designing anything, map the blast radius of the proposed feature — everything it will touch, depend on, or implicitly affect. This step prevents designing in a vacuum and surfaces coupling risks early.

Using Glob, Grep, and Read (all available in plan mode):

#### 2a. Direct Dependencies
- Identify the files, modules, and functions the feature will modify or extend.
- For each, trace its **importers**: what other files import or call it? Use `Grep` on the export names, class names, and function names.
- Build a list of directly affected files and their role (consumer, provider, shared utility).

#### 2b. Implicit Contracts
- For each affected module, identify what callers actually depend on beyond the type signature:
  - **Return shape assumptions**: Do consumers destructure specific fields, rely on array ordering, or assume non-null values that aren't enforced by types?
  - **Timing assumptions**: Do callers assume synchronous behavior, specific response times, or ordering guarantees?
  - **Side effect assumptions**: Do callers rely on this code mutating shared state, writing to a cache, or emitting events as a side effect?
- Read the actual call sites — don't infer from the type signature alone.

#### 2c. Data Flow Downstream
- If the feature changes a data model, API response shape, or state structure, trace downstream:
  - What reads this data? (UI components, other services, exported APIs, cron jobs)
  - What transforms or passes it through? (middleware, serializers, caches)
  - What persists or caches a snapshot of it? (localStorage, CDN, derived tables)
- Flag any consumer that would silently break (no type error, but wrong behavior at runtime).

#### 2d. Test Coverage Gaps
- For each affected file, check if tests exist (`Glob` for `*.test.*`, `*.spec.*` alongside the file).
- For affected functions, `Grep` for their names in test files to see if they have direct test coverage.
- Flag areas where the feature touches code with no tests — these are where regressions will hide.

#### 2e. Output
Produce a **Change Impact Map** summarizing:
- **Files directly modified** by the feature
- **Files indirectly affected** (consumers, importers, downstream readers)
- **Implicit contracts at risk** (specific assumptions that may break)
- **Untested zones** (affected code with no test coverage)
- **Coupling hotspots** (files that appear in multiple dependency chains — high fan-in)

This map feeds directly into the Design and Quality Analysis steps. If the blast radius is unexpectedly large, surface it as a risk and consider whether the scope should be narrowed.

### 3. Clarify Requirements

- If any of the following are unclear, ask before continuing:
  - **Functional requirements**: What exactly should the feature do? What are the inputs, outputs, and user flows?
  - **Non-functional requirements**: Performance targets, data volume expectations, offline behavior, accessibility.
  - **Boundaries**: What is in scope vs. out of scope for this iteration?
  - **Dependencies**: Does this require new APIs, services, migrations, or third-party integrations?
- Output: A clear, numbered list of confirmed requirements.

### 4. Design the Feature

Produce a plan that covers each of the following sections. Skip a section only if it genuinely does not apply.

#### 4a. User-Facing Behavior
- Describe the feature from the user's perspective: what they see, what they do, what happens.
- Cover the happy path end-to-end.
- Define error states and what the user sees when things go wrong (invalid input, network failure, permission denied, etc.).

#### 4b. Data Model Changes
- New types, interfaces, database tables, or schema changes.
- Migrations needed and their reversibility.
- Impact on existing data (backwards compatibility, data backfill).

#### 4c. Architecture & Module Design
- Which files/modules will be created or modified.
- How the feature integrates with the existing architecture (state management, routing, API layer, etc.).
- Clear responsibility boundaries: what each new module/function owns.

#### 4d. API & Integration Points
- New endpoints, webhooks, or external service calls.
- Request/response shapes.
- Authentication and authorization requirements.

#### 4e. State Management
- What state the feature introduces (local, global, persisted, cached).
- State transitions and lifecycle.
- How state syncs across components or with the backend.

#### 4f. Testing Strategy
- Identify what needs to be tested and at which layer (unit, integration, E2E).
- For each layer, note the appropriate test writing skill:
  - **Database tests** (RLS policies, RPCs, triggers, migrations): `write-tests-pgtap`
  - **Edge function tests** (Supabase/Deno HTTP integration tests): `write-tests-deno`
  - **Frontend tests** (React components, hooks, user interactions): `write-tests-frontend`
  - **All other tests** (backend logic, utilities, APIs, CLI, libraries): `write-tests`
- Call out specific behaviors that must be tested (e.g., "RLS: user A cannot read user B's data", "API: returns 400 on malformed input").
- Note any tests that should be written *before* implementation (test-first for complex logic or regression-prone areas).

#### 4g. Implementation Steps
- An ordered sequence of concrete implementation steps.
- Each step should be small enough to be a single commit.
- Note dependencies between steps (what must come before what).
- Identify which steps can be done in parallel.
- **Include test steps** — writing tests is not a separate phase; test steps should be interleaved with the implementation steps they verify.

### 5. Identify Risks

Evaluate the design against the quality dimensions below. **Only surface actual risks** — do not write a section for a dimension that has no findings. See [REFERENCE.md](REFERENCE.md) for detailed checklists and anti-patterns.

Dimensions to check (skip any that don't apply):
- **Correctness**: logic bugs, null/undefined gaps, async pitfalls, concurrency/TOCTOU — per `correctness-audit` dimensions 1–9
- **Edge cases**: empty states, boundary values, network failures, reentrant usage, unvalidated external data
- **Security**: map new design elements to `security-audit` domains (auth, authorization, input validation, RLS, rate limiting, SSRF, data privacy)
- **Scalability**: unbounded queries, N+1 patterns, in-memory coordination that breaks at scale
- **Design**: SOLID violations, circular dependencies, unnecessary abstraction, YAGNI

For each risk found, state: what the risk is, which dimension it falls under, and how to mitigate it. Also flag open questions, product risks, and unconfirmed assumptions here.

## Output Format

Write the plan to the plan file with this structure:

```
# Feature: [Name]

## Context
[Brief summary of current system state relevant to this feature]

## Requirements
1. [Confirmed requirement]
2. ...

## Change Impact Map
- **Files directly modified**: [list]
- **Files indirectly affected**: [consumers, importers, downstream readers]
- **Implicit contracts at risk**: [specific assumptions that may break]
- **Untested zones**: [affected code with no test coverage]
- **Coupling hotspots**: [high fan-in files]

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

### Testing Strategy
[What to test, at which layer, which test skill applies, specific behaviors to verify]

### Implementation Steps
1. [Step with description, including interleaved test steps]
2. ...

## Risks
- [Risk: what could go wrong, which quality dimension it falls under, and proposed mitigation]

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
