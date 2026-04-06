---
name: write-tests
description: Use when writing, reviewing, or fixing tests in any language or framework, or when auditing a test suite for general best practices. Triggers on test structure issues, assertion quality, test isolation failures, flakiness, over-mocking, naming problems, or missing coverage. Defer to write-tests-deno, write-tests-frontend, or write-tests-pgtap when the domain is specifically Deno edge functions, React components, or pgTAP database tests.
---

# Test Writing

Write and review automated tests across any language and framework. Every recommendation is sourced from established testing literature — see [REFERENCE.md](REFERENCE.md) for citations.

## Scope

Determine what to review or write based on user request:

- **Write mode**: write new tests for code the user specifies
- **Review mode**: audit existing test files for anti-patterns and best practice violations
- **Fix mode**: fix failing, flawed, or flaky tests

**Domain-specific skills take precedence**: if the work involves Deno edge functions, React/RTL, or pgTAP, use the dedicated skill instead. This skill covers everything else — backend services, libraries, CLI tools, utility functions, data pipelines, and cross-cutting test suite concerns.

## Prerequisites

Before writing or reviewing tests, identify:

1. **Test runner and assertion library** — read the project's config (e.g., `vitest.config.ts`, `jest.config.js`, `pyproject.toml`, `Cargo.toml`, `go.mod`) to determine what's already in use
2. **Existing test conventions** — read 2-3 existing test files to understand the project's naming, structure, and assertion style
3. **What the code under test does** — read the source before writing tests for it

Do NOT introduce a new test framework or assertion library without explicit user approval.

## Principles to Enforce

### 1. Test Structure — Arrange, Act, Assert

Every test should have three distinct phases:

- **Arrange**: set up preconditions and inputs
- **Act**: execute the behavior under test (one action per test)
- **Assert**: verify the expected outcome

Separate the phases with blank lines. If a test mixes acting and asserting, it's testing multiple behaviors — split it.

The equivalent BDD formulation is **Given-When-Then**: given some precondition, when an action occurs, then expect an outcome.

### 2. Test Behavior, Not Implementation

Tests should verify **what** the code does, not **how** it does it.

- Assert on **outputs** (return values, state changes, side effects at system boundaries) — not on internal method calls, private state, or execution steps
- A refactor that preserves behavior should not break tests
- If renaming a private helper breaks a test, the test is coupled to structure, not behavior

This is the single most important principle. Structure-coupled tests generate false failures on every refactor, eroding trust in the suite.

### 3. Test Isolation and Independence

- Each test must be self-contained — no dependence on execution order or shared mutable state
- Tests must not communicate through global variables, files, databases, or environment state without cleanup
- Use setup/teardown hooks to reset state between tests
- If a test fails, it should fail regardless of which other tests ran before it

### 4. Determinism

A test that sometimes passes and sometimes fails (a "flaky" test) is worse than no test — it erodes trust in the entire suite.

Common flakiness sources and fixes:

| Source | Fix |
|--------|-----|
| Wall-clock time (`Date.now()`, `time.time()`) | Inject a clock or use the framework's time-faking utility |
| Random data without seeding | Use a fixed seed or deterministic test data |
| Network calls to external services | Use test doubles (fakes, stubs) for external dependencies |
| Race conditions in async code | Await all async operations; don't rely on timing |
| Shared mutable state between tests | Reset in setup/teardown; don't share across tests |
| File system or environment pollution | Use temp directories; restore env vars after each test |
| Test order dependence | Run tests in random order to surface hidden coupling |

### 5. Assertion Quality

Use the most specific assertion available:

