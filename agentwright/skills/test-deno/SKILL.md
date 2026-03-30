---
name: test-deno
description: Use when writing, reviewing, or fixing Deno integration tests for Supabase Edge Functions, or when auditing edge function tests for best practices. Triggers on test failures involving sanitizers, assertions, mocking, HTTP testing, or environment isolation.
---

# Deno Edge Function Testing

Write and review integration tests for Supabase Edge Functions using Deno's built-in test runner and official standard library modules. Every recommendation in this skill is sourced from official documentation.

See [REFERENCE.md](REFERENCE.md) for detailed definitions, code examples, and official source citations.

## Scope

Determine what to review or write based on user request:

- **Write mode**: write new tests for edge functions the user specifies
- **Review mode**: audit existing test files for anti-patterns and best practice violations
- **Fix mode**: fix failing or flawed tests

Test files live in the project's edge function test directory (Supabase convention: `supabase/functions/tests/`).

## Prerequisites

Before tests can run, the local Supabase stack must be running:

```bash
# Terminal 1: start local stack
npx supabase start

# Terminal 2: serve functions
npx supabase functions serve --no-verify-jwt --env-file supabase/functions/tests/.env.local

# Terminal 3: run tests
deno test --no-lock --env-file=supabase/functions/tests/.env.local \
  --allow-net --allow-env --allow-read \
  supabase/functions/tests/
```

**`--no-lock` is required** — Supabase Edge Runtime uses Deno v2.1.x internally, and newer Deno CLI versions generate lock file format v5 which the runtime cannot parse.

## Principles to Enforce

### 1. Test Structure — `Deno.test()` or BDD (`describe`/`it`)

- Both styles are officially supported; choose one and be consistent within a project
- `describe()` and `it()` are wrappers over `Deno.test()` and `t.step()` — not a separate test runner
- Hook order: `beforeAll` > `beforeEach` > test > `afterEach` > `afterAll`; after-hooks run even on failure
- Per-test `permissions` do NOT work inside nested `describe` blocks (known limitation)

### 2. Assertions — `@std/assert` or `@std/expect`

Two assertion styles are officially supported: `@std/assert` (Deno-native) and `@std/expect` (Jest-compatible).

**Assertion selection:**

| Situation | Use | NOT |
|-----------|-----|-----|
| Deep equality (objects, arrays) | `assertEquals` | `assertStrictEquals` |
| Reference/primitive equality (`===`) | `assertStrictEquals` | `assertEquals` |
| Value is not null/undefined | `assertExists` | `assert(val !== null)` |
| Synchronous throw | `assertThrows(fn, ErrorClass?, msg?)` | try/catch |
| Async rejection | `assertRejects(fn, ErrorClass?, msg?)` | `assertThrows` |
| Partial object match | `assertObjectMatch` | manual property checks |
| String contains substring | `assertStringIncludes` | `assert(s.includes(...))` |
| Numeric comparison | `assertGreater`, `assertLess`, etc. | `assert(a > b)` |
| Unconditional fail | `fail()` or `unreachable()` | `assert(false)` |

### 3. Integration Testing Pattern (Supabase Official)

Edge Function tests should be **integration tests** — real HTTP requests against locally-served functions.

**What to test:**
- Happy-path request/response (status code, body shape)
- Authentication enforcement (missing/invalid JWT returns 401)
- Input validation (malformed body returns 400)
- Error responses (correct status codes and error messages)
- CORS headers (OPTIONS preflight, allowed origins)
- Method routing (POST vs GET vs unsupported methods)

**What NOT to test here** (test at the database layer instead):
- RLS policies
- RPC business logic
- Trigger behavior

### 4. Sanitizers — Resource, Op, and Exit

Sanitizers are **enabled by default** on every `Deno.test()`. They catch resource leaks and unfinished async work.

