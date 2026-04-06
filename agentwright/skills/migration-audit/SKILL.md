---
name: migration-audit
description: Audit PL/pgSQL migration files for correctness bugs, missing constraints, race conditions, NULL traps, and data integrity gaps. Use AUTOMATICALLY before presenting any new or modified SQL migration file to the user. Triggers on writing .sql files in supabase/migrations/, creating PL/pgSQL functions, or reviewing database schema changes.
---

# PL/pgSQL Migration Audit

Run this audit on EVERY migration file BEFORE presenting it to the user. Do not show the migration until all checks pass or issues are documented.

See [REFERENCE.md](REFERENCE.md) for detailed failure modes, code examples, and source citations for each check.

## Scope

Determine which migration files to audit:

- **Git diff mode** (default when no scope specified and changes exist): run `git diff` and `git diff --cached` to find changed `.sql` files in migration directories. Also check for **new untracked migrations** with `git ls-files --others --exclude-standard '*.sql'` — new migration files won't appear in `git diff`.
- **File mode**: audit the specific migration file(s) the user specifies
- **Directory mode**: audit all `.sql` files in the specified migration directory

Read all in-scope migration files before producing findings.

## Pre-audit: Read Dependencies

Before auditing, read ALL referenced tables' CREATE TABLE statements to understand:
- Column types, NOT NULL constraints, DEFAULT values
- CHECK constraints, UNIQUE constraints, partial unique indexes
- Foreign key relationships and ON DELETE behavior
- Existing indexes that affect ON CONFLICT behavior

## Checklist

### 1. NULL Safety

For EVERY function parameter and EVERY variable used in a comparison:

**Comparisons:**
- Does any `!=` / `<>` break on NULL? (`NULL != 'x'` → NULL → falsy, skips the block)
- Does any `=` silently match nothing on NULL? (`WHERE col = NULL` → zero rows always)
- FIX: `IS DISTINCT FROM` for NULL-safe inequality, `IS NOT DISTINCT FROM` for NULL-safe equality
- Is `NOT IN` used with a subquery that could contain NULLs? (Returns ZERO rows — use `NOT EXISTS`)

**Variables:**
- Are any PL/pgSQL variables used before assignment? (All default to NULL — `counter + 1` = NULL)
- Does any string concatenation include a potentially-NULL value? (`'text' || NULL` = NULL)
- Does any arithmetic include a potentially-NULL value? (`5 + NULL` = NULL)

**CASE expressions:**
- Is `CASE var WHEN NULL` used? (Never matches — use `CASE WHEN var IS NULL`)

**Parameters:**
- Do NOT add cosmetic NULL guards on internal/service-role RPCs validated by the caller
- DO add a NULL guard ONLY when NULL causes a **silent logic bug** (wrong result, not just ugly error)
- For each parameter: trace what happens if NULL. If the function errors → fine. If it silently produces wrong results or skips a check → add a guard.

### 2. TOCTOU / Race Conditions

For EVERY read-then-write sequence:

**Identify the pattern:**
- SELECT/EXISTS → INSERT: Can two concurrent calls both pass the check and both INSERT?
  - FIX: `INSERT ... ON CONFLICT` or catch `unique_violation`
- SELECT/EXISTS → UPDATE: Can another transaction modify the row between check and update?
  - FIX: Put the check in the UPDATE's WHERE clause (atomic single-statement)
- SELECT → compute → UPDATE (read-modify-write): Is the computed value stale?
  - FIX: Atomic relative UPDATE (`SET col = col - amount WHERE col >= amount RETURNING col`)

**Why atomic UPDATE is the gold standard:** Under READ COMMITTED, if a concurrent UPDATE modifies the target row, a subsequent UPDATE *waits* for the first to commit, then *re-evaluates its WHERE clause* against the newly committed row. This makes single-statement UPDATE inherently TOCTOU-safe.

