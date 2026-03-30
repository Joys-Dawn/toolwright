---
name: test-coverage-audit
description: Identifies untested code by mapping source files against their tests. Use when auditing test coverage gaps, assessing what needs tests, or prioritizing where to add tests next. Produces a risk-prioritized list of coverage gaps — not bugs in the code, but missing tests for the code.
---

# Test Coverage Audit

Identify code that lacks adequate test coverage by mapping source modules against their corresponding test files. This audit does NOT find bugs — it finds **missing tests**. The output is a risk-prioritized list of coverage gaps with recommendations for which test writing skill to use.

## Scope

Determine what to audit based on context:

- **Git diff mode** (default when no scope specified and changes exist): run `git diff` and `git diff --cached` to identify changed source files, then check whether those changes have corresponding test coverage
- **File/directory mode**: audit coverage for the files or directories the user specifies
- **Full audit mode**: map the entire source tree against the test tree to find untested modules

Skip: `node_modules/`, `vendor/`, build output, generated files, config files, static assets, migration files (migrations are tested via `test-pgtap`, not unit tests).

## Process

### 1. Map Source to Tests

For each in-scope source file, determine whether a corresponding test file exists.

**Discovery patterns** (check the project's conventions first):

| Source file | Expected test locations |
|------------|----------------------|
| `src/foo.ts` | `src/foo.test.ts`, `src/__tests__/foo.test.ts`, `tests/foo.test.ts` |
| `src/features/auth/login.ts` | `src/features/auth/login.test.ts`, `src/features/auth/__tests__/login.test.ts` |
| `app/core/service.py` | `tests/core/test_service.py`, `app/core/test_service.py` |
| `internal/user/handler.go` | `internal/user/handler_test.go` |
| `supabase/functions/my-fn/index.ts` | `supabase/functions/tests/my-fn-test.ts` |

Also check for:
- Shared test files that test multiple source modules (grep for imports of the source module in test files)
- Integration test files that exercise the module indirectly (API route tests, E2E tests)

### 2. Assess Coverage Depth

For source files that DO have tests, assess whether the tests are adequate:

- **Public API coverage**: are the exported functions/classes tested?
- **Happy path**: is the primary use case tested?
- **Error paths**: are failure modes, validation errors, and edge cases tested?
- **Branch coverage**: are conditionals (if/else, switch, ternary) exercised in both directions?
- **Integration points**: if the module calls external services, databases, or APIs, are those interactions tested?

A file with a test file that only tests one trivial getter is effectively untested for audit purposes.

### 3. Risk-Prioritize Gaps

Not all coverage gaps are equal. Prioritize by risk:

| Priority | Criteria | Examples |
|----------|----------|---------|
| **Critical** | Business logic that handles money, auth, data integrity, or user safety | Payment processing, auth middleware, RLS policy logic, data validation |
| **High** | Core feature logic, complex algorithms, code that changes frequently | State machines, parsers, API route handlers, business rules |
| **Medium** | Utility functions with non-trivial logic, integration glue code | Data transformers, API client wrappers, middleware chains |
| **Low** | Simple pass-through code, configuration, trivial helpers | Re-exports, type definitions, simple getters, constants |

### 4. Recommend Test Skill

For each gap, indicate which test writing skill applies:

| Code type | Test skill |
|-----------|-----------|
| Database migrations, RLS policies, RPCs, triggers | `test-pgtap` |
| Supabase/Deno edge functions | `test-deno` |
| React components, hooks, user interactions | `test-frontend` |
| Everything else (backend logic, utilities, APIs, CLI, libraries) | `test-writing` |

## Output Format

```
## Coverage Map

| Source File | Test File | Coverage | Priority |
|------------|-----------|----------|----------|
| `src/auth/login.ts` | `src/auth/login.test.ts` | Happy path only — no error cases | High |
| `src/billing/charge.ts` | _(none)_ | **No tests** | Critical |
| `src/utils/format.ts` | `src/utils/format.test.ts` | Adequate | — |
| `src/api/users.ts` | _(none)_ | **No tests** | High |

## Gaps (by priority)

### Critical

### [RISK] Brief title
**File**: `path/to/file.ts`
**Risk**: Why this code is dangerous to leave untested (what breaks if it has a bug).
**What to test**: Specific behaviors, edge cases, and error paths that need coverage.
**Skill**: Which test writing skill to use.

### High

(same structure)

### Medium

(same structure)

## Summary
- Source files in scope: N
- Files with tests: N (X%)
- Files with adequate coverage: N
- Coverage gaps: N (X critical, Y high, Z medium)
- Recommended priority: start with [most critical gap]
```

## What Counts as "Untested"

- **No test file exists** for the source module — clearly untested
- **Test file exists but is empty or trivial** — only smoke tests, only tests the constructor, only tests one happy path on a complex module
- **Test file exists but is stale** — tests reference functions or behavior that no longer exists in the source, while new functions have no tests
- **Only tested indirectly** — the module is exercised by integration tests but has no unit tests for its internal logic. Flag this as a gap only if the module contains non-trivial logic that benefits from isolated testing.

## What Does NOT Count as a Gap

- **Type definitions and interfaces** — no runtime behavior to test
- **Re-export barrels** (`index.ts` that just re-exports) — no logic
- **Configuration files** — `tailwind.config.ts`, `vitest.config.ts`, etc.
- **Generated code** — Prisma client, GraphQL codegen output, etc.
- **Migration SQL files** — tested via `test-pgtap` against the applied schema, not via unit tests of the SQL file itself
- **Static assets** — images, fonts, CSS
- **Simple constants and enums** — no branching logic

## Rules

- **Map before judging**: read both the source and test files before assessing coverage depth. Don't flag a file as untested if it's covered by a shared integration test.
- **Risk over completeness**: a project doesn't need 100% coverage. Prioritize gaps where bugs would cause real damage (data loss, auth bypass, financial errors).
- **Be specific about what to test**: don't say "add tests for billing.ts" — say "test that `charge()` rejects negative amounts, handles Stripe API errors, and creates an audit log entry."
- **Name the skill**: every gap should specify which test writing skill (`test-pgtap`, `test-deno`, `test-frontend`, `test-writing`) applies.
- **Don't duplicate other audits**: this audit finds missing tests, not bugs in existing code or tests. For bugs, use `correctness-audit`. For test quality issues, use the appropriate test writing skill in review mode.
- **Respect scope**: in diff mode, only assess coverage for changed files.
