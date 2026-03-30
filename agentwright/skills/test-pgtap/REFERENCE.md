# pgTAP Database Testing Reference

Detailed definitions, official sources, and verified citations for each principle in this skill.

## Table of Contents

1. [Test Structure](#1-test-structure)
2. [Plan Counts](#2-plan-counts)
3. [Core Assertions](#3-core-assertions)
4. [Schema Testing Functions](#4-schema-testing-functions)
5. [Column Testing Functions](#5-column-testing-functions)
6. [Function Testing Functions](#6-function-testing-functions)
7. [RLS Policy Functions](#7-rls-policy-functions)
8. [Privilege Testing Functions](#8-privilege-testing-functions)
9. [Exception Testing](#9-exception-testing)
10. [Result Set Testing](#10-result-set-testing)
11. [Supabase Helpers](#11-supabase-helpers)
12. [Diagnostics and Utilities](#12-diagnostics-and-utilities)

---

## 1. Test Structure

**Source:** [pgtap.org/documentation.html](https://pgtap.org/documentation.html)

The standard test structure shown in pgTAP documentation:

```sql
BEGIN;
SELECT plan(N);
-- tests
SELECT * FROM finish();
ROLLBACK;
```

"This ensures all changes (including function loading) are rolled back after tests complete."

**Source (Supabase):** [supabase.com/docs/guides/database/extensions/pgtap](https://supabase.com/docs/guides/database/extensions/pgtap)

Supabase's examples use the same `begin;`/`rollback;` pattern.

**Running tests:** `supabase test db`

**Source (Supabase):** [supabase.com/docs/guides/database/testing](https://supabase.com/docs/guides/database/testing)

Test files go in `./supabase/tests/database/` with `.sql` extension. "All `sql` files use pgTAP as the test runner."

### File Naming Convention

**Convention:** `NNNNN-description.test.sql` where NNNNN is a zero-padded number controlling execution order.

**Categorization ranges:**
- `00NNN` — Schema tests (table/column/index/constraint existence) and trigger schema + behavioral tests
- `01NNN` — RPC/function behavioral tests

Files should test ONE migration or ONE logical unit.

### Test Description Conventions

Every assertion MUST have a descriptive message. Format: `'<function_or_feature>: <what is being verified>'`

```sql
-- Good: tells you what's being tested and what function/feature
SELECT is(result, expected, 'my_rpc: returns correct value for edge case');

-- Bad: no description
SELECT is(result, expected);

-- Bad: vague
SELECT is(result, expected, 'test 1');
```

---

## 2. Plan Counts

**Source:** [pgtap.org/documentation.html](https://pgtap.org/documentation.html)

`SELECT plan(N);` — declares the expected number of tests.

`SELECT * FROM no_plan();` — for cases where test count is unknown. **"Try to avoid using this as it weakens your test."**

`SELECT * FROM finish();` — outputs TAP summary, reports failures. Optional parameter: `finish(true)` throws exception if any test failed.

---

## 3. Core Assertions

**Source:** [pgtap.org/documentation.html](https://pgtap.org/documentation.html)

### Basic

| Function | Description |
|---|---|
| `ok(boolean, description)` | Passes if boolean is true |
| `is(have, want, description)` | Equality using `IS NOT DISTINCT FROM` (NULL-safe) |
| `isnt(have, want, description)` | Inequality using `IS DISTINCT FROM` |
| `pass(description)` | Unconditional pass |
| `fail(description)` | Unconditional fail |
| `isa_ok(value, regtype, name)` | Type checking |

### Pattern Matching

| Function | Description |
|---|---|
| `matches(have, regex, description)` | Regex match |
| `imatches(have, regex, description)` | Case-insensitive regex match |
| `doesnt_match(have, regex, description)` | Regex non-match |
| `alike(have, like_pattern, description)` | SQL LIKE pattern |
| `unalike(have, like_pattern, description)` | LIKE non-match |
| `cmp_ok(have, operator, want, description)` | Arbitrary operator comparison |

---

## 4. Schema Testing Functions

**Source:** [pgtap.org/documentation.html](https://pgtap.org/documentation.html)

### Existence

| Function | Tests for |
|---|---|
| `has_table(schema, table, desc)` | Table exists |
| `hasnt_table(schema, table, desc)` | Table doesn't exist |
| `has_view(schema, view, desc)` | View exists |
| `has_materialized_view(schema, view, desc)` | Materialized view exists |
| `has_sequence(schema, sequence, desc)` | Sequence exists |
| `has_index(schema, table, index, desc)` | Index exists |
| `has_trigger(schema, table, trigger, desc)` | Trigger exists |
| `has_function(schema, function, desc)` | Function exists |
| `has_extension(name, desc)` | Extension enabled |
| `has_schema(name, desc)` | Schema exists |
| `has_type(schema, type, desc)` | Type exists |
| `has_enum(schema, enum, desc)` | Enum exists |
| `has_composite(schema, composite, desc)` | Composite type exists |
| `has_domain(schema, domain, desc)` | Domain exists |
| `has_role(name, desc)` | Role exists |

### Collection assertions

| Function | Tests for |
|---|---|
| `tables_are(schema, tables_array, desc)` | Exact set of tables |
| `views_are(schema, views_array, desc)` | Exact set of views |
| `columns_are(schema, table, columns_array, desc)` | Exact set of columns |
| `indexes_are(schema, table, indexes_array, desc)` | Exact set of indexes |
| `triggers_are(schema, table, triggers_array, desc)` | Exact set of triggers |
| `functions_are(schema, functions_array, desc)` | Exact set of functions |
| `schemas_are(schemas_array, desc)` | Exact set of schemas |
| `extensions_are(schema, extensions_array, desc)` | Exact set of extensions |
| `roles_are(roles_array, desc)` | Exact set of roles |
| `enum_has_labels(schema, enum, labels_array, desc)` | Enum has expected labels |

---

## 5. Column Testing Functions

**Source:** [pgtap.org/documentation.html](https://pgtap.org/documentation.html)

| Function | Tests for |
|---|---|
| `has_column(schema, table, column, desc)` | Column exists |
| `hasnt_column(schema, table, column, desc)` | Column doesn't exist |
| `col_type_is(schema, table, column, type, desc)` | Column has expected type |
| `col_not_null(schema, table, column, desc)` | Column is NOT NULL |
| `col_is_null(schema, table, column, desc)` | Column allows NULL |
| `col_has_default(schema, table, column, desc)` | Column has a default |
| `col_hasnt_default(schema, table, column, desc)` | Column has no default |
| `col_default_is(schema, table, column, default, desc)` | Default value matches |
| `col_is_pk(schema, table, column, desc)` | Column is primary key |
| `col_isnt_pk(schema, table, column, desc)` | Column is not primary key |
| `col_is_fk(schema, table, column, desc)` | Column is foreign key |
| `col_isnt_fk(schema, table, column, desc)` | Column is not foreign key |
| `col_is_unique(schema, table, column, desc)` | Column has unique constraint |
| `has_pk(schema, table, desc)` | Table has a primary key |
| `has_fk(schema, table, desc)` | Table has a foreign key |
| `fk_ok(schema, table, cols, ref_schema, ref_table, ref_cols, desc)` | Foreign key references correct table |
| `has_check(schema, table, check_name, desc)` | Check constraint exists |
| `has_unique(schema, table, columns, desc)` | Unique constraint on columns |
| `is_partitioned(schema, table, desc)` | Table is partitioned |
| `is_partition_of(schema, table, parent, desc)` | Table is partition of parent |

---

## 6. Function Testing Functions

**Source:** [pgtap.org/documentation.html](https://pgtap.org/documentation.html)

| Function | Tests for |
|---|---|
| `has_function(schema, function, args, desc)` | Function exists with given args |
| `function_lang_is(schema, function, args, language, desc)` | Function language (plpgsql, sql, etc.) |
| `function_returns(schema, function, args, return_type, desc)` | Return type |
| `is_definer(schema, function, args, desc)` | SECURITY DEFINER |
| `isnt_definer(schema, function, args, desc)` | NOT SECURITY DEFINER (INVOKER) |
| `is_strict(schema, function, args, desc)` | STRICT (RETURNS NULL ON NULL INPUT) |
| `isnt_strict(schema, function, args, desc)` | NOT STRICT |
| `volatility_is(schema, function, args, volatility, desc)` | IMMUTABLE, STABLE, or VOLATILE |
| `is_aggregate(schema, function, args, desc)` | Is an aggregate function |
| `is_procedure(schema, function, args, desc)` | Is a procedure |
| `is_normal_function(schema, function, args, desc)` | Is a normal function |
| `trigger_is(schema, table, trigger, function, desc)` | Trigger calls expected function |

### Trigger Testing

Beyond schema assertions (`has_trigger`, `trigger_is`), test trigger behavior by inserting data and verifying side effects:

```sql
-- Trigger exists on table
SELECT has_trigger('public', 'messages', 'on_message_insert',
  'on_message_insert trigger exists on messages');

-- Trigger function exists and is SECURITY DEFINER
SELECT has_function('public', 'broadcast_new_message', 'trigger function exists');
SELECT is_definer('public', 'broadcast_new_message', ARRAY[]::name[],
  'broadcast_new_message is SECURITY DEFINER');

-- Trigger behavior (insert data, verify side effects)
INSERT INTO public.messages (...) VALUES (...);
SELECT ok(
  EXISTS (SELECT 1 FROM public.expected_side_effect WHERE ...),
  'trigger creates expected side effect'
);
```

### Argument format

For `args`, use `ARRAY['uuid', 'text']::name[]` or `ARRAY[]::name[]` for no arguments:

```sql
SELECT is_definer('public', 'my_function', ARRAY['uuid', 'integer']::name[], 'is SECURITY DEFINER');
SELECT is_definer('public', 'my_trigger_fn', ARRAY[]::name[], 'trigger fn is SECURITY DEFINER');
```

---

## 7. RLS Policy Functions

**Source:** [pgtap.org/documentation.html](https://pgtap.org/documentation.html), [supabase.com/docs/guides/database/extensions/pgtap](https://supabase.com/docs/guides/database/extensions/pgtap)

| Function | Tests for |
|---|---|
| `policies_are(schema, table, policies_array, desc)` | Exact set of policies on table |
| `policy_roles_are(schema, table, policy, roles_array, desc)` | Policy applies to these roles |
| `policy_cmd_is(schema, table, policy, command, desc)` | Policy applies to SELECT/INSERT/UPDATE/DELETE/ALL |

### Example from Supabase docs

```sql
SELECT policies_are(
  'public', 'profiles',
  ARRAY['Profiles are public', 'Profiles can only be updated by the owner']
);
```

### Behavioral RLS Testing

To test that RLS policies actually enforce access, set the role context and query as that user:

```sql
-- Set authenticated user context
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claims" = '{"sub": "user-uuid-here"}';

-- Now queries run as that user, RLS applies
SELECT is_empty(
  $$SELECT * FROM public.profiles WHERE id != 'user-uuid-here'$$,
  'authenticated user cannot see other profiles'
);

-- Reset role
RESET ROLE;
```

Alternatively, use the Supabase test helper `tests.authenticate_as()` (see section 11) which handles role and JWT claims together.

---

## 8. Privilege Testing Functions

**Source:** [pgtap.org/documentation.html](https://pgtap.org/documentation.html)

| Function | Tests for |
|---|---|
| `table_privs_are(schema, table, role, privs, desc)` | Table privileges (SELECT, INSERT, UPDATE, DELETE, etc.) |
| `schema_privs_are(schema, role, privs, desc)` | Schema privileges (CREATE, USAGE) |
| `function_privs_are(schema, function, args, role, privs, desc)` | Function privileges (EXECUTE) |
| `sequence_privs_are(schema, sequence, role, privs, desc)` | Sequence privileges |
| `column_privs_are(schema, table, column, role, privs, desc)` | Column-level privileges |
| `database_privs_are(database, role, privs, desc)` | Database privileges |

### Testing REVOKE

To verify a function has NO execute privilege for a role:

```sql
SELECT function_privs_are('public', 'my_function', ARRAY['uuid']::name[],
  'authenticated', ARRAY[]::text[],  -- empty array = no privileges
  'authenticated: no execute on my_function');
```

### Behavioral Testing of Functions (RPCs)

Test PL/pgSQL function behavior by calling them and asserting outcomes:

```sql
-- Happy path
SELECT is(
  (SELECT public.my_rpc(param1, param2)),
  expected_value,
  'my_rpc: returns expected value'
);

-- Exception path
SELECT throws_ok(
  format($sql$SELECT public.my_rpc(%L, %L)$sql$, bad_param1, bad_param2),
  'P0001',            -- SQLSTATE for RAISE EXCEPTION
  'Expected error message',
  'my_rpc: rejects bad input'
);

-- Side effects
SELECT ok(
  EXISTS (SELECT 1 FROM public.some_table WHERE condition),
  'my_rpc: creates expected row'
);
```

---

## 9. Exception Testing

**Source:** [pgtap.org/documentation.html](https://pgtap.org/documentation.html)

| Function | Tests for |
|---|---|
| `throws_ok(sql, errcode, errmsg, desc)` | SQL raises expected exception |
| `throws_like(sql, like_pattern, desc)` | Exception message matches LIKE pattern |
| `throws_matching(sql, regex, desc)` | Exception message matches regex |
| `lives_ok(sql, desc)` | SQL does NOT raise an exception |
| `performs_ok(sql, milliseconds, desc)` | SQL completes within time limit |

### `throws_ok` signatures

```sql
-- Full form: SQLSTATE + message
SELECT throws_ok(
  $$SELECT 1/0$$,
  '22012',          -- SQLSTATE for division by zero
  'division by zero',
  'division by zero throws correct error'
);

-- Message only
SELECT throws_ok(
  $$SELECT 1/0$$,
  'division by zero'
);

-- SQLSTATE only
SELECT throws_ok(
  $$SELECT 1/0$$,
  '22012'
);
```

### Using `format()` with `%L` for parameter interpolation

When passing dynamic values into `throws_ok` or `lives_ok` SQL strings, use `format()` with `%L` (literal-quoting placeholder) to safely interpolate values. This prevents SQL injection in test code:

```sql
SELECT throws_ok(
  format($sql$SELECT public.my_rpc(%L, %L)$sql$, bad_param1, bad_param2),
  'P0001',            -- SQLSTATE for RAISE EXCEPTION
  'Expected error message',
  'my_rpc: rejects bad input'
);
```

### Common SQLSTATE codes

- `P0001` — `RAISE EXCEPTION` (custom)
- `23505` — unique_violation
- `23503` — foreign_key_violation
- `23514` — check_violation
- `22012` — division_by_zero
- `42501` — insufficient_privilege

---

## 10. Result Set Testing

**Source:** [pgtap.org/documentation.html](https://pgtap.org/documentation.html)

| Function | Tests for |
|---|---|
| `results_eq(sql, sql, desc)` | Exact row-by-row match (order matters) |
| `results_ne(sql, sql, desc)` | Results differ |
| `set_eq(sql, sql, desc)` | Same rows regardless of order/duplicates |
| `set_ne(sql, sql, desc)` | Different sets |
| `set_has(sql, sql, desc)` | First result is superset of second |
| `set_hasnt(sql, sql, desc)` | First result has none of second's rows |
| `bag_eq(sql, sql, desc)` | Same multiset (duplicates matter, order doesn't) |
| `bag_ne(sql, sql, desc)` | Different multisets |
| `is_empty(sql, desc)` | Query returns no rows |
| `isnt_empty(sql, desc)` | Query returns at least one row |
| `row_eq(sql, record, desc)` | Single row matches record |

---

## 11. Supabase Helpers

**Source:** [supabase.com/docs/guides/database/testing](https://supabase.com/docs/guides/database/testing), [supabase.com/docs/guides/local-development/testing/pgtap-extended](https://supabase.com/docs/guides/local-development/testing/pgtap-extended)

Supabase provides a `tests` schema with helper functions for managing test users and context:

### User Management

| Function | Purpose |
|---|---|
| `tests.create_supabase_user(identifier, email, phone?, metadata?)` | Creates `auth.users` record (fires auth triggers) |
| `tests.get_supabase_uid(identifier)` | Returns UUID of previously created test user |

```sql
SELECT tests.create_supabase_user(
  'my_test_user',
  'test@example.com',
  NULL,
  '{"sub": "12345", "preferred_username": "testuser", "avatar_url": "https://example.com/avatar.png"}'::jsonb
);

SELECT tests.get_supabase_uid('my_test_user');
-- Returns: uuid
```

### Authentication Context

| Function | Purpose |
|---|---|
| `tests.authenticate_as(identifier)` | Sets role to `authenticated` + JWT claims for user |
| `tests.authenticate_as_service_role()` | Sets role to `service_role`, clears JWT claims |
| `tests.clear_authentication()` | Sets role to `anon`, clears JWT claims |

```sql
-- Test as authenticated user
SELECT tests.authenticate_as('my_test_user');
-- Now queries run with RLS applied for this user

-- Test as service_role (bypasses RLS)
SELECT tests.authenticate_as_service_role();

-- Test as anonymous
SELECT tests.clear_authentication();
```

### Usage Rules

- Use unique aliases per test file to avoid collisions
- Prefix aliases with the test file's theme (e.g., `auth_trigger_alice`)
- The JSONB metadata passed to `create_supabase_user` must include `sub` and `preferred_username` for GitHub OAuth simulation
- Use `tests.create_supabase_user()` for user setup, not raw `INSERT` into `auth.users` — this ensures auth triggers fire

### RLS Verification

| Function | Purpose |
|---|---|
| `tests.rls_enabled(schema)` | Asserts ALL tables in schema have RLS enabled |
| `tests.rls_enabled(schema, table)` | Asserts specific table has RLS enabled |

```sql
SELECT tests.rls_enabled('public');
```

### Time Control

| Function | Purpose |
|---|---|
| `tests.freeze_time(timestamp)` | Freeze `now()` for deterministic time tests |
| `tests.unfreeze_time()` | Restore normal time behavior |

---

## 12. Diagnostics and Utilities

**Source:** [pgtap.org/documentation.html](https://pgtap.org/documentation.html)

| Function | Purpose |
|---|---|
| `diag(message)` | Output diagnostic message (prefixed with `#`) |
| `skip(reason, count)` | Skip N tests with reason |
| `todo(reason, count)` | Mark N tests as to-do |
| `todo_start(why)` / `todo_end()` | Block-style todo marking |

### Ownership testing

| Function | Tests for |
|---|---|
| `table_owner_is(schema, table, owner, desc)` | Table owner |
| `view_owner_is(schema, view, owner, desc)` | View owner |
| `function_owner_is(schema, function, args, owner, desc)` | Function owner |
| `schema_owner_is(schema, owner, desc)` | Schema owner |
| `sequence_owner_is(schema, sequence, owner, desc)` | Sequence owner |

---

## 12b. Determinism and Independence

Tests MUST be deterministic — same result every run:

- Use fixed values, not `random()`, `now()`, or `gen_random_uuid()` in assertions
- Each test file should be independent — don't rely on state from other test files
- Use `tests.create_supabase_user()` for user setup, not raw INSERT (ensures triggers fire)
- Clean up is handled by `ROLLBACK` — no explicit DELETE needed
- Use `tests.freeze_time()` when testing time-dependent logic

---

## 13. `SET LOCAL` vs `SET`

**Source:** [PostgreSQL documentation — SET](https://www.postgresql.org/docs/current/sql-set.html)

`SET LOCAL` restricts the setting to the current transaction. When the transaction ends (via `COMMIT` or `ROLLBACK`), the setting reverts to its session-level value.

Plain `SET` (without `LOCAL`) changes the session-level value. Both are reverted by `ROLLBACK`, but the key difference: plain `SET` **persists after `COMMIT`**, while `SET LOCAL` does not. Since pgTAP tests use `ROLLBACK`, both are technically reverted — but `SET LOCAL` is still preferred because it makes the intent explicit and protects against accidental `COMMIT`.

```sql
-- Inside BEGIN/ROLLBACK:
SET LOCAL ROLE authenticated;  -- reverted by both COMMIT and ROLLBACK ✓
SET ROLE authenticated;        -- reverted by ROLLBACK, but persists after COMMIT ✗
```

---

## 14. SAVEPOINT Caveat

**Source:** PostgreSQL transaction semantics ([postgresql.org/docs/current/sql-savepoint.html](https://www.postgresql.org/docs/current/sql-savepoint.html))

**Note:** pgTAP documentation does not explicitly address SAVEPOINTs. This guidance is derived from PostgreSQL transaction semantics: `ROLLBACK TO SAVEPOINT` undoes all changes (including sequence increments and table writes) made after the savepoint. Since pgTAP tracks test state within the transaction, rolling back to a savepoint can corrupt internal counters and cause plan count mismatches.

```sql
-- BAD: assertions between SAVEPOINT and ROLLBACK TO are lost
SAVEPOINT sp1;
SELECT ok(true, 'this assertion gets rolled back');  -- counted by plan but discarded
ROLLBACK TO sp1;
-- Plan now expects more assertions than will actually complete

-- GOOD: use throws_ok() instead
SELECT throws_ok(
  $$SELECT some_function_that_should_fail()$$,
  'P0001', 'expected error message',
  'function rejects bad input'
);
```