| Sanitizer | Default | What it catches |
|-----------|---------|-----------------|
| `sanitizeResources` | `true` | Open files, connections not closed |
| `sanitizeOps` | `true` | Unawaited async operations |
| `sanitizeExit` | `true` | Calls to `Deno.exit()` |

- NEVER disable sanitizers globally — only per-test with a comment explaining why
- For integration tests with `fetch()`, sanitizers should pass without disabling
- If a third-party library holds connections open, you may need `sanitizeResources: false` on specific tests

### 5. Mocking — `@std/testing/mock`

- **Spies** record calls without changing behavior; **stubs** replace behavior
- ALWAYS restore spies/stubs — use `using` keyword (preferred) or `try/finally` with `.restore()`
- Do NOT over-mock in integration tests — use real `fetch()` against the local server
- Do NOT mock what you don't own — mock your code's dependencies, not third-party internals
- **FakeTime** (`@std/testing/time`) — use for time-dependent tests instead of wall-clock time

### 6. Environment Isolation

- Use `--env-file=path` to load test-specific environment variables
- Keep a dedicated `.env.local` in `supabase/functions/tests/`
- NEVER hardcode URLs, keys, or secrets in test files — use `Deno.env.get()`
- `--env-file` values take precedence over existing shell environment variables

### 7. Permissions — Principle of Least Privilege

- Grant only what tests need at the CLI level (`--allow-net`, `--allow-env`, `--allow-read`)
- Per-test `permissions` config can restrict further but CANNOT exceed CLI-granted permissions

### 8. Test File Naming and Organization

- Deno auto-discovers files matching: `{*_,*.,}test.{ts,tsx,mts,js,mjs,jsx}`
- Supabase's official example uses `function-name-test.ts` with a hyphen — hyphens are NOT auto-discovered, pass the directory explicitly
- Place tests in `supabase/functions/tests/` with a `.env.local` for environment variables

### 9. Test Independence and Determinism

- Tests within a file run sequentially; files can run in parallel (`--parallel`)
- Module-level state is shared across tests in the same file
- Use `beforeEach`/`afterEach` to reset state; database/server state persists unless cleaned up
- NEVER rely on test execution order, random data without seeding, or wall-clock time

## Common Anti-Patterns

| Anti-Pattern | Why it's wrong | Fix |
|---|---|---|
| Not awaiting `fetch()` or async ops | `sanitizeOps` will catch this; test may pass falsely | Always `await` every async operation |
| Disabling sanitizers globally | Hides real resource leaks | Disable only per-test with a comment |
| Using `assertThrows` for async code | Only catches synchronous exceptions | Use `assertRejects` for promises |
| Not restoring stubs/spies | Leaks mock state to other tests | Use `using` keyword or `try/finally` |
| Hardcoding URLs and keys | Breaks in different environments | Use `Deno.env.get()` + `--env-file` |
| Mocking `fetch` in integration tests | Defeats the purpose of integration testing | Use real HTTP calls to local server |
| Sharing mutable state without cleanup | Tests become order-dependent | Reset in `beforeEach`/`afterEach` |
| Using `assert(condition)` for everything | Provides no useful failure message | Use specific assertions (`assertEquals`, etc.) |

## Output Format (Review Mode)

When reviewing existing tests, group findings by severity:

```
## Critical
Issues that make tests unreliable, flaky, or misleading.

### [PRINCIPLE] Brief title
**File**: `path/to/file_test.ts` (lines X-Y)
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

- **Only verified claims**: every recommendation in this skill is backed by official Deno or Supabase documentation. See REFERENCE.md for source citations.
- **Integration over unit**: for Edge Functions, prefer integration tests (real HTTP against local server) over unit tests with mocked dependencies.
- **Test the contract, not the implementation**: test HTTP status codes, response bodies, and headers — not internal function calls.
- **Respect sanitizers**: treat sanitizer failures as real bugs, not annoyances to disable.
- **Least privilege**: grant only the permissions tests actually need.