**Row locking (when atomic single-statement isn't sufficient):**
- Is `FOR UPDATE` / `FOR NO KEY UPDATE` needed to serialize a multi-statement decision?
- Which row to lock? (Lock the row whose state determines the decision)
- Prefer `FOR NO KEY UPDATE` when not changing PK / FK-referenced columns (allows concurrent `FOR KEY SHARE`)

**Deadlock risk (when locking multiple rows):**
- Are rows locked in a consistent, deterministic order? (e.g., `ORDER BY id FOR UPDATE`)

**Advisory locks (when row locks don't fit):**
- Is `pg_advisory_xact_lock` appropriate? (auto-released at transaction end — preferred for short-lived locks)
- Session-level `pg_advisory_lock` requires explicit unlock and survives rollback — use only when needed
- Is the lock key deterministic and collision-free?

### 3. Unique Constraints & ON CONFLICT

For EVERY INSERT:
- What unique constraint catches a duplicate? **Name it explicitly.**
- Is `unique_violation` caught in a BEGIN/EXCEPTION block where needed?
- If an invariant is enforced by application logic only: should it ALSO be a DB constraint?

For EVERY `ON CONFLICT`:
- Does the target constraint/index **actually exist** in a prior migration? **Name it.**
- Is it safe to silently skip (`DO NOTHING`), or should it raise an error?
- If using `RETURNING`: does NOT return anything on `DO NOTHING` path — is this handled?
- Could multiple unique constraints be violated? (ON CONFLICT targets only ONE — a conflict on a DIFFERENT constraint still raises `unique_violation` uncaught)

### 4. Error Handling Completeness

**SELECT INTO:**
- Is `FOUND` checked after every `SELECT INTO` where zero rows is possible?
- `FOUND` = TRUE even if the returned VALUE is NULL (tracks row existence, not value)
- Alternative: `SELECT INTO STRICT` raises `NO_DATA_FOUND` / `TOO_MANY_ROWS` automatically — use when exactly one row is expected

**UPDATE/DELETE:**
- Is `FOUND` checked after every UPDATE/DELETE where zero affected rows is an error?

**Constraint violations:**
- Could a constraint violation occur that isn't caught?
- If caught via EXCEPTION block: is the cost justified? (Each EXCEPTION block creates a subtransaction — avoid in loops)

**RAISE EXCEPTION:**
- Does every RAISE include `USING DETAIL` for programmatic error handling?
- Is there a consistent error code vocabulary across the project?

### 5. JSONB Construction

For EVERY `jsonb_build_object`, `jsonb_agg`, `jsonb_object_agg`:
- **NULL inclusion**: `jsonb_build_object('key', NULL)` produces `{"key": null}`, not omission. Is this intended?
- **Empty aggregation**: `jsonb_agg` over zero rows returns NULL, not `'[]'::jsonb`. Use `COALESCE(jsonb_agg(...), '[]'::jsonb)`.
- **NULL in arrays**: `jsonb_agg` includes NULL elements. Use `jsonb_agg_strict` (PG 16+) or filter with WHERE to exclude.
- **NULL values in objects**: `jsonb_object_agg` includes NULL values. Use `jsonb_object_agg_strict` (PG 16+) or filter.
- Use `jsonb_strip_nulls()` to remove null-valued keys from a constructed object when needed.

### 6. Function Volatility

For EVERY function:
- Is it marked `VOLATILE` (default), `STABLE`, or `IMMUTABLE`?
- A function with side effects (INSERT, UPDATE, DELETE, writing to a sequence) **must** be `VOLATILE`
- `STABLE` means: cannot modify the database, returns same result within a single statement for same args
- `IMMUTABLE` means: cannot modify the database, returns same result forever for same args (no DB lookups at all)
- Mismarking a writing function as `STABLE`/`IMMUTABLE` lets the planner cache or reorder calls, skipping writes

### 7. Financial / Balance Safety (if applicable)

- Atomic deduction pattern used? (`UPDATE ... SET bal = bal - cost WHERE bal >= cost RETURNING bal`)
- Transaction logged with idempotency key? (prevents double-grant on retry)
- `balance_after` from RETURNING clause (not computed separately)?
- CHECK constraint on balance column? If intentionally omitted (e.g., chargebacks), document why.
- Could ON DELETE CASCADE on a parent table silently destroy financial records?

### 8. Security Template

For EVERY function:
- `SECURITY DEFINER` + `SET search_path = ''` (prevents search_path hijacking — CVE-2007-2138)
- `REVOKE EXECUTE FROM PUBLIC, anon, authenticated` (prevents direct PostgREST `/rpc/` calls)
- `GRANT EXECUTE TO service_role` (or whichever role(s) need access)
- All table refs fully qualified (e.g., `public.tablename` — required when search_path is empty)
- No dynamic SQL with string concatenation (use `format(%I, %L)` or `EXECUTE ... USING`)
- REVOKE/GRANT signature must match the CREATE FUNCTION signature exactly (including DEFAULT params)

### 9. DDL Safety (if applicable — ALTER TABLE, CREATE INDEX, etc.)

- Does any DDL take ACCESS EXCLUSIVE lock on a table with data? (blocks ALL reads/writes)
- Should `lock_timeout` be set as a safety net?
- Are constraints added with `NOT VALID` + separate `VALIDATE CONSTRAINT`? (non-blocking for large tables)
- `SET NOT NULL` after a validated `CHECK (col IS NOT NULL)`? (skips table scan — PG 12+)
- Are indexes on existing tables created `CONCURRENTLY`? (non-blocking)
- Can `CREATE INDEX CONCURRENTLY` run inside a transaction? (NO — needs separate migration)
- Is every DDL statement idempotent? (`IF NOT EXISTS`, `OR REPLACE`, `DROP IF EXISTS` + `CREATE`)

## Verification Pass

Before finalizing your audit notes, verify every issue you found:

1. **Re-read the code**: Go back to the flagged lines in full context. Confirm the issue actually exists — not a misread, not handled by a later statement in the same function, not guarded by a constraint or trigger you missed.
2. **Check for existing mitigations**: Search the migration file and referenced tables. Is the "missing" constraint already defined in a prior migration? Is the race condition prevented by a unique index you didn't notice? If so, drop the finding.
3. **Verify against official docs**: For every PostgreSQL behavior you cite (NULL semantics, lock levels, ON CONFLICT rules), confirm your claim is correct. If you're unsure, look it up — don't guess. Use available tools (context7, web search, REFERENCE.md) to check current documentation when uncertain.
4. **Filter by confidence**: If you're certain a finding is a false positive after re-reading, drop it entirely. If doubt remains but the issue seems plausible, note it in the audit summary as "Worth Investigating" — don't fix it without confirmation.

## Output

**Only report issues.** Do not list dimensions that passed — silence means no problems found.

If the audit is clean: `**Migration audit: PASS** (no issues found)`

If issues exist, list only the findings:

```
**Migration audit: <filename>**
- [Dimension]: [file:line] — [what's wrong and concrete fix]
- [Dimension]: [file:line] — [what's wrong and concrete fix]
```

If issues are found, fix them BEFORE presenting. Do not present migrations with known issues.
