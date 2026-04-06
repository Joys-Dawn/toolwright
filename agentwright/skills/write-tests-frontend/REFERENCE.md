# React Frontend Testing Reference

Detailed definitions, official sources, and verified citations for each principle in this skill.

## Table of Contents

1. [Guiding Principles](#1-guiding-principles)
2. [Query Priority](#2-query-priority)
3. [Query Types](#3-query-types)
4. [User Events](#4-user-events)
5. [Vitest Mocking](#5-vitest-mocking)
6. [React Testing Library API](#6-react-testing-library-api)
7. [Zustand Testing](#7-zustand-testing)
8. [TanStack Query Testing](#8-tanstack-query-testing)
9. [Common Mistakes](#9-common-mistakes)
10. [jest-dom Matchers](#10-jest-dom-matchers)

---

## 1. Guiding Principles

**Source:** [testing-library.com/docs/guiding-principles](https://testing-library.com/docs/guiding-principles)

> "The more your tests resemble the way your software is used, the more confidence they can give you."

The library emphasizes three principles:
1. Tests should interact with DOM nodes rather than component instances
2. Utilities should encourage testing applications as users would actually use them
3. Implementations should remain simple and flexible

---

## 2. Query Priority

**Source:** [testing-library.com/docs/queries/about](https://testing-library.com/docs/queries/about)

Official order from most to least preferred:

1. **`getByRole`** — "query every element that is exposed in the accessibility tree"
2. **`getByLabelText`** — "top preference" for form fields
3. **`getByPlaceholderText`** — fallback when labels unavailable
4. **`getByText`** — for non-interactive elements outside forms
5. **`getByDisplayValue`** — for form elements with filled-in values
6. **`getByAltText`** — for elements supporting alt text
7. **`getByTitle`** — least reliable semantic option
8. **`getByTestId`** — only when other methods don't apply

---

## 3. Query Types

**Source:** [testing-library.com/docs/queries/about](https://testing-library.com/docs/queries/about)

| Type | 0 matches | 1 match | >1 matches | Async? |
|------|-----------|---------|------------|--------|
| `getBy` | Throw | Return | Throw | No |
| `queryBy` | `null` | Return | Throw | No |
| `findBy` | Throw | Return | Throw | Yes (retries up to 1000ms) |
| `getAllBy` | Throw | Array | Array | No |
| `queryAllBy` | `[]` | Array | Array | No |
| `findAllBy` | Throw | Array | Array | Yes |

---

## 4. User Events

**Source:** [testing-library.com/docs/user-event/intro](https://testing-library.com/docs/user-event/intro)

`user-event` "simulates user interactions by dispatching the events that would happen if the interaction took place in a browser."

Key difference from `fireEvent`: `user-event` "adds visibility and interactability checks along the way and manipulates the DOM just like a user interaction in the browser would."

Setup:
```ts
const user = userEvent.setup();
render(<MyComponent />);
await user.click(screen.getByRole('button'));
```

Full form interaction example:
```ts
import userEvent from '@testing-library/user-event';

it('submits the form', async () => {
  const user = userEvent.setup();
  render(<MyForm />);

  await user.type(screen.getByRole('textbox', { name: /name/i }), 'Alice');
  await user.click(screen.getByRole('button', { name: /submit/i }));

  expect(screen.getByText(/success/i)).toBeVisible();
});
```

The documentation "discourages rendering or using any `userEvent` functions outside of the test itself - e.g. in a `before`/`after` hook."

### Async Testing — `waitFor` and `findBy`

**Source:** [testing-library.com/docs/dom-testing-library/api-async](https://testing-library.com/docs/dom-testing-library/api-async)

```ts
// GOOD: findBy for elements that appear asynchronously
const heading = await screen.findByRole('heading', { name: /welcome/i });

// GOOD: waitFor for assertions that become true asynchronously
await waitFor(() => {
  expect(screen.getByText(/loaded/i)).toBeVisible();
});

// BAD: wrapping getBy in waitFor (use findBy instead)
await waitFor(() => {
  screen.getByText(/loaded/i);  // wrong — use findByText
});

// BAD: empty waitFor callback
await waitFor(() => {});  // does nothing useful

// BAD: multiple assertions in waitFor
await waitFor(() => {
  expect(a).toBe(1);
  expect(b).toBe(2);  // if a fails, b never runs — put one inside, rest outside
});

// BAD: side effects inside waitFor
await waitFor(() => {
  fireEvent.click(button);  // don't do this — put side effects outside
  expect(result).toBeVisible();
});
```

### Always Use `screen`

**Source:** Kent C. Dodds — "Common Mistakes with React Testing Library"

```ts
// GOOD
render(<MyComponent />);
expect(screen.getByRole('button')).toBeVisible();

// BAD — destructuring from render
const { getByRole } = render(<MyComponent />);
expect(getByRole('button')).toBeVisible();
```

**Why:** `screen` is always available, reduces refactoring churn, and matches the Testing Library recommended pattern.

### jest-dom Good vs Bad Examples

**Source:** [testing-library.com/docs/ecosystem-jest-dom](https://testing-library.com/docs/ecosystem-jest-dom)

```ts
// GOOD
expect(button).toBeDisabled();
expect(element).toBeVisible();
expect(element).toHaveTextContent('hello');
expect(link).toHaveAttribute('href', '/path');

// BAD — checking properties directly
expect(button.disabled).toBe(true);
expect(element.textContent).toBe('hello');
```

---

## 5. Vitest Mocking

### vi.mock() hoisting

**Source:** [vitest.dev/api/vi](https://vitest.dev/api/vi.html)

"`vi.mock` is hoisted (in other words, _moved_) to **top of the file**."

"The call to `vi.mock` is hoisted to top of the file. It will always be executed before all imports."

### vi.hoisted()

Allows side effects before static imports are evaluated. Returns the factory function's return value.

```ts
const { mockFn } = vi.hoisted(() => ({
  mockFn: vi.fn(),
}));

vi.mock('./module', () => ({ fn: mockFn }));
```

### Mock clearing methods

**Source:** [vitest.dev/api/vi](https://vitest.dev/api/vi.html)

**`vi.clearAllMocks()`** — Calls `.mockClear()` on all spies. "This will clear mock history without affecting mock implementations."

**`vi.resetAllMocks()`** — Calls `.mockReset()` on all spies. "This will clear mock history and reset each mock's implementation."

**`vi.restoreAllMocks()`** — "This restores all original implementations on spies created with `vi.spyOn`." Does NOT clear history.

#### Recommended `beforeEach` pattern

```ts
beforeEach(() => {
  vi.clearAllMocks();  // most common — clears call history between tests
});
```

### Internal vs external access warning

**Source:** [vitest.dev/guide/mocking](https://vitest.dev/guide/mocking)

"This only mocks _external_ access. In this example, if `original` calls `mocked` internally, it will always call the function defined in the module, not in the mock factory."

---

## 6. React Testing Library API

**Source:** [testing-library.com/docs/react-testing-library/api](https://testing-library.com/docs/react-testing-library/api)

### render()

Returns: `container`, `baseElement`, `debug`, `rerender`, `unmount`, `asFragment`, plus all bound queries.

Options: `container`, `baseElement`, `hydrate`, `legacyRoot`, `wrapper`, `queries`, `reactStrictMode`.

### wrapper option

"Pass a React Component as the `wrapper` option to have it rendered around the inner element. This is most useful for creating reusable custom render functions for common data providers."

### cleanup

"Unmounts React trees that were mounted with render. This is called automatically if your testing framework (such as mocha, Jest or Jasmine) injects a global `afterEach()` function."

### renderHook()

"A convenience wrapper around `render` with a custom test component." Returns `result` (with `result.current`), `rerender`, `unmount`.

### Provider Wrapper Pattern (QueryClient + MemoryRouter)

Components that use React Query, Router, or Zustand need provider wrappers:

```ts
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { createElement, type ReactNode } from 'react';

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient },
      createElement(MemoryRouter, null, children)
    );
}

// In test:
render(<MyComponent />, { wrapper: createWrapper() });

// For hooks:
renderHook(() => useMyHook(), { wrapper: createWrapper() });
```

---

## 7. Zustand Testing

**Source:** [github.com/pmndrs/zustand — docs/learn/guides/testing.md](https://github.com/pmndrs/zustand)

### Official recommendation

"We recommend using React Testing Library (RTL) to test out React components that connect to Zustand."

"We also recommend using Mock Service Worker (MSW) to mock network requests."

### Store reset pattern (Vitest)

1. Create `__mocks__/zustand.ts`:

```ts
import { act } from '@testing-library/react';
import type * as ZustandExportedTypes from 'zustand';
export * from 'zustand';

const { create: actualCreate, createStore: actualCreateStore } =
  await vi.importActual<typeof ZustandExportedTypes>('zustand');

export const storeResetFns = new Set<() => void>();

const createUncurried = <T>(
  stateCreator: ZustandExportedTypes.StateCreator<T>,
) => {
  const store = actualCreate(stateCreator);
  const initialState = store.getInitialState();
  storeResetFns.add(() => { store.setState(initialState, true); });
  return store;
};

export const create = (<T>(
  stateCreator: ZustandExportedTypes.StateCreator<T>,
) => {
  return typeof stateCreator === 'function'
    ? createUncurried(stateCreator)
    : createUncurried;
}) as typeof ZustandExportedTypes.create;

// Similar for createStore...

afterEach(() => {
  act(() => { storeResetFns.forEach((fn) => fn()); });
});
```

2. In setup file: `vi.mock('zustand');`

### Alternative: Direct `setState` in Tests

For simpler cases, set store state directly before each test:

```ts
import { useAppStore } from '../../store';

beforeEach(() => {
  useAppStore.getState().clearStore();  // if clearStore action exists
  // or
  useAppStore.setState({ key: initialValue });
});
```

### Warning

"In Vitest you can change the root. Due to that, you need make sure that you are creating your `__mocks__` directory in the right place. Let's say that you change the **root** to `./src`, that means you need to create a `__mocks__` directory under `./src`."

---

## 8. TanStack Query Testing

**Source:** TanStack Query official documentation

### Key patterns

- Create a **new `QueryClient` for each test** to prevent cache leaking
- Set `retry: false` to make failures immediate:
  ```ts
  new QueryClient({ defaultOptions: { queries: { retry: false } } })
  ```
- Provide via wrapper:
  ```ts
  const wrapper = ({ children }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
  ```

---

## 9. Common Mistakes

**Source:** [kentcdodds.com/blog/common-mistakes-with-react-testing-library](https://kentcdodds.com/blog/common-mistakes-with-react-testing-library) (Kent C. Dodds, creator of Testing Library)

1. **Not using Testing Library ESLint plugins** — Install and use them
2. **Using `wrapper` as variable name** for render result — Use `screen` or destructure
3. **Manually calling `cleanup`** — It's automatic
4. **Not using `screen`** — Always use `screen` for queries
5. **Wrong assertion** — Use jest-dom matchers like `toBeDisabled()`
6. **Wrapping in `act()` unnecessarily** — `render`/`fireEvent` already handle it
7. **Using wrong query** — Use accessible queries, not `getByTestId`
8. **Using `container.querySelector()`** — Use `screen` queries
9. **Not querying by text** — Query by visible text content
10. **Not using `*ByRole`** — It should be the primary query
11. **Adding `aria-`/`role` incorrectly** — Use semantic HTML elements
12. **Using `fireEvent` instead of `user-event`** — `userEvent.setup()` is preferred
13. **Using `query*` for existence** — `query*` is for NON-existence; use `getBy` for existence
14. **Using `waitFor` instead of `findBy`** — `findBy` = `waitFor` + `getBy`
15. **Empty `waitFor` callback** — Must contain an assertion
16. **Multiple assertions in `waitFor`** — One inside, rest outside
17. **Side effects inside `waitFor`** — Put side effects outside
18. **Using `get*` as implicit assertions** — Always use explicit `expect()`

### `act()` — When to Use It

**Source:** Kent C. Dodds — "Common Mistakes with React Testing Library"

`render()` and `fireEvent` are already wrapped in `act()`. Do NOT wrap them again.

```ts
// BAD — unnecessary act()
act(() => {
  render(<MyComponent />);
});

// GOOD — render already handles act()
render(<MyComponent />);
```

Only use `act()` when directly triggering state updates outside of RTL utilities (e.g., calling store methods directly).

### What to Test vs What NOT to Test

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

---

## 10. jest-dom Matchers

**Source:** [testing-library.com/docs/ecosystem-jest-dom](https://testing-library.com/docs/ecosystem-jest-dom)

Key matchers for DOM testing:

| Matcher | Tests for |
|---|---|
| `toBeInTheDocument()` | Element exists in DOM |
| `toBeVisible()` | Element is visible to user |
| `toBeDisabled()` / `toBeEnabled()` | Disabled state |
| `toBeChecked()` | Checkbox/radio is checked |
| `toBeRequired()` | Form element is required |
| `toBeValid()` / `toBeInvalid()` | Form validation state |
| `toBeEmptyDOMElement()` | No content |
| `toHaveTextContent(text)` | Contains text |
| `toHaveAttribute(attr, value?)` | Has HTML attribute |
| `toHaveClass(className)` | Has CSS class |
| `toHaveStyle(css)` | Has inline style |
| `toHaveValue(value)` | Form element value |
| `toHaveDisplayValue(value)` | Displayed value |
| `toHaveFocus()` | Element is focused |
| `toContainElement(element)` | Contains child element |
| `toContainHTML(html)` | Contains HTML string |
| `toHaveDescription(text)` | Has `aria-describedby` text |
| `toHaveErrorMessage(text)` | Has `aria-errormessage` text |
| `toHaveAccessibleName(name)` | Has accessible name |
| `toHaveAccessibleDescription(desc)` | Has accessible description |

### Vitest environment

**Source:** [vitest.dev/guide/features](https://vitest.dev/guide/features.html)

Vitest supports both `happy-dom` and `jsdom` for DOM mocking: "happy-dom or jsdom for DOM mocking." Configure via the `environment` option in vitest config.

"Vitest also isolates each file's environment so env mutations in one file don't affect others."
