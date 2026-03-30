---
name: correctness-audit
description: Reviews code for correctness bugs, uncaught edge cases, and scalability problems. Use when reviewing code changes, performing code audits, or when the user asks for a review or quality check. For security vulnerabilities use security-audit; for design, maintainability, and principle violations use best-practices-audit.
---

# Code Quality Review

Perform a systematic review focused on **correctness** and **runtime concerns**: will this code work correctly under all realistic inputs and load? Every finding must cite the file, line(s), dimension, and a concrete fix. For security vulnerabilities, use `security-audit`. For principle violations (DRY, SOLID, Clean Code), use `best-practices-audit`.

## Scope

Determine what to review based on context:

- **Git diff mode** (default when no scope specified and changes exist): run `git diff` and `git diff --cached` to review only changed/added code and its immediate context
- **File/directory mode**: review the files or directories the user specifies
- **Full review mode**: when the user asks for a full review, scan all source code (skip vendor/node_modules/build artifacts)

Read all in-scope code before producing findings.

## Dimensions to Evaluate

Evaluate code against each dimension. Skip dimensions with no findings. See [REFERENCE.md](REFERENCE.md) for detailed definitions, concrete examples, and fixes.

### 1. Logic Bugs

- **Wrong operators**: `<` vs `<=`, `==` vs `===`, `&&` vs `||`, bitwise vs logical operators
- **Off-by-one errors**: loop boundaries, slice/splice indices, pagination offset calculations
- **Incorrect variable**: copy-paste errors where the wrong variable is used (e.g. checking `a > 0` but intending `b > 0`)
- **Boolean logic inversions**: conditions that are the exact opposite of what they should be (missing `!`, De Morgan's law violations)
- **Mutating instead of cloning**: modifying an input argument or shared reference when a local copy is required
- **Shadowed variables**: inner-scope declaration masking an outer-scope variable of the same name, causing silent incorrect reads
- **Assignment in condition**: `if (x = getValue())` when `===` was intended
- **Short-circuit misuse**: relying on `&&` or `||` for side effects in code paths where the right-hand side must always run

### 2. Type & Coercion Bugs

- **Implicit type coercion**: `+` operator on mixed `string | number` producing concatenation instead of addition; `==` coercing types unexpectedly
- **Unsafe casts**: `as T` assertions on data from external sources (API responses, `JSON.parse`, database rows typed as `any`) without runtime validation
- **Integer/float confusion**: using floating-point arithmetic where integer arithmetic is required (financial amounts, indices, counts); missing `Math.floor`/`Math.round` on division results
- **Precision loss**: `Number` used for values > `Number.MAX_SAFE_INTEGER` (2⁵³-1); should use `BigInt` or a decimal library
- **NaN propagation**: arithmetic on a value that may be `NaN` without a guard; `NaN === NaN` is always `false`; `isNaN("string")` returns `true`
- **Nullable column mismatch**: TypeScript type says `string` but the database column is nullable; the value can be `null` at runtime

### 3. Null, Undefined & Missing Value Bugs

- **Unguarded property access**: accessing `.foo` on a value that can realistically be `null` or `undefined` at runtime (API response fields, optional config, database nullable columns)
- **Destructuring without defaults**: `const { limit } = options` where `options` may be `undefined`, or `limit` may be absent
- **Array access without bounds check**: `arr[0]` on an array that may be empty; `arr[arr.length - 1]` on a zero-length array
- **`find()` result not checked**: `.find()` returns `undefined` when no match exists; using the result directly without a null guard will throw
- **Optional chaining gaps**: using `a.b.c` when `a` or `b` can be nullish; should be `a?.b?.c`
- **Early return missing**: function continues executing after a condition should have terminated it

### 4. Async & Promise Bugs

- **Missing `await`**: `async` function calls whose result is not awaited, running fire-and-forget when the caller depends on the result
- **Unhandled promise rejections**: `.then()` without `.catch()`, or top-level `async` functions with no try/catch, that silently swallow errors
- **Sequential awaits that should be parallel**: awaiting independent async operations in series (`await a(); await b()`) when `Promise.all([a(), b()])` would be faster and correct
- **`Promise.all` vs `Promise.allSettled`**: using `Promise.all` when any single rejection should not abort all others; vs. using `Promise.allSettled` when the caller actually needs to fail fast
- **Async function returning void unintentionally**: a function signature of `async (): Promise<void>` that actually should return a value the caller uses
- **Race between async operations**: two concurrent async paths writing to the same location (state, DB row, file) without synchronization
- **Uncleaned async resources**: `setInterval`, `setTimeout`, event listeners, or subscriptions started inside a component/class that are never cleaned up when the scope is destroyed

### 5. Stale Closures & Captured State

- **Stale closure over mutable variable**: a callback or timeout captures a variable by reference; by the time the callback runs, the variable has changed
- **Loop variable capture**: `for (var i = 0; ...)` with async/callback inside — all callbacks share the same `i` by the time they run (use `let` or pass `i` as an argument)
- **React hooks missing dependencies**: a `useEffect` or `useCallback` that reads a prop or state value not listed in the dependency array — the callback sees the initial value forever
- **Event listener capturing stale props**: a DOM event listener added once in a `useEffect` that captures `props.onEvent` at mount time, missing all future updates
- **Memoization with wrong keys**: `useMemo` / `useCallback` / `React.memo` used with a dependency array that doesn't actually capture everything the computation depends on

### 6. Resource Leaks & Missing Cleanup

- **Event listeners never removed**: `addEventListener` called on mount, no corresponding `removeEventListener` on unmount
- **Intervals/timeouts never cleared**: `setInterval` / `setTimeout` not captured in a ref or cancelled on component unmount
- **Subscriptions not cancelled**: Realtime, WebSocket, or observable subscriptions opened but never `.unsubscribe()` / `.close()` called
- **File/stream handles not closed**: `fs.open`, database connections, or readable streams that are opened but not closed on all exit paths (including error paths)
- **Growing in-memory collections**: caches, queues, or maps that are added to but never evicted from, unbounded over time

### 7. Uncaught Edge Cases — Inputs

- **Empty string**: functions that receive a user-provided string and assume it is non-empty (`.split()`, `.charAt(0)`, regex matching)
- **Empty array or object**: loops or transforms on collections that assume at least one element
- **Zero and negative numbers**: code that divides by a user-supplied value without guarding against zero; index calculations that go negative
- **Numeric boundaries**: values at or near `Number.MAX_SAFE_INTEGER`, `Number.MIN_SAFE_INTEGER`, `Infinity`, `-Infinity`, `NaN`
- **Unicode and emoji**: string `.length` counts UTF-16 code units, not characters; a single emoji is 2 code units — truncation, substring, and split operations can corrupt multi-code-unit characters
- **Null bytes and control characters**: untrusted strings containing `\0`, `\r`, `\n` passed to file paths, log messages, or downstream systems
- **Very long inputs**: strings or arrays far larger than typical — does the code O(n) scale gracefully, or does it load everything into memory?

### 8. Uncaught Edge Cases — External Data & Network

- **Non-200 HTTP responses not handled**: `fetch` resolves (does not reject) on 4xx/5xx — the caller must explicitly check `response.ok` or `response.status`
- **Partial or truncated responses**: streaming or chunked data where the full payload may not arrive
- **Timeout not set**: outbound HTTP calls with no timeout; one slow downstream service hangs the entire request chain indefinitely
- **Retry without backoff**: immediately retrying failed network calls in a tight loop instead of using exponential backoff with jitter
- **Malformed JSON**: `JSON.parse()` throws on invalid input; this must be wrapped in try/catch
- **Unexpected API shape**: downstream API fields assumed to be present and correctly typed without validation; treat all external data as `unknown`
- **Stale or cached data returned on error**: error handlers that silently return the last-known-good cached value without signalling the failure to the caller

### 9. Concurrency & Shared State

- **Check-then-act (TOCTOU)**: reading a value, checking a condition, then acting — another concurrent operation can change the value between check and act
- **Non-atomic read-modify-write**: incrementing a counter or appending to a list stored outside the current execution context without a lock or atomic operation
- **Reentrant function calls**: an async function that can be called again before its first invocation completes, with both invocations sharing mutable state
- **Global/module-level mutable state**: variables at module scope that accumulate or change across requests (dangerous in server contexts where module scope is shared between requests in the same isolate)
- **Event ordering assumptions**: code that assumes async events will arrive in a specific order (e.g., "message A always before message B") without enforcement

### 10. Scalability — Algorithmic Complexity

- **O(n²) or worse nested loops**: an inner loop that iterates over the same or a related collection for every outer iteration; grows quadratically
- **Linear scan where constant lookup exists**: using `Array.includes()`, `Array.find()`, or `Array.indexOf()` inside a loop where converting to a `Set` or `Map` would make lookups O(1)
- **Repeated sorting**: sorting the same array on each render or request when it could be sorted once and cached
- **Unnecessary full-collection passes**: multiple `.filter().map().reduce()` chains on the same array that could be combined into a single pass
- **Regex recompilation**: constructing `new RegExp(pattern)` inside a loop when the pattern is constant — compile once outside the loop

### 11. Scalability — Database & I/O

- **N+1 queries**: fetching a list of N records, then issuing a separate query for each one in a loop — should be a single join or an `IN (...)` query
- **Unbounded queries**: `SELECT * FROM table` or `.findAll()` without `LIMIT` — returns the entire table; grows unbounded as data grows
- **Missing pagination**: API endpoints that return all results instead of pages; clients and servers both suffer as dataset grows
- **Fetching more columns than needed**: `SELECT *` when only 2-3 columns are used; pulls unnecessary data across the network and into memory
- **Queries inside render or hot paths**: database or API calls triggered on every render cycle or in tight loops rather than cached or batched
- **Sequential queries that could be parallel**: `await db.query(A); await db.query(B)` where A and B are independent — use `Promise.all`
- **Missing index implied by access pattern**: code that filters or sorts on a column that will clearly require a full table scan without an index (flag based on the access pattern — don't claim to know the schema unless you can read it)

### 12. Scalability — Memory & Throughput

- **Loading full dataset into memory**: reading an entire file, table, or collection into an array when streaming or cursor-based processing would avoid the memory spike
- **Unbounded `Promise.all`**: `Promise.all(items.map(asyncFn))` where `items` can be very large — spawns thousands of concurrent operations, exhausting connections or memory
- **No backpressure on queues**: pushing work into a queue faster than it can be consumed, with no throttling or rejection when the queue is full
- **In-memory coordination state**: using a module-level `Map` or `Set` as a cache, queue, or lock that is not shared between process replicas — breaks on horizontal scale-out
- **No connection pooling**: creating a new database connection per request instead of using a pool
- **Repeated expensive computation**: calling an expensive pure function with the same inputs repeatedly without memoization or caching the result

## Static Analysis Tools

Before producing findings, **run available linters** on in-scope code and incorporate their output into findings.

### TypeScript compiler
```bash
npx tsc --noEmit
```
Type errors, implicit `any`, and unchecked nulls. Map findings to Dimension 2 (Type & Coercion) or Dimension 3 (Null/Undefined).

### ESLint
```bash
npx eslint src/
```
Key rules that surface bugs: `no-unused-vars`, `no-undef`, `@typescript-eslint/no-floating-promises`, `@typescript-eslint/no-misused-promises`, `react-hooks/exhaustive-deps`, `no-constant-condition`, `no-self-assign`.

### Ruff (Python)
```bash
ruff check --select E,F,B,C90 .
```
`F` = Pyflakes (undefined names, unused imports), `B` = Bugbear (common bug patterns), `C90` = McCabe complexity.

### How to use tool output
1. Map each tool finding to its dimension (e.g., `@typescript-eslint/no-floating-promises` → Dimension 4: Async & Promise Bugs).
2. Linter errors that indicate real runtime bugs go under **Critical**; style findings go under **Suggestion**.
3. Note "tsc: clean" / "ESLint: clean" in the Summary if no issues.

## Output Format

Group findings by severity, not by dimension. Each finding must name the dimension it falls under.

```
## Critical
Issues that will cause incorrect behavior, data loss, or crashes in production.

### [Dimension] Brief title
**File**: `path/to/file.ts` (lines X–Y)
**Dimension**: Full dimension name — one-line explanation of what correct code requires.
**Problem**: What the code does wrong and the concrete runtime impact (what breaks, when, and for whom).
**Fix**: Specific, actionable code change.

## Warning
Issues likely to cause bugs under realistic inputs or load, or that will cause failures during future changes.

(same structure)

## Suggestion
Improvements that reduce risk or improve robustness but are not urgently broken.

(same structure)

## Summary
- Total findings: N (X critical, Y warning, Z suggestion)
- Dimensions most frequently violated: list top 2–3
- Linter results: tsc: clean / ESLint: N issues / Ruff: clean (etc.)
- Overall assessment: 1–2 sentence verdict on correctness and robustness
```

## Verification Pass

Before finalizing your report, verify every finding:

1. **Re-read the code**: Go back to the flagged file and re-read the flagged lines in full context (±20 lines). Confirm the issue actually exists — not a misread, not handled elsewhere in the same file, not guarded by a try/catch, type check, or upstream validation.
2. **Check for existing mitigations**: Search the codebase for related patterns. Is the "missing" check done in a shared utility, middleware, type guard, or configuration? If so, drop the finding.
3. **Verify against official docs**: For every API or runtime behavior you cite, confirm your claim is correct. If you're unsure how a function handles edge cases (null, empty, concurrent), look it up — don't guess. Use available tools (context7, web search, REFERENCE.md) to check current documentation when uncertain.
4. **Filter by confidence**: If you're certain a finding is a false positive after re-reading, drop it entirely. If doubt remains but the issue seems plausible, mention it concisely as "Worth Investigating" at the end of the report — don't include it as a formal finding.

## Rules

- **Be specific**: always cite file paths and line numbers.
- **Be actionable**: every finding must include a concrete fix — not "handle null" but "add `if (!user) return notFound()` before line 42."
- **Model the failure**: every Critical finding must describe what actually breaks at runtime — which input triggers it, what the symptom is.
- **Severity by real-world impact**: rate by what breaks in production, not theoretical worst-case.
- **No fluff**: skip dimensions with no findings. Don't praise code that is merely acceptable.
- **Respect scope**: in diff mode, only flag issues in changed lines and their immediate context. Don't audit the entire file when asked about a one-line change.
- **Don't duplicate other skills**: correctness bugs only — no security (use `security-audit`), no principle violations (use `best-practices-audit`). Edge cases and concurrency bugs that are also security vulnerabilities should be flagged here for correctness and referenced to `security-audit` for the security angle.
