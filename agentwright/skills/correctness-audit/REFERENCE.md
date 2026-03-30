# Correctness Audit — Reference

Detailed definitions, failure patterns, concrete examples, and fixes for each dimension in `SKILL.md`.

---

## 1. Logic Bugs

### Wrong Comparison Operator

The single most common logic bug. `<` vs `<=` is the canonical off-by-one; `==` vs `===` produces silent type coercion in JavaScript.

**Violation:**
```ts
// WRONG — excludes the last valid page
if (page < totalPages) fetchPage(page); // misses page === totalPages

// WRONG — "0" == 0 is true in JS; both branches trigger unexpectedly
if (status == 0) handlePending();
if (status == false) handleEmpty(); // also true for 0, "", null, undefined
```
**Fix:**
```ts
if (page <= totalPages) fetchPage(page);
if (status === 0) handlePending();
```

### Mutation of Input Arguments

Functions that mutate their arguments create invisible coupling — the caller's data changes without warning.

**Violation:**
```ts
function normalize(items: Item[]) {
  items.sort((a, b) => a.id - b.id); // mutates the caller's array
  return items;
}
```
**Fix:**
```ts
function normalize(items: Item[]) {
  return [...items].sort((a, b) => a.id - b.id); // local copy
}
```

### Shadowed Variable

A variable declared inside an inner scope shares the name of an outer-scope variable. Reads in the inner scope silently use the inner version, ignoring the outer.

**Violation:**
```ts
const user = getCurrentUser();
if (condition) {
  const user = await fetchUser(id); // shadows outer `user`
  applyPermissions(user);           // uses inner — correct
}
log(user.id); // uses outer — developer may have intended inner
```
**Fix**: Use distinct names. Lint rule: `no-shadow`.

### Boolean Logic Inversion (De Morgan)

Missing or extra negations produce conditions that are the exact opposite of intent.

**Violation:**
```ts
// Intent: "allow if admin OR owner"
// Bug: "allow if NOT admin AND NOT owner" (blocks everyone who should be allowed)
if (!isAdmin && !isOwner) return allowAccess();
```
**Fix:**
```ts
if (isAdmin || isOwner) return allowAccess();
```

---

## 2. Type & Coercion Bugs

### `+` Operator on Mixed Types

JavaScript's `+` operator does string concatenation when either operand is a string. A number read from an input field, query param, or JSON-as-string will concatenate instead of add.

**Violation:**
```ts
// req.query.count is always a string
const total = req.query.count + 10; // "510" not 15
```
**Fix:**
```ts
const total = Number(req.query.count) + 10;
// or: parseInt(req.query.count, 10) + 10
```

### Floating-Point Arithmetic in Financial Logic

IEEE 754 doubles cannot represent most decimal fractions exactly. `0.1 + 0.2 === 0.30000000000000004` — do not use `number` for money.

**Violation:**
```ts
const total = price * quantity; // $10.10 * 3 = $30.299999999999997
```
**Fix**: Store monetary values as integer cents in the database. Perform all arithmetic in cents. Convert to decimal only for display.

### NaN Propagation

Arithmetic involving `NaN` always produces `NaN`. A single bad input silently corrupts all downstream calculations. `NaN === NaN` is `false`, so equality checks miss it.

**Violation:**
```ts
const score = parseInt(rawInput); // "abc" → NaN
const adjusted = score + bonus;   // NaN — no warning
if (adjusted > threshold) award(); // never triggers
```
**Fix:**
```ts
const score = parseInt(rawInput, 10);
if (!Number.isFinite(score)) throw new Error(`Invalid score: ${rawInput}`);
```

### `JSON.parse` Without Validation

`JSON.parse` returns `any` in TypeScript. Treating the result as a typed value without runtime validation means any shape mismatch (missing field, wrong type, null) silently becomes a bug downstream.

**Violation:**
```ts
const payload = JSON.parse(body) as WebhookPayload;
processEvent(payload.eventType); // crashes if eventType is missing
```
**Fix:**
```ts
const raw: unknown = JSON.parse(body);
const payload = WebhookPayloadSchema.parse(raw); // throws on invalid shape
processEvent(payload.eventType); // safe
```

---

## 3. Null, Undefined & Missing Value Bugs

### Unguarded `.find()` Result

`Array.find()` returns `undefined` when no match exists. Using the result directly without checking throws at runtime.

**Violation:**
```ts
const config = configs.find(c => c.id === targetId);
return config.value; // TypeError: Cannot read properties of undefined
```
**Fix:**
```ts
const config = configs.find(c => c.id === targetId);
if (!config) throw new Error(`Config ${targetId} not found`);
return config.value;
```

