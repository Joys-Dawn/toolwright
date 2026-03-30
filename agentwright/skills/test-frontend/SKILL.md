---
name: test-frontend
description: Use when writing, reviewing, or fixing React component/hook tests, or when auditing frontend tests for RTL, Vitest, Zustand, or TanStack Query best practices. Triggers on query priority issues, mock leaks, flaky async tests, or Kent C. Dodds common-mistakes violations.
---

# React Frontend Testing

Write and review React component and hook tests using Vitest and React Testing Library (RTL). Every recommendation is sourced from official documentation — see [REFERENCE.md](REFERENCE.md) for citations, code examples, and detailed explanations.

## Scope

Determine what to review or write based on user request:

- **Write mode**: write new tests for components/hooks the user specifies
- **Review mode**: audit existing test files for anti-patterns and best practice violations
- **Fix mode**: fix failing or flawed tests

Test files live in the project's test directory (commonly `src/__tests__/` or `__tests__/` — check the project structure).

## Prerequisites

```bash
cd app && npx vitest        # run all tests (watch mode)
cd app && npx vitest run    # run all tests once
cd app && npx vitest run src/__tests__/path/to/file.test.tsx  # specific file
```

## The Core Principle

**Source:** [testing-library.com/docs/guiding-principles](https://testing-library.com/docs/guiding-principles)

> "The more your tests resemble the way your software is used, the more confidence they can give you."

This means:
- Test from the user's perspective (what they see and interact with)
- Query elements by their accessible roles and visible text
- Do NOT test implementation details (internal state, CSS classes, component structure)

## Principles to Enforce

### 1. Query Priority — Use the Most Accessible Query

| Priority | Query | When to use |
|----------|-------|-------------|
| 1 | `getByRole` | **Default choice** — accessible to everyone |
| 2 | `getByLabelText` | Form fields with labels |
| 3 | `getByPlaceholderText` | When no label exists |
| 4 | `getByText` | Non-interactive content |
| 5 | `getByDisplayValue` | Filled-in form elements |
| 6 | `getByAltText` | Images, areas, inputs |
| 7 | `getByTitle` | Tooltip-like content |
| 8 | `getByTestId` | **Last resort only** |

**Anti-patterns:**
- Using `getByTestId` when `getByRole` would work
- Using `container.querySelector()` — NEVER do this
- Using `getByText` for buttons when `getByRole('button', { name: /text/i })` is available

### 2. Query Type Selection — `getBy` vs `queryBy` vs `findBy`

| Type | Returns | Throws? | Use when |
|------|---------|---------|----------|
| `getBy` | Element | Yes, if not found | Element MUST exist (default) |
| `queryBy` | Element or `null` | No | Asserting element does NOT exist |
| `findBy` | Promise\<Element\> | Yes, after timeout | Element appears asynchronously |
| `getAllBy` | Array | Yes, if empty | Multiple elements MUST exist |
| `queryAllBy` | Array (may be empty) | No | Checking count of elements |
| `findAllBy` | Promise\<Array\> | Yes, after timeout | Multiple elements appear async |

**Anti-patterns:**
- Using `queryBy` to assert existence — use `getBy` instead
- Wrapping `getBy` in `waitFor` — use `findBy` instead
- Using `findBy` for synchronous elements — use `getBy` instead

### 3. User Interactions — Use `@testing-library/user-event`

- Use `userEvent.setup()` before `render()`, inside each test
- The docs discourage using userEvent functions outside the test itself (e.g., in `before`/`after` hooks)
- Use `user-event` for all interactions — only fall back to `fireEvent` for events `user-event` doesn't support

### 4. Async Testing — `waitFor` and `findBy`

- Use `findBy` for elements that appear asynchronously (it combines `waitFor` + `getBy`)
- Use `waitFor` only for assertions that become true asynchronously
- **Do NOT** wrap `getBy` in `waitFor` — use `findBy` instead
- **Do NOT** leave `waitFor` callbacks empty
- **Do NOT** put multiple assertions inside a single `waitFor` — one inside, rest outside
- **Do NOT** put side effects (like `fireEvent.click`) inside `waitFor`

### 5. `screen` — Always Use It

- Always use `screen.getByRole(...)` etc. instead of destructuring from `render()`
- `screen` is always available, reduces refactoring churn, and matches the recommended pattern

### 6. Assertions — Use `jest-dom` Matchers

- Use semantic matchers: `toBeDisabled()`, `toBeVisible()`, `toHaveTextContent()`, `toHaveAttribute()`
- Do NOT check DOM properties directly (e.g., `button.disabled`, `element.textContent`)
- Key matchers: `toBeVisible()`, `toBeDisabled()`/`toBeEnabled()`, `toBeInTheDocument()`, `toHaveTextContent()`, `toHaveAttribute()`, `toHaveClass()`, `toHaveValue()`, `toBeChecked()`

### 7. Vitest Mocking — `vi.mock()`, `vi.spyOn()`, `vi.fn()`

- `vi.mock()` is hoisted to top of file — runs before all imports
- Use `vi.hoisted()` when you need variables available to the hoisted mock factory

| Method | What it does |
|--------|-------------|
| `vi.clearAllMocks()` | Clears mock history (calls, instances). Does NOT reset implementation. |
| `vi.resetAllMocks()` | Clears history AND resets implementation to `() => undefined`. |
| `vi.restoreAllMocks()` | Restores original implementations for `vi.spyOn` spies. Does NOT clear history. |

- Use `vi.clearAllMocks()` in `beforeEach` — most common pattern

### 8. Component Testing with Providers

- Components using React Query, Router, or Zustand need provider wrappers
- Create a `createWrapper()` function that returns a provider component with `QueryClientProvider` and `MemoryRouter`
- Use the `wrapper` option in `render()` and `renderHook()`

### 9. Testing React Query

- Create a **new `QueryClient` per test** — prevents shared cache between tests
- Set `retry: false` — prevents tests from retrying failed queries (makes failures instant)
- Use the `wrapper` option to provide `QueryClientProvider`

### 10. Testing Zustand Stores

- **Official pattern:** create `__mocks__/zustand.ts` that auto-resets stores between tests
- **Alternative:** set store state directly via `useAppStore.setState()` or `useAppStore.getState().clearStore()` in `beforeEach`
- **Vitest warning:** if you change the Vitest `root` config (e.g., to `./src`), the `__mocks__` directory must be relative to that root

### 11. Cleanup — Automatic

- Do NOT manually call `cleanup()` — Vitest handles it automatically
- Do NOT import `cleanup` — it's unnecessary boilerplate

### 12. Test Isolation

- Use `beforeEach` to reset mocks and store state
- Create fresh `QueryClient` instances per test (not shared)
- Use `vi.clearAllMocks()` in `beforeEach` to reset call history
- Tests within a file share module scope — don't rely on test order

### 13. What to Test vs What NOT to Test

**Test (user-observable behavior):**
- Rendered text and accessible elements
- User interactions (click, type, submit) and their effects
- Navigation and route changes
- Error states and loading states
- Accessibility (roles, labels, ARIA attributes)

**Do NOT test (implementation details):**
- Internal component state
- CSS classes or inline styles
- Component instance methods
- Hook internals (test via component behavior or `renderHook`)
- That a function was called N times (unless it's the main behavior being tested)

### 14. Act Warnings — When to Use `act()`

- `render()` and `fireEvent` are already wrapped in `act()` — do NOT wrap them again
- Only use `act()` when directly triggering state updates outside of RTL utilities (e.g., calling store methods directly)

## Common Anti-Patterns (Kent C. Dodds' Official List)

| # | Anti-Pattern | Fix |
|---|---|---|
| 1 | Not using Testing Library ESLint plugins | Install `eslint-plugin-testing-library` |
| 2 | Using `wrapper` as variable name for render result | Destructure or use `screen` |
| 3 | Manually calling `cleanup` | Remove — it's automatic |
| 4 | Not using `screen` | Always use `screen.getByRole(...)` |
| 5 | Wrong assertion (`button.disabled` instead of matcher) | Use `toBeDisabled()` |
| 6 | Wrapping everything in `act()` | Remove — `render`/`fireEvent` already handle it |
| 7 | Using `getByTestId` instead of accessible queries | Use `getByRole`, `getByText`, etc. |
| 8 | Using `container.querySelector()` | Use `screen` queries |
| 9 | Not querying by text | Query by visible text content |
| 10 | Not using `*ByRole` most of the time | `getByRole` is the default |
| 11 | Adding unnecessary `aria-`/`role` attributes | Use semantic HTML |
| 12 | Using `fireEvent` instead of `user-event` | Use `userEvent.setup()` |
| 13 | Using `query*` for existence checks | `query*` is for NON-existence only |
| 14 | Using `waitFor` instead of `findBy` | `findBy` = `waitFor` + `getBy` |
| 15 | Empty `waitFor(() => {})` callback | Put an assertion inside |
| 16 | Multiple assertions in `waitFor` | One assertion inside, rest outside |
| 17 | Side effects inside `waitFor` | Put side effects outside the callback |
| 18 | Using `get*` as implicit assertions | Always use explicit `expect()` |

## Output Format (Review Mode)

When reviewing existing tests, group findings by severity:

```
## Critical
Issues that make tests unreliable, flaky, or misleading.

### [PRINCIPLE] Brief title
**File**: `path/to/file.test.tsx` (lines X-Y)
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

## Linter

Run ESLint with Testing Library plugin:

```bash
cd app && npx eslint src/__tests__/
```

## Rules

- **Only verified claims**: every recommendation is backed by official Testing Library, Vitest, or framework documentation.
- **User perspective**: test what users see and do, not internal implementation.
- **Accessible queries first**: `getByRole` is the default; `getByTestId` is the last resort.
- **No unnecessary wrappers**: don't add `act()`, `cleanup()`, or extra abstractions.
- **Fresh state per test**: new QueryClient, reset store, clear mocks in `beforeEach`.
- **Explicit assertions**: always use `expect()` — don't rely on `getBy` throwing as an assertion.
