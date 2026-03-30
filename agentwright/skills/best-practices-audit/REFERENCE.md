# Best Practices Reference

Detailed definitions, rationale, and code examples for each principle audited by this skill.

## Table of Contents

1. [DRY](#1-dry-dont-repeat-yourself)
2. [SOLID](#2-solid-principles)
3. [KISS](#3-kiss-keep-it-simple-stupid)
4. [YAGNI](#4-yagni-you-aint-gonna-need-it)
5. [Clean Code](#5-clean-code)
6. [Error Handling](#6-error-handling)
7. [Security (OWASP)](#7-security-owasp-top-10)
8. [Performance](#8-performance)
9. [Testing](#9-testing)
10. [Code Organization](#10-code-organization--architecture)
11. [Defensive Programming](#11-defensive-programming)
12. [Separation of Concerns](#12-separation-of-concerns)

---

## 1. DRY (Don't Repeat Yourself)

**Source**: *The Pragmatic Programmer* — Andy Hunt & Dave Thomas (1999)

**Principle**: Every piece of knowledge must have a single, unambiguous, authoritative representation within a system.

**What it covers**: Not just code duplication — also duplicated logic, data definitions, and documentation that can fall out of sync.

**Bad**:
```ts
// User validation in registration handler
if (!email || !email.includes('@')) throw new Error('Invalid email');
if (!password || password.length < 8) throw new Error('Weak password');

// Same validation repeated in profile update handler
if (!email || !email.includes('@')) throw new Error('Invalid email');
if (!password || password.length < 8) throw new Error('Weak password');
```

**Good**:
```ts
function validateCredentials(email: string, password: string) {
  if (!email || !email.includes('@')) throw new Error('Invalid email');
  if (!password || password.length < 8) throw new Error('Weak password');
}
```

**Caveat**: Not all similar-looking code is a DRY violation. Two functions that happen to share structure but serve different purposes and will evolve independently are fine as-is. Premature deduplication can create coupling.

---

## 2. SOLID Principles

**Source**: Robert C. Martin (aggregated ~2000s, acronym coined by Michael Feathers)

### S — Single Responsibility Principle (SRP)

A class/module should have one, and only one, reason to change.

**Bad**: A `UserService` that handles registration, email sending, and report generation.
**Good**: Separate `UserRegistration`, `EmailService`, and `ReportGenerator`.

### O — Open/Closed Principle (OCP)

Software entities should be open for extension but closed for modification. Add new behavior by adding new code, not changing existing code.

**Bad**: A payment processor with a growing `switch` statement for each new payment method.
**Good**: A strategy pattern where each payment method implements a `PaymentProcessor` interface.

### L — Liskov Substitution Principle (LSP)

Subtypes must be substitutable for their base types without altering correctness. If `Square extends Rectangle`, calling `setWidth()` must not break expectations.

### I — Interface Segregation Principle (ISP)

No client should be forced to depend on methods it does not use. Prefer many small, focused interfaces over one large one.

### D — Dependency Inversion Principle (DIP)

High-level modules should not depend on low-level modules. Both should depend on abstractions. Abstractions should not depend on details.

**Bad**: `OrderService` directly imports and instantiates `PostgresDatabase`.
**Good**: `OrderService` depends on a `Database` interface; the concrete implementation is injected.

---

## 3. KISS (Keep It Simple, Stupid)

**Source**: U.S. Navy design principle (1960s), widely adopted in software engineering.

**Principle**: Most systems work best if they are kept simple rather than made complicated. Simplicity should be a key goal and unnecessary complexity should be avoided.

**Common violations**:
- Replacing a simple `if/else` with a factory + strategy + registry pattern for two cases
- Using metaprogramming/reflection when straightforward code works
- Creating deep inheritance hierarchies when composition or plain functions suffice
- Writing a custom solution for something the language/framework already provides

---

## 4. YAGNI (You Ain't Gonna Need It)

**Source**: Extreme Programming (XP) — Kent Beck & Ron Jeffries

**Principle**: Don't implement something until you actually need it, not when you foresee you *might* need it.

**Common violations**:
- Adding plugin architectures when the app has one implementation
- Creating abstract base classes with a single concrete subclass
- Building configuration options nobody has asked for
- Adding feature flags before there's more than one variant

**Relationship with KISS**: YAGNI is about *scope* (don't build it yet), KISS is about *complexity* (build it simply).

---

## 5. Clean Code

**Source**: *Clean Code* — Robert C. Martin (2008)

### Naming
- Names should reveal intent: `getUserPermissions()` not `getData()`
- Avoid abbreviations unless universally understood (`id`, `url`, `http` are fine; `usrPrmLst` is not)
- Boolean names should read as questions: `isActive`, `hasPermission`, `canEdit`
- Consistent vocabulary: don't mix `fetch`, `get`, `retrieve`, `load` for the same concept

### Functions
- Should do one thing, at one level of abstraction
- Prefer fewer than 3 parameters; use an options object for more
- Avoid flag arguments (`render(true)`) — split into two named functions
- Side effects should be obvious from the name or documented

### Comments
- Good: explain *why* a non-obvious decision was made
- Bad: restate *what* the code does (`// increment i by 1`)
- Worst: commented-out code left in the codebase

---

## 6. Error Handling

**Sources**: *Clean Code* Chapter 7; language-specific community standards

- **Don't swallow errors**: empty `catch {}` blocks hide bugs
- **Fail fast**: validate inputs early and throw/return immediately on invalid state
- **Use typed/specific errors**: catch specific error types rather than generic `catch(e)`
- **Errors are not control flow**: don't use try/catch for expected branching logic
- **Always handle promises**: every Promise should have a `.catch()` or be `await`ed in a try block
- **Provide context**: error messages should include what failed and why, with enough info to debug

---

## 7. Security (OWASP Top 10)

**Source**: OWASP Foundation — [OWASP Top 10:2025](https://owasp.org/Top10/2025/)

| ID | Category | What to look for |
|----|----------|-----------------|
| A01 | Broken Access Control | Missing auth checks, IDOR, privilege escalation |
| A02 | Security Misconfiguration | Default credentials, overly permissive CORS, verbose errors in production |
| A03 | Software Supply Chain Failures | Outdated dependencies with known CVEs, unverified third-party code |
| A04 | Cryptographic Failures | Plaintext secrets, weak hashing, unencrypted sensitive data |
| A05 | Injection | SQL injection, XSS, command injection, path traversal |
| A06 | Insecure Design | Missing threat modeling, no rate limiting, no abuse prevention |
| A07 | Authentication Failures | Weak passwords allowed, no brute-force protection, broken session management |
| A08 | Software or Data Integrity Failures | Missing integrity checks, insecure deserialization |
| A09 | Security Logging and Alerting Failures | No audit trail, sensitive data in logs |
| A10 | Mishandling of Exceptional Conditions | Unhandled errors exposing internals, missing error boundaries, SSRF via unvalidated URLs |

---

## 8. Performance

**Sources**: Web.dev, framework-specific documentation, general CS principles

- **Avoid premature optimization** — but do avoid *obviously* bad patterns:
  - O(n^2) when O(n) or O(n log n) is straightforward
  - Fetching entire tables/collections when only a subset is needed
  - Re-computing values on every render/call that could be memoized
- **Minimize bundle size**: tree-shake, lazy-load routes/components, avoid importing entire libraries for one utility
- **Batch operations**: reduce network round-trips, use bulk APIs, batch DOM updates
- **Debounce/throttle**: user input handlers that trigger expensive work

---

## 9. Testing

**Sources**: *xUnit Test Patterns* — Gerard Meszaros; *Growing Object-Oriented Software, Guided by Tests* — Freeman & Pryce

- **AAA pattern**: Arrange, Act, Assert — keep tests structured and readable
- **Test behavior, not implementation**: tests should survive refactors that don't change behavior
- **One assertion per concept**: a test should verify one logical thing (may use multiple `expect` calls if they test the same concept)
- **Deterministic**: no random data, no reliance on wall-clock time, no network calls in unit tests
- **Test the contract**: focus on public API, not private internals
- **Coverage priorities**: critical paths and edge cases first; don't chase 100% coverage on trivial code

---

## 10. Code Organization & Architecture

**Sources**: *Clean Architecture* — Robert C. Martin; *Patterns of Enterprise Application Architecture* — Martin Fowler

- **Dependency direction**: dependencies should point inward (toward core/domain logic), not outward (toward frameworks/IO)
- **Feature cohesion**: related code should live together (by feature/domain), not scattered by technical role
- **No circular dependencies**: if A imports B and B imports A, extract shared code to C
- **Consistent file structure**: follow the project's established conventions for where things go
- **Layered boundaries**: keep clear boundaries between data access, business logic, and presentation

---

## 11. Defensive Programming

**Source**: *Code Complete* — Steve McConnell; *The Pragmatic Programmer*

- **Validate at boundaries**: every system entry point (API endpoint, form handler, external data source) must validate inputs
- **Fail gracefully**: partial failures should not crash the entire system
- **Guard clauses**: return early on invalid conditions instead of deeply nesting the happy path
- **Type narrowing**: use type guards, assertions, or schema validation (e.g. Zod) for external data
- **Avoid assumptions**: if a value *can* be null/undefined according to its type, handle it

---

## 12. Separation of Concerns

**Source**: Edsger W. Dijkstra (1974); foundational software engineering principle

- **Each module addresses one concern**: rendering, data fetching, state management, and business logic should be separable
- **Configuration over hardcoding**: environment-specific values belong in config, not scattered in source
- **Platform boundaries**: core logic should be portable; framework-specific code stays at the edges
- **Data vs. presentation**: keep data transformation separate from how it's displayed
