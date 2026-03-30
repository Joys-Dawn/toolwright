# PL/pgSQL Migration Audit — Reference

Detailed failure modes, code examples, and source citations for each checklist section in [SKILL.md](SKILL.md).

---

## 1. NULL Safety

### Three-Valued Logic

SQL comparisons with NULL yield NULL (not TRUE or FALSE). NULL is falsy in WHERE/IF contexts.

> "Ordinary comparison operators yield null (signifying 'unknown'), not true or false, when either input is null. For example, `7 = NULL` yields null, as does `7 <> NULL`."
> — [PostgreSQL: Comparison Functions and Operators](https://www.postgresql.org/docs/current/functions-comparison.html)

```sql
NULL = 1       -- NULL (not FALSE)
NULL != 1      -- NULL (not TRUE)
NULL = NULL    -- NULL (not TRUE)
NULL != NULL   -- NULL (not FALSE)
```

### The != NULL Trap

The most dangerous NULL bug in PL/pgSQL. When an IF block uses `!=` on a value that can be NULL, the entire block is silently skipped:

```sql
-- BUG: If v_role is NULL, this block is SKIPPED — ownership check bypassed
IF v_role != 'admin' THEN
  RAISE EXCEPTION 'Forbidden';
END IF;

-- FIX: IS DISTINCT FROM treats NULL as a comparable value
IF v_role IS DISTINCT FROM 'admin' THEN
  RAISE EXCEPTION 'Forbidden';
END IF;
```

### IS DISTINCT FROM / IS NOT DISTINCT FROM

> "Not equal, treating null as a comparable value."
> "Equal, treating null as a comparable value."
> "Thus, these predicates effectively act as though null were a normal data value, rather than 'unknown'."
> — [PostgreSQL: Comparison Functions and Operators](https://www.postgresql.org/docs/current/functions-comparison.html)

| a    | b    | `a = b` | `a IS NOT DISTINCT FROM b` |
|------|------|---------|----------------------------|
| 1    | 1    | TRUE    | TRUE                       |
| 1    | NULL | NULL    | FALSE                      |
| NULL | NULL | NULL    | **TRUE**                   |

### The NOT IN Trap

> "If there are no equal right-hand values and at least one right-hand row yields null, the result of the `NOT IN` construct will be null, not true."
> — [PostgreSQL: Subquery Expressions](https://www.postgresql.org/docs/current/functions-subquery.html)

`NOT IN (1, 2, NULL)` expands to `val != 1 AND val != 2 AND val != NULL`. Since `val != NULL` is NULL, the AND chain never evaluates to TRUE. The query returns **zero rows**.

```sql
-- BUG: Returns ZERO rows if subquery has even one NULL
SELECT id FROM orders WHERE id NOT IN (SELECT order_id FROM details);

-- FIX: NOT EXISTS is NULL-safe
SELECT id FROM orders o
WHERE NOT EXISTS (SELECT 1 FROM details d WHERE d.order_id = o.id);
```

### Uninitialized Variables

PL/pgSQL variables default to NULL, not zero or empty string:

```sql
DECLARE
  counter INTEGER;  -- NULL, not 0
BEGIN
  counter := counter + 1;  -- NULL + 1 = NULL
```

### String Concatenation and Arithmetic

```sql
'Hello' || NULL     -- NULL (not 'Hello')
5 + NULL            -- NULL
NULL / 0            -- NULL (not division_by_zero!)
```

Use `COALESCE` or `concat()` (which treats NULL as empty string).

### CASE WHEN NULL

```sql
-- BUG: Simple CASE uses = internally; NULL = NULL is NULL, never matches
CASE v_status WHEN NULL THEN 'unknown' END;

-- FIX: Searched CASE with IS NULL
CASE WHEN v_status IS NULL THEN 'unknown' END;
```

### When to Add NULL Parameter Guards

For internal RPCs where the caller validates inputs, **do not** add blanket NULL guards. PostgreSQL's own mechanism for this is the `STRICT` keyword:

> "`RETURNS NULL ON NULL INPUT` or `STRICT` indicates that the function always returns null whenever any of its arguments are null. If this parameter is specified, the function is not executed when there are null arguments; instead a null result is assumed automatically."
> — [PostgreSQL: CREATE FUNCTION](https://www.postgresql.org/docs/current/sql-createfunction.html)

**Only** add a guard when NULL causes a *silent logic bug*:
1. Trace what happens if the parameter is NULL
2. If the function raises an error (ugly or not) → no guard needed
3. If it silently produces wrong results or skips a check → add a guard with a comment explaining the bug

---

## 2. TOCTOU / Race Conditions

### READ COMMITTED Re-evaluation

Under READ COMMITTED (PostgreSQL default), UPDATE/DELETE/SELECT FOR UPDATE **wait** for concurrent transactions, then **re-evaluate the WHERE clause** against the updated row:

> "Such a target row might have already been updated (or deleted or locked) by another concurrent transaction by the time it is found. In this case, the would-be updater will wait for the first updating transaction to commit or roll back."
>
> "The search condition of the command (the `WHERE` clause) is re-evaluated to see if the updated version of the row still matches the search condition. If so, the second updater proceeds with its operation using the updated version of the row."
> — [PostgreSQL: Transaction Isolation](https://www.postgresql.org/docs/current/transaction-iso.html)

This is why atomic single-statement UPDATE is the gold standard — the check and write are one operation, and PostgreSQL handles concurrency automatically.

### Anti-Pattern: SELECT then INSERT

```sql
-- BUG: Two concurrent calls both find no row, both insert
IF NOT EXISTS (SELECT 1 FROM tags WHERE name = p_name) THEN
  INSERT INTO tags (name) VALUES (p_name);
END IF;

-- FIX: INSERT ON CONFLICT
INSERT INTO tags (name) VALUES (p_name) ON CONFLICT (name) DO NOTHING;
```

### Anti-Pattern: EXISTS check then UPDATE

```sql
-- BUG: Row could be deleted/modified between check and update
IF EXISTS (SELECT 1 FROM orders WHERE id = p_id AND status = 'pending') THEN
  UPDATE orders SET status = 'processing' WHERE id = p_id;
END IF;

-- FIX: Atomic — put check in WHERE clause
UPDATE orders SET status = 'processing' WHERE id = p_id AND status = 'pending';
IF NOT FOUND THEN RAISE EXCEPTION '...'; END IF;
```

### Anti-Pattern: Read-Modify-Write

```sql
-- BUG: Two concurrent calls read same balance, both write back
SELECT balance INTO v_bal FROM accounts WHERE id = p_id;
v_bal := v_bal - p_amount;
UPDATE accounts SET balance = v_bal WHERE id = p_id;

-- FIX: Atomic relative UPDATE with WHERE guard
UPDATE accounts SET balance = balance - p_amount
WHERE id = p_id AND balance >= p_amount
RETURNING balance INTO v_bal;
```

### Row Locking

> "FOR UPDATE causes the rows retrieved by the SELECT statement to be locked as though for update. This prevents them from being locked, modified or deleted by other transactions until the current transaction ends."
> — [PostgreSQL: Explicit Locking](https://www.postgresql.org/docs/current/explicit-locking.html)

**FOR UPDATE vs FOR NO KEY UPDATE:**

> "`FOR NO KEY UPDATE` behaves similarly to `FOR UPDATE`, except that the lock acquired is weaker: this lock will not block `SELECT FOR KEY SHARE` commands that attempt to acquire a lock on the same rows."
> — [PostgreSQL: Explicit Locking](https://www.postgresql.org/docs/current/explicit-locking.html)

Prefer `FOR NO KEY UPDATE` when not changing PK / FK-referenced columns — it avoids blocking child table FK inserts.

**Which row to lock:** Lock the row whose state determines the decision.

### Deadlocks

> "The best defense against deadlocks is generally to avoid them by being certain that all applications using a database acquire locks on multiple objects in a consistent order."
> — [PostgreSQL: Explicit Locking](https://www.postgresql.org/docs/current/explicit-locking.html)

```sql
-- Consistent order: always lock by ascending ID
SELECT * FROM accounts WHERE user_id IN (p_from, p_to) ORDER BY user_id FOR UPDATE;
```

### Advisory Locks

Use when row locks don't fit (e.g., locking a logical concept, not a specific row):

> "PostgreSQL provides a means for creating locks that have application-defined meanings. These are called advisory locks, because the system does not enforce their use — it is up to the application to use them correctly."
> — [PostgreSQL: Explicit Locking](https://www.postgresql.org/docs/current/explicit-locking.html)

**Transaction-level** (`pg_advisory_xact_lock`):
> "Transaction-level lock requests... are automatically released at the end of the transaction, and there is no explicit unlock operation."

**Session-level** (`pg_advisory_lock`):
> "Once acquired at session level, an advisory lock is held until explicitly released or the session ends... a lock acquired during a transaction that is later rolled back will still be held following the rollback."

Transaction-level is almost always what you want. Session-level survives rollback, which is surprising and dangerous.

> "While a flag stored in a table could be used for the same purpose, advisory locks are faster, avoid table bloat, and are automatically cleaned up by the server at the end of the session."

**Dangerous pattern with LIMIT:**
> "In certain cases... care must be taken to control the locks acquired because of the order in which SQL expressions are evaluated."

```sql
-- DANGEROUS: LIMIT may not be applied before the lock function executes
SELECT pg_advisory_lock(id) FROM foo WHERE id > 12345 LIMIT 100;

-- SAFE: subquery forces LIMIT first
SELECT pg_advisory_lock(q.id) FROM (
  SELECT id FROM foo WHERE id > 12345 LIMIT 100
) q;
```

---

## 3. Unique Constraints & ON CONFLICT

### ON CONFLICT Targets a Single Constraint

`ON CONFLICT (col)` targets one specific unique index. If the table has multiple unique constraints, a conflict on a DIFFERENT constraint still raises `unique_violation`.

### RETURNING Does Not Fire on DO NOTHING

> "Only rows that were successfully inserted or updated will be returned."
> — [PostgreSQL: INSERT](https://www.postgresql.org/docs/current/sql-insert.html)

If you need the existing row's ID after a DO NOTHING conflict:

```sql
WITH ins AS (
  INSERT INTO tags (name) VALUES (p_name)
  ON CONFLICT (name) DO NOTHING
  RETURNING id
)
SELECT id FROM ins
UNION ALL
SELECT id FROM tags WHERE name = p_name
LIMIT 1;
```

### Index Inference vs Named Constraint

> "It is often preferable to use unique index inference rather than naming a constraint directly using `ON CONFLICT ON CONSTRAINT`. Inference will continue to work correctly when the underlying index is replaced by another more or less equivalent index."
> — [PostgreSQL: INSERT](https://www.postgresql.org/docs/current/sql-insert.html)

### EXCEPTION Block for unique_violation

When ON CONFLICT can't cover all scenarios (multiple unique constraints):

```sql
BEGIN
  INSERT INTO owned_items (user_id, item_id) VALUES (p_uid, p_id);
EXCEPTION WHEN unique_violation THEN
  RAISE EXCEPTION 'Already owned' USING DETAIL = 'ALREADY_EXISTS';
END;
```

**Performance cost** — see §4.

---

## 4. Error Handling

### SELECT INTO and FOUND

`SELECT INTO` (without STRICT) sets the target to NULL on no rows — no error raised. Must check `FOUND`:

> "If `STRICT` is not specified in the `INTO` clause, then target will be set to the first row returned by the command, or to nulls if the command returned no rows."
> — [PostgreSQL: Basic Statements](https://www.postgresql.org/docs/current/plpgsql-statements.html)

**Critical nuance:** FOUND tracks row existence, not value existence:

> "A `SELECT INTO` sets `FOUND` true if a row is assigned, false if no row is returned."
> — [PostgreSQL: Basic Statements](https://www.postgresql.org/docs/current/plpgsql-statements.html)

FOUND = TRUE even if the returned value is NULL.

### SELECT INTO STRICT

When exactly one row is expected, `STRICT` eliminates manual FOUND checking:

> "If the `STRICT` option is specified, the command must return exactly one row or a run-time error will be reported, either `NO_DATA_FOUND` (no rows) or `TOO_MANY_ROWS` (more than one row)."
> — [PostgreSQL: Basic Statements](https://www.postgresql.org/docs/current/plpgsql-statements.html)

```sql
-- Without STRICT: must check FOUND manually
SELECT col INTO v_val FROM t WHERE id = p_id;
IF NOT FOUND THEN RAISE EXCEPTION '...' USING DETAIL = 'NOT_FOUND'; END IF;

-- With STRICT: automatic error on 0 or >1 rows
BEGIN
  SELECT col INTO STRICT v_val FROM t WHERE id = p_id;
EXCEPTION
  WHEN NO_DATA_FOUND THEN
    RAISE EXCEPTION '...' USING DETAIL = 'NOT_FOUND';
END;
```

Trade-off: STRICT requires an EXCEPTION block (subtransaction cost) if you want a custom error message. For simple "must exist" lookups where you control the error message, manual FOUND is cheaper. STRICT is most useful when you also need to guard against >1 row.

### EXCEPTION Block Subtransaction Cost

> "A block containing an `EXCEPTION` clause is significantly more expensive to enter and exit than a block without one. Therefore, don't use `EXCEPTION` without need."
> — [PostgreSQL: Control Structures](https://www.postgresql.org/docs/current/plpgsql-control-structures.html)

The cost comes from implicit subtransactions:

> "When an error is caught by an `EXCEPTION` clause, the local variables of the PL/pgSQL function remain as they were when the error occurred, but all changes to persistent database state within the block are rolled back."
> — [PostgreSQL: Control Structures](https://www.postgresql.org/docs/current/plpgsql-control-structures.html)

**The 64-subtransaction overflow:** Each backend caches up to 64 subtransaction XIDs (`PGPROC_MAX_CACHED_SUBXIDS`). Beyond 64, tracking overflows to the `pg_subtrans` SLRU on disk. Under concurrency, multiple sessions accessing the 32-page SLRU cache causes lock contention and disk I/O. GitLab documented TPS drops from 360,000 to 50,000 from this issue and spent a month eliminating all subtransactions.

Sources:
- [PostgresAI: Subtransactions considered harmful](https://postgres.ai/blog/20210831-postgresql-subtransactions-considered-harmful)
- [GitLab: Why we spent the last month eliminating PostgreSQL subtransactions](https://about.gitlab.com/blog/why-we-spent-the-last-month-eliminating-postgresql-subtransactions/)

**Rule:** Use `IF`/`FOUND`/`ON CONFLICT` for expected control flow. Reserve EXCEPTION blocks for truly exceptional situations, and never use them in loops.

### PostgREST Error Mapping

RAISE EXCEPTION fields map to JSON response fields:
- MESSAGE → `"message"`
- DETAIL → `"details"`
- HINT → `"hint"`

SQLSTATE to HTTP status:

| SQLSTATE | HTTP | Meaning |
|----------|------|---------|
| `P0001`  | 400  | Default RAISE EXCEPTION |
| `23503`  | 409  | Foreign key violation |
| `23505`  | 409  | Unique violation |
| `PT4xx`  | 4xx  | Custom HTTP status (PT prefix) |

Source: [PostgREST: Errors](https://docs.postgrest.org/en/v12/references/errors.html)

---

## 5. JSONB NULL Behavior

### jsonb_build_object Includes NULLs

`jsonb_build_object('key', NULL)` produces `{"key": null}` — it does NOT omit the key. If you want to omit null-valued keys, apply `jsonb_strip_nulls()` afterward:

> "Deletes all object fields that have null values from the given JSON value, recursively."
> — [PostgreSQL: JSON Functions](https://www.postgresql.org/docs/current/functions-json.html)

```sql
-- Includes null: {"name": "Alice", "bio": null}
jsonb_build_object('name', 'Alice', 'bio', NULL)

-- Strips null: {"name": "Alice"}
jsonb_strip_nulls(jsonb_build_object('name', 'Alice', 'bio', NULL))
```

### jsonb_agg Returns NULL on Empty Input, Includes NULLs in Output

> "Collects all the input values, including nulls, into a JSON array."
> — [PostgreSQL: Aggregate Functions](https://www.postgresql.org/docs/current/functions-aggregate.html)

Over zero rows, `jsonb_agg` returns NULL (like all aggregate functions except `count`):

> "It should be noted that except for `count`, these functions return a null value when no rows are selected."
> — [PostgreSQL: Aggregate Functions](https://www.postgresql.org/docs/current/functions-aggregate.html)

```sql
-- Always wrap in COALESCE for empty-set safety
COALESCE(jsonb_agg(col), '[]'::jsonb)

-- Use jsonb_agg_strict (PG 16+) to exclude NULL elements
-- "Collects all the input values, skipping nulls, into a JSON array."
COALESCE(jsonb_agg_strict(col), '[]'::jsonb)
```

### jsonb_object_agg NULL Behavior

> "Values can be null, but keys cannot."
> — [PostgreSQL: Aggregate Functions](https://www.postgresql.org/docs/current/functions-aggregate.html)

Use `jsonb_object_agg_strict` (PG 16+) to skip entries where the value is NULL.

---

## 6. Function Volatility

> "`IMMUTABLE` indicates that the function cannot modify the database and always returns the same result when given the same argument values."
>
> "`STABLE` indicates that the function cannot modify the database, and that within a single table scan it will consistently return the same result for the same argument values, but that its result could change across SQL statements."
>
> "`VOLATILE` indicates that the function value can change even within a single table scan, so no optimizations can be made."
>
> "Any function that has side-effects must be classified volatile, even if its result is quite predictable, to prevent calls from being optimized away."
> — [PostgreSQL: CREATE FUNCTION](https://www.postgresql.org/docs/current/sql-createfunction.html)

**The danger:** If a function that writes data (INSERT/UPDATE/DELETE) is marked `STABLE` or `IMMUTABLE`, the planner may:
- Cache the result and skip subsequent calls with the same arguments
- Reorder calls in ways that break expected execution order
- Fold the call into a constant during planning

The default is `VOLATILE`, which is safe. Only change it when you're certain the function meets the stricter contract.

---

## 7. Financial / Balance Safety

### The Atomic Deduction Pattern

The correct pattern for deducting from a balance:

```sql
UPDATE accounts SET balance = balance - p_cost
WHERE id = p_id AND balance >= p_cost
RETURNING balance INTO v_balance_after;

IF NOT FOUND THEN
  RAISE EXCEPTION 'Insufficient balance' USING DETAIL = 'INSUFFICIENT_FUNDS';
END IF;
```

Why this is safe:
- **Atomic**: the read (current balance), check (`>= p_cost`), and write (`- p_cost`) happen in one statement
- **TOCTOU-safe**: under READ COMMITTED, concurrent UPDATEs wait and re-evaluate WHERE (see §2)
- **balance_after from RETURNING**: the returned value is the actual post-deduction balance, not a separately computed value that could be stale

### Idempotency Keys

Every financial operation should log a transaction with an idempotency key to prevent double-grant on retry:

```sql
INSERT INTO transactions (user_id, amount, type, idempotency_key, balance_after)
VALUES (p_uid, -p_cost, 'purchase', p_idempotency_key, v_balance_after);
-- unique constraint on idempotency_key prevents duplicate
```

The idempotency key column must be `NOT NULL` — PostgreSQL treats each NULL as distinct for UNIQUE constraints, so a nullable column would allow unlimited duplicates with NULL keys.

### CASCADE Risk on Financial Tables

`ON DELETE CASCADE` on a parent table (e.g., user deletion) can silently destroy financial transaction records. Financial tables should typically use `ON DELETE RESTRICT` or `ON DELETE SET NULL` to preserve the audit trail.

---

## 8. Security

### SECURITY DEFINER + SET search_path

> "Because a `SECURITY DEFINER` function is executed with the privileges of the user that owns it, care is needed to ensure that the function cannot be misused."
>
> "For security, `search_path` should be set to exclude any schemas writable by untrusted users. This prevents malicious users from creating objects (e.g., tables, functions, and operators) that mask objects intended to be used by the function."
> — [PostgreSQL: CREATE FUNCTION](https://www.postgresql.org/docs/current/sql-createfunction.html)

Without `SET search_path = ''`, an attacker can create a temp table shadowing a real table:

```sql
-- Attacker creates shadow table
CREATE TEMP TABLE profiles (id UUID, role TEXT DEFAULT 'admin');
-- SECURITY DEFINER function reads from temp table instead of public.profiles
```

CVE-2007-2138: [PostgreSQL Security Advisory](https://www.postgresql.org/support/security/CVE-2007-2138/)

`SET search_path = ''` forces all references to be fully qualified (`public.tablename`), eliminating this attack class.

### REVOKE EXECUTE FROM PUBLIC

PostgreSQL grants EXECUTE to PUBLIC by default on ALL functions. In Supabase/PostgREST environments, every function in the `public` schema is callable via `/rpc/`. Without REVOKE, anyone with the anon key can call SECURITY DEFINER functions directly.

Source: [Supabase: Hardening the Data API](https://supabase.com/docs/guides/database/hardening-data-api)

---

## 9. DDL Safety

### Lock Levels

| DDL Operation | Lock | Blocks Reads? | Blocks Writes? |
|--------------|------|---------------|----------------|
| `ADD COLUMN` (nullable, no default) | ACCESS EXCLUSIVE | Yes | Yes |
| `ADD COLUMN DEFAULT` (PG 11+) | ACCESS EXCLUSIVE | Yes | Yes (but instant — no rewrite) |
| `ALTER COLUMN TYPE` | ACCESS EXCLUSIVE | Yes | Yes (full table rewrite) |
| `SET NOT NULL` | ACCESS EXCLUSIVE | Yes | Yes (full table scan — see below) |
| `ADD CHECK NOT VALID` | ACCESS EXCLUSIVE | Yes | Yes (brief — no scan) |
| `VALIDATE CONSTRAINT` | SHARE UPDATE EXCLUSIVE | No | No |
| `CREATE INDEX` | SHARE | No | Yes |
| `CREATE INDEX CONCURRENTLY` | SHARE UPDATE EXCLUSIVE | No | No |

### SET NOT NULL — Skipping the Table Scan (PG 12+)

`SET NOT NULL` normally requires a full table scan to verify no NULLs exist. Since PG 12, if a valid `CHECK (col IS NOT NULL)` constraint already exists, the scan is skipped:

> "`SET NOT NULL` may only be applied to a column provided none of the records in the table contain a `NULL` value for the column. Ordinarily this is checked during the `ALTER TABLE` by scanning the entire table; however, if a valid `CHECK` constraint exists (and is not dropped in the same command) which proves no `NULL` can exist, then the table scan is skipped."
> — [PostgreSQL: ALTER TABLE](https://www.postgresql.org/docs/current/sql-altertable.html)

Safe pattern for zero-downtime NOT NULL on large tables:

```sql
-- Step 1: Add CHECK without scanning (brief ACCESS EXCLUSIVE)
ALTER TABLE t ADD CONSTRAINT chk_col_nn CHECK (col IS NOT NULL) NOT VALID;
-- Step 2: Validate (non-blocking SHARE UPDATE EXCLUSIVE scan)
ALTER TABLE t VALIDATE CONSTRAINT chk_col_nn;
-- Step 3: SET NOT NULL (skips scan because validated CHECK exists)
ALTER TABLE t ALTER COLUMN col SET NOT NULL;
-- Step 4: Drop redundant CHECK
ALTER TABLE t DROP CONSTRAINT chk_col_nn;
```

### Safe Constraint Addition

```sql
-- Step 1: Add without scanning (brief lock)
ALTER TABLE t ADD CONSTRAINT chk CHECK (col > 0) NOT VALID;
-- Step 2: Validate (non-blocking scan)
ALTER TABLE t VALIDATE CONSTRAINT chk;
```

### Statements That Cannot Run in a Transaction

- `CREATE INDEX CONCURRENTLY` / `DROP INDEX CONCURRENTLY`
- `VACUUM`
- `CREATE DATABASE` / `DROP DATABASE`

**Note on `ALTER TYPE ... ADD VALUE`:** Since PG 12, this CAN run inside a transaction block, but the new enum value cannot be used until the transaction commits:

> "If `ALTER TYPE ... ADD VALUE` (the form that adds a new value to an enum type) is executed inside a transaction block, the new value cannot be used until after the transaction has been committed."
> — [PostgreSQL: ALTER TYPE](https://www.postgresql.org/docs/current/sql-altertype.html)

This means it works with Supabase `db push` (which wraps migrations in a transaction), but you cannot INSERT a row using the new enum value in the same migration file.

### Idempotency Patterns

| Statement | Idempotent Pattern |
|-----------|-------------------|
| Table | `CREATE TABLE IF NOT EXISTS` |
| Column | `ALTER TABLE ADD COLUMN IF NOT EXISTS` |
| Index | `CREATE INDEX IF NOT EXISTS` |
| Function | `CREATE OR REPLACE FUNCTION` |
| Trigger | `DROP TRIGGER IF EXISTS` + `CREATE TRIGGER` |
| Policy | `DROP POLICY IF EXISTS` + `CREATE POLICY` |
| Grants | Inherently idempotent |

`CREATE OR REPLACE FUNCTION` cannot change the return type or argument types — must `DROP` + `CREATE` for those.

---

## Sources

### PostgreSQL Official Documentation
- [Transaction Isolation](https://www.postgresql.org/docs/current/transaction-iso.html)
- [Explicit Locking](https://www.postgresql.org/docs/current/explicit-locking.html)
- [INSERT (ON CONFLICT)](https://www.postgresql.org/docs/current/sql-insert.html)
- [CREATE FUNCTION](https://www.postgresql.org/docs/current/sql-createfunction.html)
- [ALTER TABLE](https://www.postgresql.org/docs/current/sql-altertable.html)
- [ALTER TYPE](https://www.postgresql.org/docs/current/sql-altertype.html)
- [Comparison Functions and Operators](https://www.postgresql.org/docs/current/functions-comparison.html)
- [Subquery Expressions (NOT IN)](https://www.postgresql.org/docs/current/functions-subquery.html)
- [JSON Functions and Operators](https://www.postgresql.org/docs/current/functions-json.html)
- [Aggregate Functions](https://www.postgresql.org/docs/current/functions-aggregate.html)
- [PL/pgSQL Basic Statements](https://www.postgresql.org/docs/current/plpgsql-statements.html)
- [PL/pgSQL Control Structures](https://www.postgresql.org/docs/current/plpgsql-control-structures.html)
- [PL/pgSQL Errors and Messages](https://www.postgresql.org/docs/current/plpgsql-errors-and-messages.html)

### CVEs
- [CVE-2007-2138: search_path injection](https://www.postgresql.org/support/security/CVE-2007-2138/)

### Subtransaction Performance
- [PostgresAI: Subtransactions considered harmful](https://postgres.ai/blog/20210831-postgresql-subtransactions-considered-harmful) — 64-subtransaction cache limit, SLRU overflow, 20x TPS drop
- [GitLab: Why we spent the last month eliminating PostgreSQL subtransactions](https://about.gitlab.com/blog/why-we-spent-the-last-month-eliminating-postgresql-subtransactions/) — 360k→50k TPS drop, full elimination strategy

### Supabase / PostgREST
- [PostgREST: Error Mapping](https://docs.postgrest.org/en/v12/references/errors.html)
- [Supabase: Hardening the Data API](https://supabase.com/docs/guides/database/hardening-data-api)
- [Supabase: Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security)

### Industry Guides
- [GoCardless: Zero-downtime Postgres migrations](https://gocardless.com/blog/zero-downtime-postgres-migrations-the-hard-parts/)
- [Cybertec: Abusing SECURITY DEFINER](https://www.cybertec-postgresql.com/en/abusing-security-definer-functions/)