| Situation | Use | NOT |
|-----------|-----|-----|
| Exact value equality | `assertEqual` / `assertEquals` / `toBe` | `assertTrue(a == b)` |
| Deep object equality | `assertDeepEqual` / `toEqual` | manual field-by-field checks |
| Partial object match | `toMatchObject` / `assertObjectMatch` | full equality on large objects |
| Exception expected | `assertThrows` / `assertRaises` / `toThrow` | try/catch with manual fail |
| No exception expected | Just call it — failure throws automatically | wrapping in try/catch |
| String contains | `assertIn` / `toContain` / `assertStringIncludes` | `assertTrue(s.includes(...))` |
| Collection contains | `assertIn` / `toContain` / `assertArrayIncludes` | loop + boolean |
| Approximate numeric | `assertAlmostEqual` / `toBeCloseTo` | rounding then exact compare |
| Null/undefined check | `assertIsNone` / `toBeNull` / `assertExists` | `assertEqual(x, null)` |
| Boolean condition | `assertTrue` / `assertFalse` | `assertEqual(x, true)` |

**Why specific assertions matter**: when a test fails, `assertEqual(result, 42)` tells you "expected 42, got 17." `assertTrue(result == 42)` tells you "expected true, got false" — useless for diagnosis.

### 6. Test Naming

Test names are documentation. A failing test name should tell you **what broke** without reading the test body.