### Empty Array Access

`arr[0]` on an empty array returns `undefined`, not an error. If the code then accesses a property of the result, it throws.

**Violation:**
```ts
const latest = events[0].timestamp; // undefined.timestamp if events = []
```
**Fix:**
```ts
const latest = events[0]?.timestamp ?? null;
// or: if (events.length === 0) return null;
```

### Nullable Database Column Treated as Non-Null

A TypeScript type may say `string` for a column that is nullable in the database. The type is wrong — any row inserted with `NULL` will produce `null` at runtime.

**Pattern to flag**: Reading `.foo` on a database row without checking if the type declaration matches the actual schema's nullable constraints.

---

## 4. Async & Promise Bugs

### Missing `await` on Critical Path

A fire-and-forget async call looks correct but the caller does not know if it succeeded or failed, and the function may return before the operation completes.

**Violation:**
```ts
async function deleteUser(id: string) {
  revokeTokens(id);   // NOT awaited — may not complete before function returns
  await db.delete(id);
  return { success: true };
}
```
**Fix:**
```ts
async function deleteUser(id: string) {
  await revokeTokens(id); // must complete before deleting the user
  await db.delete(id);
  return { success: true };
}
```

### Unhandled Promise Rejection

A `.then()` without `.catch()` silently drops errors. In Node.js, unhandled rejections crash the process in newer versions.

**Violation:**
```ts
fetchData().then(process); // rejection from fetchData or process is silently lost
```
**Fix:**
```ts
fetchData().then(process).catch(err => logger.error("fetchData failed", err));
// or use async/await with try/catch
```

### Sequential Awaits on Independent Operations

Two independent async operations awaited in series take `T_a + T_b` time instead of `max(T_a, T_b)`.

**Violation:**
```ts
const user = await fetchUser(id);
const config = await fetchConfig(); // independent — no reason to wait for user first
```
**Fix:**
```ts
const [user, config] = await Promise.all([fetchUser(id), fetchConfig()]);
```

### `Promise.all` Fail-Fast When Partial Failure Is Acceptable

`Promise.all` rejects as soon as any promise rejects — the remaining promises continue executing but their results are ignored. If partial success is acceptable, `Promise.allSettled` is correct.

**Violation:**
```ts
// Sending notifications — one failure shouldn't prevent others
await Promise.all(users.map(u => sendNotification(u))); // one failure cancels all
```
**Fix:**
```ts
const results = await Promise.allSettled(users.map(u => sendNotification(u)));
const failures = results.filter(r => r.status === "rejected");
if (failures.length > 0) logger.warn(`${failures.length} notifications failed`);
```

### Unbounded `Promise.all` on Large Array

Spawning thousands of concurrent async operations exhausts database connections, file handles, or external API rate limits.

**Violation:**
```ts
await Promise.all(thousandsOfItems.map(item => processItem(item)));
```
**Fix**: Use a concurrency-limited batch runner:
```ts
// Process in chunks of 10 at a time
for (let i = 0; i < items.length; i += 10) {
  await Promise.all(items.slice(i, i + 10).map(processItem));
}
// or use a library like p-limit
```

---

## 5. Stale Closures & Captured State

### Loop Variable Capture with `var`

`var` is function-scoped, not block-scoped. All closures created inside the loop capture the same variable, which has its final value by the time the callbacks run.

**Violation:**
```ts
for (var i = 0; i < 5; i++) {
  setTimeout(() => console.log(i), 0); // logs "5" five times, not 0,1,2,3,4
}
```
**Fix:**
```ts
for (let i = 0; i < 5; i++) { // `let` is block-scoped; each iteration gets its own `i`
  setTimeout(() => console.log(i), 0);
}
```

### React `useEffect` Stale Closure

A `useEffect` callback captures prop/state values at the time of the effect's creation. If those values change but the effect's dependency array doesn't include them, the callback operates on stale values forever.

**Violation:**
```tsx
useEffect(() => {
  const interval = setInterval(() => {
    // `count` is captured at mount and never updates
    setCount(count + 1); // always adds 1 to the initial value
  }, 1000);
  return () => clearInterval(interval);
}, []); // missing `count` in deps
```
**Fix:**
```tsx
useEffect(() => {
  const interval = setInterval(() => {
    setCount(c => c + 1); // functional update — always uses current value
  }, 1000);
  return () => clearInterval(interval);
}, []);
```

---

## 6. Resource Leaks & Missing Cleanup

### Event Listener Never Removed

Adding a listener in a component's mount phase without removing it on unmount causes the handler to fire after the component is gone, often throwing on de-referenced state.

