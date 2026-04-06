# Test Writing — Reference

Detailed definitions, official sources, and verified citations for each principle in this skill.

## Table of Contents

1. [Foundational Frameworks](#1-foundational-frameworks)
2. [Test Structure](#2-test-structure)
3. [Test Doubles](#3-test-doubles)
4. [Assertion Quality](#4-assertion-quality)
5. [Test Naming](#5-test-naming)
6. [Test Organization — The Test Pyramid](#6-test-organization--the-test-pyramid)
7. [Determinism and Flakiness](#7-determinism-and-flakiness)
8. [Edge Cases and Input Design](#8-edge-cases-and-input-design)
9. [Code Coverage](#9-code-coverage)
10. [Advanced Techniques](#10-advanced-techniques)
11. [Common Anti-Patterns](#11-common-anti-patterns)

---

## 1. Foundational Frameworks

Three frameworks define the properties of good tests. They overlap but emphasize different dimensions.

### Kent Beck's Test Desiderata (2019)

**Source:** [medium.com/@kentbeck_7670/test-desiderata](https://medium.com/@kentbeck_7670/test-desiderata-94150638a4b3), [testdesiderata.com](https://testdesiderata.com/)

Twelve desirable properties for tests. Not all tests exhibit all properties — the key insight is that no property should be abandoned without gaining something more valuable in exchange.

| # | Property | Definition |
|---|----------|-----------|
| 1 | **Isolated** | Tests should return the same results regardless of the order in which they are run. |
| 2 | **Composable** | I should be able to test different dimensions of variability separately and combine the results. |
| 3 | **Fast** | Tests should run quickly. |
| 4 | **Inspiring** | Passing the tests should inspire confidence. |
| 5 | **Writable** | Tests should be cheap to write relative to the cost of the code being tested. |
| 6 | **Readable** | Tests should be comprehensible for reader, invoking the motivation for writing this particular test. |
| 7 | **Behavioral** | Tests should be sensitive to changes in the behavior of the code under test. |
| 8 | **Structure-insensitive** | Tests should not change their result if the structure of the code changes. |
| 9 | **Automated** | Tests should run without human intervention. |
| 10 | **Specific** | If a test fails, the cause of the failure should be obvious. |
| 11 | **Deterministic** | If nothing changes, the test result shouldn't change. |
| 12 | **Predictive** | If the tests all pass, then the code under test should be suitable for production. |

Properties 7 (Behavioral) and 8 (Structure-insensitive) together capture the central principle: tests should break when behavior changes and *not* break when only internal structure changes.

### FIRST Principles

**Source:** Tim Ottinger & Brett Schuchert (origin), popularized in Robert C. Martin, *Clean Code* (2008), Chapter 9.

| Letter | Property | Meaning |
|--------|----------|---------|
| **F** | Fast | Tests should run quickly enough to run frequently. |
| **I** | Isolated | Tests must not depend on each other or on shared mutable state. |
| **R** | Repeatable | Tests must produce the same result every time, in any environment. |
| **S** | Self-validating | Tests must have a boolean outcome — pass or fail, no manual interpretation. |
| **T** | Timely | Tests are best written immediately before or alongside the code they test. |

Tim Ottinger has confirmed: "Brett Schuchert and I came up with FIRST [...] It was always 'Timely.' Later, people who don't use TDD hijacked the T to mean Thorough."

### Khorikov's Four Pillars

**Source:** Vladimir Khorikov, *Unit Testing: Principles, Practices, and Patterns* (Manning, 2020), Chapter 4.

| Pillar | What it measures |
|--------|-----------------|
| **Protection against regressions** | How well the test catches real defects. |
| **Resistance to refactoring** | Whether the test avoids false positives when behavior-preserving changes are made. |
| **Fast feedback** | How quickly the test runs. |
| **Maintainability** | How easy the test is to understand and modify. |

Khorikov argues that the first two pillars are in tension — maximizing regression protection often means testing more implementation detail, which hurts resistance to refactoring. The best tests maximize both by testing through public APIs and verifying observable behavior.

---

## 2. Test Structure

### Arrange-Act-Assert (AAA)

**Source:** Bill Wake observed and named the pattern in 2001. [xp123.com/3a-arrange-act-assert](https://xp123.com/3a-arrange-act-assert/)

```
// Arrange — set up preconditions
const account = new Account(100);

// Act — execute the behavior
account.withdraw(30);

// Assert — verify the outcome
assertEqual(account.balance, 70);
```

Each phase should be visually separated (blank line). If Arrange dominates the test, extract a helper. If Act has multiple steps, the test is verifying multiple behaviors — split it.

### Given-When-Then (BDD)

**Source:** Daniel Terhorst-North & Chris Matts, as part of Behavior-Driven Development. Documented by Martin Fowler: [martinfowler.com/bliki/GivenWhenThen.html](https://martinfowler.com/bliki/GivenWhenThen.html). North introduced BDD in a 2006 article: [dannorth.net/blog/introducing-bdd](https://dannorth.net/blog/introducing-bdd/)

Given-When-Then is the same structure as AAA expressed in domain language:

- **Given** some precondition (Arrange)
- **When** an action occurs (Act)
- **Then** expect an outcome (Assert)

The value of Given-When-Then is communication — it reads as a specification, not as code.

### DAMP — Descriptive And Meaningful Phrases

**Source:** Jay Fields coined DAMP for DSLs (2006). Adopted for testing in *Software Engineering at Google*, Chapter 12: [abseil.io/resources/swe-book/html/ch12.html](https://abseil.io/resources/swe-book/html/ch12.html)

"A little bit of duplication is OK in tests so long as that duplication makes the test simpler and clearer."

| Extract into helpers | Keep inline |
|---------------------|-------------|
| Mechanical setup (create a user, connect to DB) | Scenario-specific values (what makes *this* test unique) |
| Repeated teardown/cleanup | Assertions and expected outcomes |
| Builder patterns for complex objects | The Act step |

A reader should understand a test without jumping to any helper definition. If a helper hides intent, inline it.

---

## 3. Test Doubles

### Terminology

**Source:** Gerard Meszaros, *xUnit Test Patterns* (2007). Documented by Martin Fowler: [martinfowler.com/bliki/TestDouble.html](https://martinfowler.com/bliki/TestDouble.html)

| Type | Definition | Example |
|------|-----------|---------|
| **Dummy** | Passed around but never used. Fills parameter lists. | A null logger passed to satisfy a constructor. |
| **Fake** | Working implementation not suitable for production. | In-memory database, fake payment gateway that always succeeds. |
| **Stub** | Provides canned answers to calls made during the test. | A function that always returns `{ status: 200 }`. |
| **Spy** | A stub that also records calls for later verification. | An email service that records how many messages it sent. |
| **Mock** | Pre-programmed with expectations about which calls it will receive. Fails verification if expectations aren't met. | A mock that asserts `sendEmail` was called exactly once with specific args. |

### State vs Behavior Verification

**Source:** Martin Fowler, "Mocks Aren't Stubs": [martinfowler.com/articles/mocksArentStubs.html](https://martinfowler.com/articles/mocksArentStubs.html)

**State verification**: "we determine whether the exercised method worked correctly by examining the state of the SUT and its collaborators after the method was exercised."

**Behavior verification**: "we instead check to see if the order made the correct calls on the warehouse."

State verification is preferred because it tests *what happened*, not *how it happened*. Use behavior verification only at system boundaries where you must confirm a side effect occurred (email sent, event published, external API called).

### Classical vs Mockist TDD

**Source:** Martin Fowler, "Mocks Aren't Stubs" (same article)

| Style | Also called | Approach |
|-------|------------|----------|
| **Classical** | Detroit school | Use real objects when possible; doubles only when awkward |
| **Mockist** | London school | Mock all collaborators with interesting behavior |

Classical testing is the default recommendation for most teams. It produces tests that are more resistant to refactoring because they're coupled to behavior, not to the call graph.

### Google's Guidance on Test Doubles

**Source:** *Software Engineering at Google*, Chapter 13: [abseil.io/resources/swe-book/html/ch13.html](https://abseil.io/resources/swe-book/html/ch13.html)

Key principles:

1. **Prefer real implementations** when they are fast, deterministic, and have simple dependencies.
2. **Prefer fakes** over stubs/mocks when a real implementation is impractical. Fakes should be owned and maintained by the team that owns the real implementation.
3. **Minimize stubbing** — it leaks implementation details and provides no guarantee that stubbed behavior matches reality.
4. **Avoid interaction testing** — "it can't tell you that the system under test is working properly; it can only validate that certain functions are called." Reserve it for state-changing calls at system boundaries.
5. **Beware mock overuse** — Google found that widespread mocking led to tests that were a "maintenance burden" and "rarely finding bugs." They created the `@DoNotMock` annotation to prevent mocking of APIs that have better alternatives.

---

## 4. Assertion Quality

### Why Specific Assertions Matter

A specific assertion provides a useful failure message. A generic assertion does not.

```python
# BAD — failure says "AssertionError: False is not true"
assert result == 42

# GOOD — failure says "AssertionError: 17 != 42"
assertEqual(result, 42)
```

### Assertion Selection by Situation

| Situation | Preferred assertion | Avoid |
|-----------|-------------------|-------|
| Exact value equality | `assertEqual` / `assertEquals` / `toBe` / `is` | `assertTrue(a == b)` |
| Deep structural equality | `assertDeepEqual` / `toEqual` | Manual field-by-field checks |
| Partial match | `toMatchObject` / `assertObjectMatch` | Exact equality on large objects |
| Synchronous exception | `assertThrows` / `assertRaises` / `toThrow` / `throws_ok` | try/catch + manual fail |
| Async exception | `assertRejects` / `pytest.raises` in async | `assertThrows` on a promise |
| String contains | `assertIn` / `toContain` / `assertStringIncludes` | `assertTrue(s.includes(x))` |
| Collection membership | `assertIn` / `toContain` / `assertArrayIncludes` | Loop + boolean flag |
| Approximate numeric | `assertAlmostEqual` / `toBeCloseTo` | Rounding then exact compare |
| Null/None check | `assertIsNone` / `toBeNull` / `assertExists` | `assertEqual(x, None)` |
| Boolean | `assertTrue` / `assertFalse` / `toBeTruthy` | `assertEqual(x, True)` |
| Empty collection | `assertEmpty` / `toHaveLength(0)` / `is_empty` | `assertEqual(len(x), 0)` |

### One Logical Assertion Per Test (Not One `assert` Statement)

A test may contain multiple `assert` statements if they all verify the same logical outcome:

```python
# GOOD — multiple asserts, one logical behavior (HTTP response shape)
response = client.post("/users", json={"name": "Alice"})
assertEqual(response.status_code, 201)
assertEqual(response.json()["name"], "Alice")
assertIn("id", response.json())
```

What you should NOT do is assert on multiple independent behaviors:

```python
# BAD — two independent behaviors in one test
response = client.post("/users", json={"name": "Alice"})
assertEqual(response.status_code, 201)
# ... AND ALSO check that the email was sent
assertEqual(email_service.send_count, 1)  # separate behavior — split this
```

---

## 5. Test Naming

### The Goal

A failing test name should tell you **what broke** without reading the test body. Test names are the first thing a developer reads in CI output.

### Three Components

Every test name should convey:

1. **Subject** — what unit/function/feature is being tested
2. **Scenario** — under what conditions
3. **Outcome** — what the expected result is

### Common Conventions

| Convention | Example | Common in |
|------------|---------|-----------|
| `MethodName_Scenario_Expected` | `withdraw_insufficientFunds_throwsError` | Java, C# |
| Descriptive sentence | `test_transfer_fails_when_balance_insufficient` | Python (pytest) |
| `should` + behavior | `should reject expired tokens` | JavaScript (Jest, Vitest, Mocha) |
| `it` + description | `it("returns 404 when user does not exist")` | JavaScript BDD |
| Given-When-Then | `given_expired_token_when_authenticate_then_returns_401` | BDD-style in any language |

### What NOT to Do

- Mirror method names: `test_calculateTotal` — what about it?
- Number tests: `test1`, `test2` — meaningless when they fail
- Describe implementation: `test_calls_validate_then_save` — coupled to structure
- Be vague: `test_it_works`, `test_happy_path` — which happy path?

Adopt the project's existing convention. Consistency within a project matters more than which convention is "best."

---

## 6. Test Organization — The Test Pyramid

### The Pyramid

**Source:** Mike Cohn, *Succeeding with Agile* (2009). Documented by Martin Fowler: [martinfowler.com/bliki/TestPyramid.html](https://martinfowler.com/bliki/TestPyramid.html)

```
        /  E2E  \         Few, slow, expensive
       /----------\
      / Integration \      Some, moderate speed
     /----------------\
    /    Unit Tests     \  Many, fast, cheap
   /____________________\
```

The pyramid's essential message: "you should have many more low-level unit tests than high level broad-stack tests running through a GUI."

### Google's Recommended Ratio

**Source:** *Software Engineering at Google*, Chapter 11: [abseil.io/resources/swe-book/html/ch11.html](https://abseil.io/resources/swe-book/html/ch11.html)

- ~80% unit tests (narrow-scoped)
- ~15% integration tests (medium-scoped)
- ~5% end-to-end tests (large-scoped)

### Google's Test Sizes

**Source:** Google Testing Blog: [testing.googleblog.com/2010/12/test-sizes.html](https://testing.googleblog.com/2010/12/test-sizes.html)

| Constraint | Small | Medium | Large |
|-----------|-------|--------|-------|
| Network | No | Localhost only | Yes |
| Database | No | Yes | Yes |
| File system | No | Yes | Yes |
| Multiple threads | No | Yes | Yes |
| Sleep / time | No | Yes | Yes |
| External systems | No | Discouraged | Yes |
| Time limit | 60s | 300s | 900s+ |

Note: *size* (resource constraints) and *scope* (how much code is exercised) are independent dimensions. A narrow-scoped test can be medium-sized if it needs a real browser.

### The Ice Cream Cone Anti-Pattern

**Source:** Alister Scott, "Testing Pyramids & Ice-Cream Cones"

The inverted pyramid — mostly manual testing, heavy UI automation, few unit tests — is the most common testing anti-pattern. It produces slow, flaky, expensive test suites that catch bugs late.

### Push Tests Down

**Source:** Ham Vocke, "The Practical Test Pyramid": [martinfowler.com/articles/practical-test-pyramid.html](https://martinfowler.com/articles/practical-test-pyramid.html)

Two rules for maintaining the pyramid shape:

1. "If a higher-level test spots an error and there's no lower-level test failing, you need to write a lower-level test."
2. "Push your tests as far down the test pyramid as you can."

---

## 7. Determinism and Flakiness

### The Cost of Flakiness

A flaky test — one that passes and fails non-deterministically without code changes — erodes trust in the entire test suite. Teams stop investigating failures, stop running tests, and lose their safety net.

### Common Causes and Fixes

| Cause | Mechanism | Fix |
|-------|-----------|-----|
| **Wall-clock time** | `Date.now()`, `time.time()`, `Instant.now()` | Inject a clock; use the framework's fake-time utility |
| **Random data** | `Math.random()`, `uuid()`, `random.choice()` | Use fixed seeds or deterministic factories |
| **Network calls** | External API is slow/down/rate-limited | Replace with fakes or stubs; mock at the HTTP boundary |
| **Race conditions** | Async operations complete in unpredictable order | Await all operations; use condition-based waits, not sleeps |
| **Shared state** | Database rows, files, env vars leak between tests | Isolate per-test; use transactions + rollback; reset in setup |
| **Test order** | Test B depends on state created by test A | Make each test self-contained; run in random order to surface |
| **Resource leaks** | Open files, connections, handles not closed | Use cleanup hooks; frameworks with leak detection (Deno sanitizers) |
| **Timezone/locale** | Code behaves differently in CI vs local machine | Pin timezone/locale in test setup; use UTC in tests |

### The Beyoncé Rule

**Source:** *Software Engineering at Google*, Chapter 11

"If you liked it, then you shoulda put a test on it."

Test everything you don't want to break — not just happy paths. This includes performance, correctness, accessibility, security, and failure handling.

---

## 8. Edge Cases and Input Design

### Equivalence Partitioning

Divide the input space into classes where all values in a class should produce the same behavior. Test one representative from each class instead of exhaustively testing all values.

Example for a function accepting age (0-150):

| Partition | Representative | Expected |
|-----------|---------------|----------|
| Below valid range | -1 | Error |
| Lower boundary | 0 | Valid |
| Typical valid | 25 | Valid |
| Upper boundary | 150 | Valid |
| Above valid range | 151 | Error |
| Non-numeric | "abc" | Error |
| Null/missing | null | Error |

### Boundary Value Analysis

Bugs cluster at boundaries. For a valid range of [1, 100], test:

- **At boundaries**: 1, 100
- **Just outside**: 0, 101
- **Just inside**: 2, 99 (sometimes)
- **Special values**: 0, -1, MAX_INT, empty string, empty array

Combine equivalence partitioning (which partitions to test) with boundary value analysis (which values within each partition) for maximum coverage with minimum test count.

### Common Edge Cases by Type

| Input type | Edge cases to test |
|-----------|-------------------|
| **Strings** | Empty `""`, single char, very long, unicode, whitespace-only, null |
| **Numbers** | 0, -1, 1, MAX, MIN, NaN, Infinity, decimal precision |
| **Collections** | Empty, single element, many elements, duplicates, null elements |
| **Dates/times** | Epoch, leap year (Feb 29), DST transitions, midnight, year boundaries |
| **Files** | Empty file, missing file, read-only, very large, special characters in name |
| **Objects** | Missing optional fields, extra unexpected fields, deeply nested |

---

## 9. Code Coverage

### Coverage Is a Floor, Not a Ceiling

**Source:** *Software Engineering at Google*, Chapter 11

Code coverage measures which lines were *executed*, not whether they were *correctly tested*. 100% coverage with no assertions is worthless.

Google cautions: "When teams set coverage targets (like 80%), those often become ceilings rather than floors, paradoxically reducing testing rigor." Teams optimize for the metric by writing low-value tests to inflate numbers.

### What Coverage Is Good For

- **Finding untested code**: 0% coverage on a module means it has no tests. That's actionable.
- **Spotting missed branches**: branch coverage reveals untested `if`/`else` paths.
- **Trend tracking**: coverage decreasing over time suggests new code isn't being tested.

### What Coverage Is NOT Good For

- **Measuring test quality**: a test that executes a line without asserting anything contributes to coverage but catches nothing.
- **Comparing across projects**: 80% on a CLI tool and 80% on a payment service mean very different things.
- **Setting targets**: a mandated 90% target incentivizes gaming rather than quality.

### Mutation Testing — Testing Your Tests

**Source:** [stryker-mutator.io](https://stryker-mutator.io/)

Mutation testing introduces small changes (mutants) to production code and checks whether the test suite detects them. If a mutant survives (tests still pass), there's a gap in the test suite.

Tools: Stryker (JS/TS, .NET), PIT/Pitest (Java). Mutation testing is expensive to run (it re-runs the test suite for every mutant) but provides a far more accurate measure of test effectiveness than line coverage.

---

## 10. Advanced Techniques

### Property-Based Testing

**Source:** [hypothesis.works/articles/what-is-property-based-testing](https://hypothesis.works/articles/what-is-property-based-testing/)

Instead of specifying individual test cases, specify *properties* that should hold for all inputs. The framework generates random inputs and finds counterexamples.

| Component | What it does |
|-----------|-------------|
| **Property** | An executable specification that should hold for all valid inputs |
| **Generator** | Produces random inputs matching a schema (integers, strings, complex objects) |
| **Shrinking** | When a counterexample is found, minimizes it to the simplest failing case |

Tools: Hypothesis (Python), fast-check (JS/TS), QuickCheck (Haskell), PropCheck (Elixir), Kotest property testing (Kotlin).

Property-based testing excels at finding edge cases you wouldn't think to write manually. It's most valuable for pure functions, serialization/deserialization roundtrips, and invariant verification.

### Contract Testing

**Source:** Ham Vocke, "The Practical Test Pyramid"

Consumer-Driven Contracts (CDC) allow consuming teams to specify their expectations of an API in executable tests. The providing team runs these tests to verify they don't break consumers.

Use contract testing when: multiple teams consume the same API, and you need to verify compatibility without running full end-to-end tests.

Tools: Pact, Spring Cloud Contract.

### Snapshot Testing

Use snapshots for: large output that's tedious to assert manually (serialized objects, HTML output, CLI output).

Avoid snapshots for: rapidly changing output, small values that are easy to assert directly, or anything where you wouldn't notice a meaningful difference in a large diff.

Snapshot tests tend to be approved without review ("just update the snapshot") and can silently accept regressions. Use them sparingly and always review snapshot updates deliberately.

---

## 11. Common Anti-Patterns

Synthesized from Gerard Meszaros (*xUnit Test Patterns*), Google (*Software Engineering at Google*), and Kent Beck (*Test Desiderata*).

### Test Smells (Code)

| Smell | Description | Fix |
|-------|------------|-----|
| **Obscure Test** | Test is hard to understand due to excessive setup, irrelevant detail, or missing context | Inline relevant setup; use DAMP naming; remove irrelevant details |
| **Eager Test** | Test verifies too many behaviors at once | Split into focused tests — one behavior per test |
| **Mystery Guest** | Test depends on external data (files, DB rows) not visible in the test body | Make dependencies explicit in Arrange; use builders or factories |
| **Hard-Coded Test Data** | Magic numbers and strings with no explanation of why those values matter | Use named constants or variables that convey intent |
| **Conditional Test Logic** | Test has `if`/`else` or loops — the test itself may have bugs | Tests should be straight-line code; parameterize instead of branching |

### Test Smells (Behavior)

| Smell | Description | Fix |
|-------|------------|-----|
| **Fragile Test** | Tests break on behavior-preserving changes (refactoring) | Test through public API; assert on observable behavior, not implementation |
| **Flaky Test** | Test passes and fails non-deterministically | See Section 7 — fix the root cause (time, randomness, shared state, network) |
| **Slow Test** | Tests take too long, developers stop running them | Push tests down the pyramid; mock I/O at boundaries; parallelize |
| **Assertion Roulette** | Multiple assertions with no message — when one fails, you don't know which | Add descriptive messages; or split into separate tests |
| **Test Run War** | Tests fail when run concurrently because they share external resources | Isolate resources per test (unique DB schemas, temp directories, ports) |
