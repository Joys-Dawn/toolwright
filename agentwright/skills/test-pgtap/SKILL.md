---
name: test-pgtap
description: Use when writing, reviewing, or fixing pgTAP tests for Supabase SQL migrations, or when auditing database tests for best practices. Triggers on plan count mismatches, transaction isolation issues, RLS policy testing, privilege verification, or assertion selection problems.
---

# pgTAP Database Testing

Write and review pgTAP tests for Supabase SQL migrations. Every recommendation is sourced from official pgTAP documentation (pgtap.org) or Supabase documentation — see [REFERENCE.md](REFERENCE.md) for citations, full function reference tables, and detailed examples.

## Scope

Determine what to review or write based on user request:

- **Write mode**: write new tests for migrations the user specifies
- **Review mode**: audit existing test files for anti-patterns and best practice violations
- **Fix mode**: fix failing or flawed tests

Test files live in the project's database test directory (Supabase convention: `supabase/tests/database/*.test.sql`).

## Prerequisites

```bash
npx supabase start        # start local Supabase stack
npx supabase test db      # run all pgTAP tests
npx supabase db reset     # reset DB if needed (re-runs all migrations + seeds)
npx supabase db lint       # run plpgsql_check linter
```

**Required extension:** The `supabase_test_helpers` extension must be enabled for user management helpers (`tests.create_supabase_user`, `tests.authenticate_as`, etc.). Enable it in a migration with `CREATE EXTENSION IF NOT EXISTS supabase_test_helpers;`.

## Principles to Enforce

### 1. Transaction Isolation — `BEGIN`/`ROLLBACK`

Every test file MUST be wrapped in a `BEGIN;` ... `ROLLBACK;` transaction.

- ROLLBACK ensures all test-created data is cleaned up; tests cannot leak state
- Always `BEGIN;` as the first statement, `ROLLBACK;` as the last
- NEVER use `COMMIT;` in test files
- `finish()` must be called before `ROLLBACK` to output TAP diagnostics

### 2. Plan Counts — Always Use `SELECT plan(N)`

pgTAP official documentation states about `no_plan()`: **"Try to avoid using this as it weakens your test."**

- ALWAYS use `SELECT plan(N)` with an exact count
- NEVER use `no_plan()` — it hides missing/skipped assertions
- The plan count MUST match the actual number of assertion calls
- When adding/removing assertions, update the plan count AND the file header comment

### 3. Test File Organization

**Naming convention:** `NNNNN-description.test.sql` where NNNNN is a zero-padded number controlling execution order.

**File header template:**
```sql
-- NNNNN-description.test.sql
-- Tests for: <what migration/feature this tests>
--
-- Covers:
--   1. <first thing tested>
--   2. <second thing tested>
--
-- Assertion count: N
-- Dependency: <test files or seeds this depends on>
```

**Categorization:**
- `00NNN` — Schema tests (table/column/index/constraint existence) and trigger tests
- `01NNN` — RPC/function behavioral tests
- Files should test ONE migration or ONE logical unit

### 4. Assertion Function Selection

Use the most specific assertion for the situation:

| Situation | Use | NOT |
|-----------|-----|-----|
| Exact value equality | `is(have, want, desc)` | `ok(have = want, desc)` |
| Value inequality | `isnt(have, want, desc)` | `ok(have != want, desc)` |
| Boolean condition | `ok(condition, desc)` | `is(condition, true, desc)` |
| Row existence | `ok(EXISTS(SELECT ...), desc)` | Checking count |
| Exception expected | `throws_ok(sql, errcode, errmsg, desc)` | Manual BEGIN/EXCEPTION |
| No exception expected | `lives_ok(sql, desc)` | Running SQL without assertion |
| Row non-existence | `ok(NOT EXISTS(SELECT ...), desc)` | `is(count, 0, desc)` |
| Exact row comparison | `results_eq(sql, sql, desc)` | Manual row-by-row checks |
| Set equality (order-independent) | `set_eq(sql, sql, desc)` | `results_eq` when order doesn't matter |
| Empty result set | `is_empty(sql, desc)` | `ok(NOT EXISTS(...))` |

**`is()` uses `IS NOT DISTINCT FROM`** — this correctly handles NULL comparisons (unlike `=`).

### 5. Schema Tests — Existence and Structure

Test that migrations created expected schema objects: tables, columns (type, nullability, defaults), primary/foreign keys, check constraints, indexes, and RLS enabled status. Use `has_table`, `has_column`, `col_type_is`, `col_not_null`, `col_default_is`, `col_is_pk`, `fk_ok`, `has_check`, `has_index`, etc. See REFERENCE.md for the full function list.

### 6. Behavioral Tests — RPCs and Business Logic

Test PL/pgSQL function behavior by calling them and asserting outcomes:

- **Happy path**: call the function, assert return value with `is()`
- **Exception path**: use `throws_ok()` with SQL string wrapped in `$sql$...$sql$`
- **Side effects**: verify rows created/modified with `ok(EXISTS(...))`
- Use `format()` with `%L` for parameter interpolation in `throws_ok` SQL strings
- SQLSTATE `'P0001'` for custom `RAISE EXCEPTION`; third arg is exact error message match