**Violation:**
```tsx
useEffect(() => {
  window.addEventListener("resize", handleResize);
  // no cleanup — handleResize fires after unmount, references stale state
}, []);
```
**Fix:**
```tsx
useEffect(() => {
  window.addEventListener("resize", handleResize);
  return () => window.removeEventListener("resize", handleResize);
}, [handleResize]);
```

### Interval Not Cleared on Unmount

A `setInterval` that is not cleared on unmount continues firing after the component is gone, wasting resources and updating state that is no longer rendered.

**Violation:**
```tsx
useEffect(() => {
  setInterval(tick, 1000); // interval ID discarded; can never be cleared
}, []);
```
**Fix:**
```tsx
useEffect(() => {
  const id = setInterval(tick, 1000);
  return () => clearInterval(id);
}, []);
```

### Growing Unbounded Cache

An in-memory cache that is added to without eviction grows without bound and eventually exhausts memory.

**Violation:**
```ts
const cache = new Map<string, Result>(); // module-level, grows forever
function getCached(key: string) {
  if (!cache.has(key)) cache.set(key, compute(key));
  return cache.get(key)!;
}
```
**Fix**: Add a max-size eviction policy (LRU), a TTL, or use a bounded cache library. At minimum, document that the key space must be finite and bounded.

---

## 7. Edge Cases — Inputs

### Empty String Assumptions

A function receiving a user-supplied string must handle `""` explicitly — it is falsy in JavaScript, which sometimes helps but often misleads.

**Violation:**
```ts
function getInitials(name: string) {
  return name.split(" ").map(w => w[0]).join(""); // name="" → [][""][0] → undefined
}
```
**Fix:**
```ts
function getInitials(name: string) {
  if (!name.trim()) return "";
  return name.trim().split(/\s+/).map(w => w[0].toUpperCase()).join("");
}
```

### Unicode / Emoji String Length

JavaScript strings are UTF-16. Emoji and many non-Latin characters are represented as surrogate pairs — two code units each. `.length`, `.slice()`, `.charAt()`, and `.split("")` all operate on code units, not characters.

**Violation:**
```ts
const truncated = message.slice(0, 100); // may split a surrogate pair, producing "?"
const len = "👋".length; // 2, not 1
```
**Fix:**
```ts
// Use Array.from or spread to iterate by Unicode code point
const chars = Array.from(message);
const truncated = chars.slice(0, 100).join("");
const len = Array.from("👋").length; // 1
```

### Division by Zero

Any user-supplied or computed value used as a divisor must be checked.

**Violation:**
```ts
const avgScore = totalScore / userCount; // NaN or Infinity when userCount = 0
```
**Fix:**
```ts
const avgScore = userCount === 0 ? 0 : totalScore / userCount;
```

---

## 8. Edge Cases — External Data & Network

### `fetch` Does Not Reject on HTTP Errors

`fetch` only rejects on network failure (DNS, timeout, no connection). A 400, 404, or 500 response resolves normally with `response.ok === false`.

**Violation:**
```ts
const data = await fetch("/api/users").then(r => r.json()); // 500 → parsed error body, no throw
```
**Fix:**
```ts
const response = await fetch("/api/users");
if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
const data = await response.json();
```

### Missing Request Timeout

A `fetch` call with no timeout will wait indefinitely if the server hangs. In a serverless function, this exhaust the function's max execution time and blocks the client.

**Violation:**
```ts
const response = await fetch(url); // no timeout
```
**Fix:**
```ts
const response = await fetch(url, { signal: AbortSignal.timeout(5_000) }); // 5 second max
```

### `JSON.parse` Not Wrapped in Try/Catch

`JSON.parse` throws a `SyntaxError` on malformed input. If the input comes from an external source it can fail at any time.

**Violation:**
```ts
const data = JSON.parse(rawBody); // throws on malformed JSON; crashes the handler
```
**Fix:**
```ts
let data: unknown;
try {
  data = JSON.parse(rawBody);
} catch {
  return badRequest("Invalid JSON body");
}
```

---

## 9. Concurrency & Shared State

### Non-Atomic Read-Modify-Write

Read a value, compute a new value, write it back. If two concurrent operations both read the same initial value, the second write silently overwrites the first.

**Violation (application layer):**
```ts
const balance = await getBalance(userId);      // both read 100
const newBalance = balance - amount;           // both compute 50
await setBalance(userId, newBalance);          // second write wins: 50 instead of 0
```
**Fix**: Use a database-level atomic update (`UPDATE ... SET coins = coins - $amount WHERE coins >= $amount`), or use `SELECT FOR UPDATE` to lock the row for the duration of the transaction.

