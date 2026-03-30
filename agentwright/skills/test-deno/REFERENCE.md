# Deno Edge Function Testing Reference

Detailed definitions, official sources, and verified citations for each principle in this skill.

## Table of Contents

1. [Test Runner](#1-test-runner)
2. [Assertions](#2-assertions)
3. [BDD Module](#3-bdd-module)
4. [Mocking](#4-mocking)
5. [Sanitizers](#5-sanitizers)
6. [Supabase Integration Testing](#6-supabase-integration-testing)
7. [Environment and Permissions](#7-environment-and-permissions)
8. [CLI Reference](#8-cli-reference)
9. [Anti-Patterns](#9-anti-patterns)

---

## 1. Test Runner

**Source:** [docs.deno.com/runtime/fundamentals/testing](https://docs.deno.com/runtime/fundamentals/testing/)

Deno ships a built-in test runner — no external framework required. Tests are registered with `Deno.test()`.

### File auto-discovery

`deno test` auto-discovers files matching: `{*_,*.,}test.{ts, tsx, mts, js, mjs, jsx}`

This matches `*_test.ts`, `*.test.ts`, and `test.ts` — but NOT `*-test.ts` (hyphenated). To run hyphenated files, pass the directory explicitly.

### `Deno.test()` style (native)

```ts
Deno.test("function returns 200 for valid input", async () => {
  const res = await fetch(`${BASE_URL}/my-function`, { /* ... */ });
  assertEquals(res.status, 200);
});
```

### BDD style (`@std/testing/bdd`)

```ts
import { describe, it, beforeEach, afterEach } from "@std/testing/bdd";

describe("my-function", () => {
  it("returns 200 for valid input", async () => {
    const res = await fetch(`${BASE_URL}/my-function`, { /* ... */ });
    assertEquals(res.status, 200);
  });
});
```

### Test steps

Sub-tests within a single `Deno.test()`:

```ts
Deno.test("grouped tests", async (t) => {
  await t.step("step one", async () => { /* ... */ });
  await t.step("step two", async () => { /* ... */ });
});
```

Steps are awaited sequentially. Each step reports independently.

---

## 2. Assertions

**Source:** [jsr.io/@std/assert](https://jsr.io/@std/assert)

### Complete function list (verified)

| Function | Purpose |
|---|---|
| `assert(expr)` | Truthy check |
| `assertAlmostEquals(actual, expected, tolerance?)` | Floating-point comparison |
| `assertArrayIncludes(actual, expected)` | Array contains all elements |
| `assertEquals(actual, expected)` | Deep equality |
| `assertExists(actual)` | Not null/undefined (narrows to `NonNullable<T>`) |
| `assertFalse(expr)` | Falsy check |
| `assertGreater(actual, expected)` | `actual > expected` |
| `assertGreaterOrEqual(actual, expected)` | `actual >= expected` |
| `assertInstanceOf(actual, ExpectedType)` | `instanceof` check |
| `assertIsError(error, ErrorClass?, msgIncludes?)` | Error type check |
| `assertLess(actual, expected)` | `actual < expected` |
| `assertLessOrEqual(actual, expected)` | `actual <= expected` |
| `assertMatch(actual, regex)` | String matches RegExp |
| `assertNotEquals(actual, expected)` | Deep inequality |
| `assertNotInstanceOf(actual, UnexpectedType)` | NOT `instanceof` |
| `assertNotMatch(actual, regex)` | String does NOT match RegExp |
| `assertNotStrictEquals(actual, expected)` | Reference inequality |
| `assertObjectMatch(actual, expected)` | Partial deep match |
| `assertRejects(fn, ErrorClass?, msgIncludes?)` | Async rejection testing |
| `assertStrictEquals(actual, expected)` | Reference equality (`===`) |
| `assertStringIncludes(actual, expected)` | String contains substring |
| `assertThrows(fn, ErrorClass?, msgIncludes?)` | Synchronous throw testing |
| `equal(a, b)` | Deep equality (returns boolean, no assertion) |
| `fail(msg?)` | Unconditional failure |
| `unimplemented(msg?)` | Marks unimplemented code |
| `unreachable()` | Marks unreachable code |

### Alternative: `@std/expect` (Jest-compatible)

**Source:** [jsr.io/@std/expect](https://jsr.io/@std/expect) — official Deno standard library

```ts
import { expect } from "@std/expect";
expect(x).toEqual(42);
expect(fn).toThrow(TypeError);
await expect(asyncFn()).resolves.toEqual(42);
```

Supports standard matchers plus asymmetric matchers (`expect.anything()`, `expect.objectContaining()`, etc.).

---

## 3. BDD Module

**Source:** [jsr.io/@std/testing/doc/bdd](https://jsr.io/@std/testing/doc/bdd)

### Exports

`describe`, `it`, `test`, `beforeAll`, `afterAll`, `beforeEach`, `afterEach`, `before` (alias of `beforeAll`), `after` (alias of `afterAll`)

### How it maps to Deno.test

"Internally, `describe` and `it` are registering tests with `Deno.test` and `t.step`."

### Modifiers

- `.only()` — run only this test/suite
- `.skip()` — skip this test/suite
- `.ignore()` — alias of `.skip()`

### Known limitation

"There is currently one limitation to this, you cannot use the permissions option on an individual test case or test suite that belongs to another test suite. That's because internally those tests are registered with `t.step` which does not support the permissions option."

### Hook execution order

"A test suite can have multiples of each type of hook, they will be called in the order that they are registered. The `afterEach` and `afterAll` hooks will be called whether or not the test case passes."

---

## 4. Mocking

### Spies

**Source:** [jsr.io/@std/testing/doc/mock](https://jsr.io/@std/testing/doc/mock), [docs.deno.com/examples/mocking_tutorial](https://docs.deno.com/examples/mocking_tutorial/)

"Test spies are function stand-ins that are used to assert if a function's internal behavior matches expectations. Test spies on methods keep the original behavior but allow you to test how the method is called and what it returns."

### Spy usage example

```ts
import { spy, assertSpyCalls, assertSpyCall } from "@std/testing/mock";
const dbSpy = spy(database, "save");
// ... test code ...
assertSpyCalls(dbSpy, 1);
```

### Stubs

"Test stubs are an extension of test spies that also replaces the original methods behavior."

### Cleanup

"Method spys are disposable, meaning that you can have them automatically restore themselves with the `using` keyword."

Using `using` keyword (preferred):
```ts
import { stub } from "@std/testing/mock";
using _stub = stub(deps, "getUserName", () => "Test User");
// stub auto-restores when scope exits
```

Without `using`, always restore in `try/finally`:
```ts
const myStub = stub(obj, "method", () => "mocked");
try {
  // test code
} finally {
  myStub.restore();
}
```

### FakeTime

**Source:** `@std/testing/time` (separate module from `@std/testing/mock`)

```ts
import { FakeTime } from "@std/testing/time";
using time = new FakeTime();
time.tick(3500);
```

### Assertion helpers

- `assertSpyCall(spy, callIndex, expected)` — assert specific call
- `assertSpyCalls(spy, expectedCount)` — assert total call count
- `assertSpyCallArg(spy, callIndex, argIndex, expected)` — assert specific argument
- `assertSpyCallArgs(spy, callIndex, expected)` — assert all arguments
- `returnsNext(values)` — create function returning values from iterable
- `resolvesNext(values)` — async version of `returnsNext`

---

## 5. Sanitizers

**Source:** [docs.deno.com/runtime/fundamentals/testing](https://docs.deno.com/runtime/fundamentals/testing/)

### sanitizeResources (default: true)

"Ensures that all I/O resources created during a test are closed, to prevent leaks."

### sanitizeOps (default: true)

"Ensures that all async operations started in a test are completed before the test ends."

### sanitizeExit (default: true)

"Ensures that tested code doesn't call `Deno.exit()`, which could signal a false test success."

### Per-test sanitizer disable example

```ts
Deno.test({
  name: "test with persistent connection",
  sanitizeResources: false, // Supabase client keeps connection pool open
  async fn() { /* ... */ },
});
```

### When to disable

- `sanitizeResources: false` — when a third-party library holds connections open (e.g., database pool)
- `sanitizeOps: false` — when background tasks fire intentionally (e.g., token refresh)
- NEVER disable globally — only per-test with a documented reason

---

## 6. Supabase Integration Testing

**Source:** [supabase.com/docs/guides/functions/unit-test](https://supabase.com/docs/guides/functions/unit-test)

### Recommended structure

```
supabase/functions/
  function-one/
    index.ts
  tests/
    .env.local
    function-one-test.ts
```

"using the same name as the Function followed by `-test.ts`"

### Official example (Supabase client style)

```ts
import { assert, assertEquals } from "jsr:@std/assert@1";
import { createClient } from "npm:@supabase/supabase-js@2";

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const supabaseKey = Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ?? "";

const client = createClient(supabaseUrl, supabaseKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
    detectSessionInUrl: false,
  },
});
```

### Direct fetch integration test pattern

```ts
const BASE_URL = Deno.env.get("SUPABASE_URL") + "/functions/v1";

Deno.test("POST /my-function returns expected data", async () => {
  const response = await fetch(`${BASE_URL}/my-function`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${Deno.env.get("SB_PUBLISHABLE_KEY")}`,
    },
    body: JSON.stringify({ name: "Test" }),
  });

  assertEquals(response.status, 200);
  const data = await response.json();
  assertEquals(data.message, "Hello Test!");
});
```

### What to test

- Happy-path request/response (status code, body shape)
- Authentication enforcement (missing/invalid JWT returns 401)
- Input validation (malformed body returns 400)
- Error responses (correct status codes and error messages)
- CORS headers (OPTIONS preflight, allowed origins)
- Method routing (POST vs GET vs unsupported methods)

### What NOT to test here (test at the database layer instead)

- RLS policies
- RPC business logic
- Trigger behavior

### Error response testing examples

Always test error paths explicitly:

```ts
Deno.test("returns 401 for missing auth", async () => {
  const res = await fetch(`${BASE_URL}/my-function`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  assertEquals(res.status, 401);
  const body = await res.json();
  assertStringIncludes(body.error, "Missing");
});

Deno.test("returns 400 for invalid body", async () => {
  const res = await fetch(`${BASE_URL}/my-function`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${validToken}`,
    },
    body: JSON.stringify({ wrong: "shape" }),
  });
  assertEquals(res.status, 400);
});

Deno.test("returns 405 for unsupported method", async () => {
  const res = await fetch(`${BASE_URL}/my-function`, { method: "DELETE" });
  assertEquals(res.status, 405);
});
```

### Running

```bash
supabase start
supabase functions serve
deno test --allow-all supabase/functions/tests/function-one-test.ts
```

### Lock file issue

**Source:** [github.com/orgs/supabase/discussions/39966](https://github.com/orgs/supabase/discussions/39966)

The Supabase Edge Runtime uses Deno v2.1.x. Newer Deno CLI versions generate lock file format v5, which the runtime cannot parse. Use `--no-lock` to bypass.

---

## 7. Environment and Permissions

### `--env-file`

**Source:** [docs.deno.com/runtime/reference/cli/test](https://docs.deno.com/runtime/reference/cli/test)

"Load environment variables from local file. Only the first environment variable with a given key is used." Values from `--env-file` take precedence over existing shell environment variables.

### Permissions

**Source:** [docs.deno.com/runtime/fundamentals/testing](https://docs.deno.com/runtime/fundamentals/testing/)

"The `permissions` property in the `Deno.test` configuration allows you to specifically deny permissions, but does not grant them. Permissions must be provided when running the test command."

"Remember that any permission not explicitly granted at the command line will be denied, regardless of what's specified in the test configuration."

### Fine-grained per-test permissions example

```ts
Deno.test({
  name: "reads config file",
  permissions: { read: ["./config.json"], net: false },
  fn: () => { /* ... */ },
});
```

Per-test permissions CANNOT exceed CLI-granted permissions — they can only restrict further.

---

## 8. CLI Reference

**Source:** [docs.deno.com/runtime/reference/cli/test](https://docs.deno.com/runtime/reference/cli/test)

| Flag | Purpose |
|---|---|
| `--env-file=<path>` | Load env vars from file |
| `--no-lock` | Disable lock file discovery |
| `--filter "<pattern>"` | Run tests matching string or `/regex/` |
| `--parallel` | Run test files in parallel (defaults to CPU count) |
| `--fail-fast` | Stop after first failure |
| `--watch` | Re-run on file changes |
| `--coverage=<dir>` | Collect coverage data |
| `--reporter=<type>` | Output format (default: `pretty`) |
| `--no-check` | Skip type checking |
| `--doc` | Evaluate code blocks in JSDoc/Markdown |
| `--shuffle` | Randomize test order |
| `--trace-leaks` | Show resource leak stack traces |
| `--junit-path=<path>` | Output JUnit XML |
| `--permit-no-files` | Don't error if no test files found |

---

## 9. Anti-Patterns

Synthesized from official documentation warnings and sanitizer documentation:

1. **Not awaiting async operations** — sanitizeOps exists specifically for this
2. **Leaking resources** — open files/connections without closing
3. **Disabling sanitizers globally** — hides real bugs
4. **Not restoring stubs/spies** — leaks mock state between tests
5. **Using `assertThrows` for async code** — use `assertRejects`
6. **Over-mocking in integration tests** — defeats the purpose
7. **Relying on test execution order** — tests should be independent
8. **Hardcoding URLs and credentials** — use `Deno.env.get()` + `--env-file`
9. **Ignoring the lock file issue** — use `--no-lock` with Supabase Edge Runtime
10. **Using `assert(condition)` for everything** — provides no useful failure message; use specific assertions (`assertEquals`, `assertStringIncludes`, etc.)
11. **Mocking `fetch` in integration tests** — defeats the purpose of integration testing; use real HTTP calls to the local server
12. **Sharing mutable state without cleanup** — tests become order-dependent; reset in `beforeEach`/`afterEach`