### 7. RLS Policy Testing

- **Schema**: verify policies exist with `policies_are()`, roles with `policy_roles_are()`, commands with `policy_cmd_is()`
- **Behavioral**: set role context with `SET LOCAL ROLE` + `SET LOCAL "request.jwt.claims"`, then query and assert access enforcement
- Prefer `tests.authenticate_as()` helper over manual `SET LOCAL` when available
- Always `RESET ROLE` or rely on `ROLLBACK` to restore context

### 8. SECURITY DEFINER and Privilege Testing

- Verify security context with `is_definer()` / `isnt_definer()`
- Verify privilege grants/revokes with `function_privs_are()` — pass `ARRAY[]::text[]` for no privileges
- Parameter types use `ARRAY['uuid']::name[]` — use `ARRAY[]::name[]` for no-argument functions
- Test all relevant roles: `anon`, `authenticated`, `service_role`

### 9. Trigger Testing

- **Schema**: verify trigger exists with `has_trigger()`, trigger function with `has_function()`, security context with `is_definer()`
- **Behavioral**: insert data and verify side effects with `ok(EXISTS(...))`

### 10. Supabase Test Helpers

- Use `tests.create_supabase_user()` for user creation — fires auth triggers (do not raw INSERT into `auth.users`)
- Use `tests.get_supabase_uid()` to retrieve test user UUIDs
- Use `tests.authenticate_as()` / `tests.authenticate_as_service_role()` / `tests.clear_authentication()` for role context
- Use unique aliases per test file; prefix with the test file's theme (e.g., `auth_trigger_alice`)
- JSONB metadata must include `sub` and `preferred_username` for GitHub OAuth simulation

### 11. Test Description Conventions

Every assertion MUST have a descriptive message.

**Format:** `'<function_or_feature>: <what is being verified>'`

Good: `'my_rpc: returns correct value for edge case'`
Bad: no description, or vague like `'test 1'`

### 12. Determinism and Independence

- Tests MUST be deterministic — same result every run
- Use fixed values, not `random()`, `now()`, or `gen_random_uuid()` in assertions
- Each test file should be independent — don't rely on state from other test files
- Clean up is handled by `ROLLBACK` — no explicit DELETE needed

### 13. `SET LOCAL` vs `SET` — Scope to the Transaction

- Always use `SET LOCAL` when changing session variables inside tests (role, JWT claims)
- Both are reverted by `ROLLBACK`, but plain `SET` persists after `COMMIT` while `SET LOCAL` does not — use `SET LOCAL` to make scoping explicit and guard against accidental `COMMIT`

### 14. SAVEPOINT Caveat — Avoid Sub-transactions

- Do NOT use `SAVEPOINT`/`ROLLBACK TO` inside pgTAP test files
- Rolling back to a savepoint discards assertions emitted after it, causing plan count mismatches
- Use `throws_ok()` instead for error testing

## Common Anti-Patterns

| Anti-Pattern | Why it's wrong | Fix |
|---|---|---|
| `no_plan()` | Hides missing assertions | Use `plan(N)` with exact count |
| Missing `ROLLBACK` | Test data leaks to other files | Always end with `ROLLBACK;` |
| `ok(a = b, desc)` for equality | Fails silently on NULL | Use `is(a, b, desc)` |
| No description on assertions | Failures are undiagnosable | Always provide descriptive message |
| Testing private internals | Brittle, breaks on refactor | Test public RPC behavior |
| Hardcoded UUIDs | Collides with other tests | Use `tests.get_supabase_uid()` |
| `COMMIT` in test files | Permanently alters database | Use `ROLLBACK` |
| Plan count mismatch | Test suite reports wrong total | Keep count in sync with assertions |
| Missing `finish()` | No diagnostic output on failure | Always call before `ROLLBACK` |
| `SET` instead of `SET LOCAL` | Persists after `COMMIT`; less explicit scoping | Always use `SET LOCAL` inside tests |
| `SAVEPOINT`/`ROLLBACK TO` | Discards assertions, breaks plan count | Use `throws_ok()` for error testing |

## Output Format (Review Mode)

When reviewing existing tests, group findings by severity:

```
## Critical
Issues that make tests unreliable, flaky, or misleading.

### [PRINCIPLE] Brief title
**File**: `path/to/file.test.sql` (lines X-Y)
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

- **Only verified claims**: every recommendation is backed by pgtap.org or Supabase official documentation.
- **Schema AND behavior**: test both that objects exist (schema) and that they work correctly (behavior).
- **Transaction discipline**: every file wrapped in BEGIN/ROLLBACK, no exceptions.
- **Exact plan counts**: never use `no_plan()`.
- **Descriptive messages**: every assertion needs a clear description.
- **Test the contract**: test what RPCs accept, return, and side-effect — not internal implementation.