**Include three things**: the subject (what's being tested), the scenario (under what conditions), and the expected outcome.

Good patterns:
- `test_transfer_fails_when_balance_insufficient`
- `"returns 404 when user does not exist"`
- `should reject expired tokens`

Bad patterns:
- `test1`, `testTransfer`, `it works`
- Names that describe the implementation: `test_calls_validate_then_save`

Adopt the project's existing convention. If none exists, prefer descriptive sentences over method-name mirrors.

### 7. Test Doubles — Use the Right Type

Use test doubles only when the real dependency is **slow**, **non-deterministic**, or **has side effects you can't reverse** (sends email, charges money, writes to production).

| Double | What it does | When to use |
|--------|-------------|-------------|
| **Fake** | Working lightweight implementation (e.g., in-memory database) | Best default when real impl is impractical |
| **Stub** | Returns predetermined values, ignores unexpected calls | Getting the SUT into a specific state for testing |
| **Spy** | Records calls for later verification while keeping real behavior | Verifying a side-effect call was made at a system boundary |
| **Mock** | Pre-programmed with expectations; fails if expectations aren't met | Only at system boundaries where you must verify interaction |
| **Dummy** | Fills a required parameter, never actually used | Satisfying a function signature |

**Prefer real implementations** when they're fast and deterministic. **Prefer fakes over mocks** when you need a double. **Prefer state verification over behavior verification** — assert on what happened, not how it happened.

**Anti-pattern: over-mocking**. If a test has more mock setup than assertions, it's testing the mocking framework, not the code. Mocking internal collaborators couples tests to implementation structure.

### 8. One Behavior Per Test

Each test should verify one logical behavior. This means:

- **One Act step** — a single action that triggers the behavior
- **Focused assertions** — assert on the outcome of that one action (multiple assertions on the same result are fine)
- If a test name needs "and" (e.g., "validates input **and** saves to database"), split it

Single-behavior tests produce specific, diagnosable failures. A test that checks five things tells you "something is wrong" — five focused tests tell you exactly what.

### 9. Edge Cases and Boundary Values

For any function that accepts input, test:

- **Happy path**: typical valid input
- **Boundary values**: at the edges of valid ranges (0, 1, max, max+1, empty string, single char)
- **Invalid input**: null/undefined/None, wrong types, empty collections, negative numbers
- **Error paths**: what happens when dependencies fail, network is down, disk is full

Use **equivalence partitioning** — don't test every integer from 1 to 100 when they all exercise the same code path. Pick one representative from each equivalence class plus the boundaries.

### 10. Test Speed

Slow tests don't get run. Keep the feedback loop tight:

- **Unit tests**: milliseconds per test, seconds for the full suite
- **Integration tests**: seconds per test, minutes for the suite
- **End-to-end tests**: seconds to minutes per test, reserved for critical paths

If unit tests are slow, they're probably not unit tests — they're hitting the network, database, or filesystem. Push I/O to the edges and test the core logic in isolation.

### 11. DAMP Over DRY

Test code should be **Descriptive And Meaningful Phrases** (DAMP), not strictly DRY.

- A reader should understand a test **without reading any other code** — including shared helpers
- Extract shared **setup mechanics** into helpers (how to create a user, how to set up the database)
- Keep the **scenario-specific values** inline (what makes this test different from the next)
- If extracting a helper makes a test harder to understand, don't extract it

Mild duplication in tests is acceptable — even preferable — when it keeps each test self-explanatory.

### 12. Test the Public API

- Test through **public interfaces** — the API consumers actually use
- Do NOT test private/internal methods directly — they're tested implicitly through public behavior
- If a private method feels like it needs its own test, it's probably complex enough to extract into its own module with a public API

## What to Test vs What NOT to Test

**Test:**
- Business logic and domain rules
- Input validation and error handling
- Boundary conditions and edge cases
- Integration points (database queries, API calls, file I/O)
- Security-critical paths (auth, authorization, input sanitization)
- Error recovery and failure modes

**Do NOT test:**
- Language features or framework internals (the framework is already tested)
- Trivial code with no logic (simple getters, pass-through functions)
- Third-party library behavior (unless you're verifying your understanding of its contract)
- Implementation details (private methods, internal state, call order of collaborators)

## Test Organization

### File placement
- Colocate tests with source when the language/framework supports it (`module.test.ts` next to `module.ts`)
- Or use a parallel `tests/` directory mirroring the source structure
- Follow the project's existing convention

### File structure
- One test file per source module
- Group related tests with `describe`/`context`/`class` blocks (if the framework supports it)
- Order tests: happy path first, then edge cases, then error cases

## Common Anti-Patterns

| Anti-Pattern | Why it's wrong | Fix |
|---|---|---|
| Testing implementation details | Breaks on refactor, doesn't catch real bugs | Assert on outputs and observable behavior |
| Over-mocking | Tests pass but code is broken in production | Prefer real implementations and fakes |
| Shared mutable state | Tests become order-dependent and flaky | Reset state in setup/teardown |
| No assertion / no useful assertion | Test always passes — provides zero value | Every test needs at least one meaningful assertion |
| `assertTrue(condition)` for everything | Failure message is useless ("expected true, got false") | Use specific assertions (`assertEqual`, `toContain`, etc.) |
| Giant setup / nested beforeEach | Tests are incomprehensible, setup hides intent | Inline scenario-specific setup, extract only mechanical helpers |
| Sleeping for async | Flaky and slow — either too short or too long | Use proper await, polling, or condition-based waits |
| Catching and ignoring exceptions | Hides real failures | Let exceptions propagate; use `assertThrows` for expected ones |
| Copy-paste test suites | Maintenance nightmare, diverge over time | Extract shared setup into helpers; parameterize when appropriate |
| Testing everything through E2E | Slow, flaky, hard to diagnose | Push tests down the pyramid; E2E for critical paths only |

## Output Format (Review Mode)

When reviewing existing tests, group findings by severity:

```
## Critical
Issues that make tests unreliable, flaky, or misleading.

### [PRINCIPLE] Brief title
**File**: `path/to/file.test.ts` (lines X-Y)
**Principle**: What the standard requires.
**Violation**: What the code does wrong.
**Fix**: Specific, actionable suggestion.

## Warning
Issues that weaken test value or violate conventions.

(same structure)

## Suggestion
Improvements aligned with best practices.

(same structure)
```

## Rules

- **Match the project's conventions**: adopt existing naming, structure, and assertion style before introducing anything new.
- **Test behavior, not implementation**: this is the hill to die on. Structure-coupled tests are worse than no tests.
- **Prefer real implementations**: use test doubles only when the real thing is slow, non-deterministic, or has irreversible side effects.
- **One behavior per test**: each test verifies one thing and has a name that says what that thing is.
- **Deterministic always**: a flaky test is a bug in the test, not in the code. Fix it or delete it.
- **Readable over clever**: test code is read far more often than it's written. Optimize for the reader.
- **Fast feedback**: if tests are too slow to run on every save, they're too slow.