**Violation (JavaScript):**
```ts
let counter = 0;
async function increment() {
  const current = counter;  // read
  await someAsync();        // yields — another increment may run here
  counter = current + 1;    // write: first increment's result is lost
}
```
**Fix**: For in-process counters, use a mutex or perform the increment synchronously without yielding.

### Reentrant Async Function

An async function that is called again before its first invocation finishes, with both invocations modifying shared state.

**Pattern to flag:**
```ts
let isSyncing = false; // in-memory guard

async function sync() {
  if (isSyncing) return; // TOCTOU: two callers can both read false simultaneously
  isSyncing = true;
  await doSync();
  isSyncing = false;
}
```
**Fix**: The guard only works if `isSyncing = true` is set synchronously before the first `await`. The code above is actually fine for this reason — flag it only if there is a `await` before setting the flag. For distributed/multi-instance systems, an in-memory flag is insufficient and must be moved to a database or Redis.

---

## 10. Scalability — Algorithmic Complexity

### Linear Scan Inside a Loop — O(n²)

Using `Array.includes()`, `Array.find()`, or `Array.indexOf()` inside a loop that iterates over a collection of size n performs n × n = n² operations.

**Violation:**
```ts
// O(n²): for each item, scan all blockedIds
const visible = items.filter(item => !blockedIds.includes(item.id));
```
**Fix:**
```ts
// O(n): one-time Set construction + O(1) lookups
const blockedSet = new Set(blockedIds);
const visible = items.filter(item => !blockedSet.has(item.id));
```

### Regex Recompilation in a Loop

`new RegExp(pattern)` compiles the pattern every call. If called in a loop with a constant pattern, this is wasted work.

**Violation:**
```ts
for (const line of lines) {
  if (new RegExp("^ERROR:").test(line)) handle(line); // compiles every iteration
}
```
**Fix:**
```ts
const errorPattern = /^ERROR:/; // compile once
for (const line of lines) {
  if (errorPattern.test(line)) handle(line);
}
```

---

## 11. Scalability — Database & I/O

### N+1 Queries

Fetching a list, then issuing one query per row in a loop, is the most common database scalability bug. It turns one round-trip into N+1 round-trips.

**Violation:**
```ts
const posts = await db.query("SELECT * FROM posts LIMIT 20");
for (const post of posts) {
  // 20 separate queries — one per post
  post.author = await db.query("SELECT * FROM users WHERE id = $1", [post.author_id]);
}
```
**Fix:**
```ts
const posts = await db.query("SELECT * FROM posts LIMIT 20");
const authorIds = posts.map(p => p.author_id);
const authors = await db.query("SELECT * FROM users WHERE id = ANY($1)", [authorIds]);
const authorMap = new Map(authors.map(a => [a.id, a]));
posts.forEach(p => { p.author = authorMap.get(p.author_id); });
```

### Unbounded Query

A query with no `LIMIT` returns the entire table. Tables grow over time; this query will eventually time out, exhaust memory, or cause OOM.

**Violation:**
```ts
const users = await db.query("SELECT * FROM users WHERE active = true");
// returns 10 rows today; returns 100,000 rows in a year
```
**Fix:**
```ts
const users = await db.query(
  "SELECT id, display_name FROM users WHERE active = true LIMIT $1 OFFSET $2",
  [pageSize, page * pageSize]
);
```

---

## 12. Scalability — Memory & Throughput

### Loading Full Dataset Into Memory

Reading an entire file, table, or collection into an array before processing. Memory usage grows linearly with data size.

**Violation:**
```ts
const allEvents = await db.query("SELECT * FROM events"); // 10 million rows
const processed = allEvents.map(transform);
```
**Fix**: Use cursor-based streaming or pagination:
```ts
let cursor = 0;
while (true) {
  const batch = await db.query("SELECT * FROM events WHERE id > $1 LIMIT 1000", [cursor]);
  if (batch.length === 0) break;
  batch.forEach(transform);
  cursor = batch[batch.length - 1].id;
}
```

### In-Memory Coordination State That Breaks on Scale-Out

A module-level `Map`, `Set`, or variable used as a cache, rate limiter, or deduplication store is **not shared** between multiple server instances or worker processes. When the service scales out or restarts, the state is lost or silently per-instance.

**Violation:**
```ts
// Works on one instance; breaks when there are two
const rateLimitCache = new Map<string, number>(); // module-level

function checkRateLimit(userId: string): boolean {
  const count = rateLimitCache.get(userId) ?? 0;
  rateLimitCache.set(userId, count + 1);
  return count < 10;
}
```
**Fix**: Move shared state to a database (Redis, PostgreSQL) that all instances can access. Flag this whenever module-level mutable state is used for coordination in a server context.
