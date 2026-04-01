# UI Audit Reference

Detailed definitions, exact requirements, and source citations for each check in the audit.

## Table of Contents

### Part 1 — Accessibility
1. [Touch Target Size](#1-touch-target-size)
2. [Modal / Dialog](#2-modal--dialog-accessibility)
3. [Focus Visibility](#3-focus-visibility)
4. [Color Contrast](#4-color-contrast)
5. [Form Labels](#5-form-label-association)
6. [Icon-Only Buttons](#6-icon-only-buttons)
7. [ARIA Widget Patterns](#7-aria-widget-patterns)
8. [Keyboard Accessibility](#8-keyboard-accessibility)
9. [Loading States](#9-loading-states)
10. [Text Size](#10-text-size)

### Part 2 — UI Structure
11. [Component Extraction](#11-component-extraction)
12. [Component Size](#12-component-size--responsibility)
13. [Layout Consistency](#13-layout-consistency)
14. [Design Tokens](#14-design-token-usage)
15. [Loading & Error Patterns](#15-loading--error-patterns)
16. [State & Hook Patterns](#16-state--hook-patterns)

### Part 3 — Animation, Performance & Platform
17. [Animation & Motion](#17-animation--motion)
18. [Images & Media](#18-images--media)
19. [Typography & Content](#19-typography--content)
20. [Content Handling & Overflow](#20-content-handling--overflow)
21. [Performance Patterns](#21-performance-patterns)
22. [Touch & Interaction](#22-touch--interaction)
23. [Navigation & URL State](#23-navigation--url-state)
24. [Dark Mode & Theming](#24-dark-mode--theming)
25. [Hydration Safety](#25-hydration-safety)
26. [Internationalization](#26-internationalization)

---

## 1. Touch Target Size

### Sources
- **WCAG 2.5.8** (AA): https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html
  - "The size of the target for pointer inputs is at least 24 by 24 CSS pixels"
- **WCAG 2.5.5** (AAA): https://www.w3.org/WAI/WCAG22/Understanding/target-size-enhanced.html
  - "The size of the target for pointer inputs is at least 44 by 44 CSS pixels"
- **Apple HIG**: https://developer.apple.com/design/human-interface-guidelines/accessibility
  - Controls must measure at least 44x44 points
- **Material Design**: https://m2.material.io/develop/web/supporting/touch-target
  - Touch targets should be at least 48x48 dp with 8dp spacing

### Which threshold to use
- **Mobile apps** (React Native, Capacitor, Expo, etc.): Enforce **44x44px** — Apple HIG (44pt) and Material Design (48dp) both require large touch targets. Use 44px as the minimum.
- **Web apps**: Enforce **24x24px** (WCAG 2.5.8 AA). The 44px mobile threshold does not apply to desktop web interfaces.

Determine the platform by checking the project's dependencies and build config before auditing.

### Tailwind mapping
- `min-h-6` = 1.5rem = 24px — web app minimum
- `min-h-11` = 2.75rem = 44px — mobile app minimum
- `h-6` (24px), `h-8` (32px), `h-10` (40px), `h-11` (44px)

Padding on small text (`text-sm`/`text-xs`, ~20px line-height):
- `py-0.5` (2px * 2) → ~24px total height — meets web minimum only
- `py-1` (4px * 2) → ~28px total height
- `py-1.5` (6px * 2) → ~32px total height
- `py-2` (8px * 2) → ~36px total height
- `py-2.5` (10px * 2) → ~40px total height
- `py-3` (12px * 2) → ~44px total height — meets mobile minimum

### Common undersized patterns
- Toggle/switch components: the clickable area (not just the visual track) must meet the platform minimum
- Close buttons (especially bare `x` character): must have padding to reach the platform minimum

### Exceptions (WCAG 2.5.5)
1. **Inline**: target is in a sentence or constrained by line-height of surrounding text
2. **Equivalent**: function available through a different control meeting the size requirement
3. **User agent control**: size determined by browser, not author
4. **Essential**: specific presentation is essential to the information

---

## 2. Modal / Dialog Accessibility

### Source
- **WAI-ARIA APG — Dialog (Modal) Pattern**: https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/

### Required attributes
| Attribute | Element | Requirement |
|-----------|---------|-------------|
| `role="dialog"` | Container | Identifies the element as a dialog |
| `aria-modal="true"` | Container | Tells assistive tech content behind is inert |
| `aria-labelledby` | Container | Points to the dialog's visible title element |
| `aria-label` | Container | Alternative when no visible title exists |
| `aria-describedby` | Container | Optional — points to descriptive content |

### Focus management (from APG)
1. **On open**: focus moves to an element inside the dialog
   - If content is primarily semantic (text): focus a static element at the top with `tabindex="-1"`
   - If content has a primary action: focus that action button
   - If destructive: focus the least destructive option
2. **Focus trap**: Tab cycles forward; Shift+Tab cycles backward; both wrap within dialog
3. **On close**: focus returns to the triggering element (unless it no longer exists)

### Keyboard
- **Escape**: closes the dialog
- **Tab**: moves to next focusable element within dialog (wraps)
- **Shift+Tab**: moves to previous focusable element (wraps)

### Common violations
- `role="presentation"` instead of `role="dialog"` — screen readers don't recognize it as a dialog
- No focus trap — Tab key escapes behind the overlay
- No auto-focus on open — focus stays on the trigger behind the modal
- No focus restoration on close — focus drops to `<body>`

---

## 3. Focus Visibility

### Source
- **WCAG 2.4.7** (AA): https://www.w3.org/WAI/WCAG22/Understanding/focus-visible.html
  - "Any keyboard operable user interface has a mode of operation where the keyboard focus indicator is visible."
- **WCAG 2.4.13** (AAA): https://www.w3.org/WAI/WCAG22/Understanding/focus-appearance.html
  - Focus indicator area: at least as large as a 2px thick perimeter of the unfocused component
  - Focus indicator contrast: at least 3:1 between focused and unfocused states

### Practical implementation
Every interactive element needs a visible focus style. In Tailwind:
```jsx
// Good — focus-visible only shows on keyboard navigation
<button className="focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary">

// Bad — no focus style at all
<button className="bg-primary text-white">

// Bad — outline removed without replacement
<button className="outline-none">

// Bad — :focus shows ring on mouse click too (noisy)
<button className="focus:ring-2 focus:ring-primary">
```

Use `focus-visible` (not `focus`) to avoid showing focus rings on mouse clicks while preserving them for keyboard navigation.

### Compound controls
Use `:focus-within` to highlight the container when any child is focused:
```jsx
// Input group — highlight wrapper when input or button is focused
<div className="flex border focus-within:ring-2 focus-within:ring-primary">
  <input className="flex-1 outline-none" />
  <button>Search</button>
</div>
```

---

## 4. Color Contrast

### Source
- **WCAG 1.4.3** (AA): https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html
  - Normal text: at least **4.5:1**
  - Large text (>= 18pt / >= 14pt bold): at least **3:1**
  - Large text ≈ 24px regular / 18.66px bold
- **WCAG 1.4.11** (AA): https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html
  - UI components and graphical objects: at least **3:1**

### Exemptions
- Inactive (disabled) components
- Purely decorative elements
- Logotypes

### Common Tailwind violations
- `text-disabled` at `rgba(255,255,255,0.3)` on dark bg ≈ 2.5:1 (fails 4.5:1)
- Stacked opacity: `bg-surface/50 opacity-60` compounds two reductions
- `placeholder:text-muted` if muted color is too faint

---

## 5. Form Accessibility

### Sources
- **WCAG 1.3.1** (A): https://www.w3.org/WAI/WCAG22/Understanding/info-and-relationships.html
  - "Information, structure, and relationships conveyed through presentation can be programmatically determined or are available in text."
- **WCAG 4.1.2** (A): https://www.w3.org/WAI/WCAG22/Understanding/name-role-value.html
  - "For all user interface components, the name and role can be programmatically determined"
- **React docs**: https://legacy.reactjs.org/docs/accessibility.html
  - "Every HTML form control, such as `<input>` and `<textarea>`, needs to be labeled accessibly."
- **Web Interface Guidelines — Forms**: https://github.com/vercel-labs/web-interface-guidelines

### Valid labeling techniques
1. `<label htmlFor="name">Name</label> <input id="name" />`
2. `<input aria-label="Search" />`
3. `<input aria-labelledby="heading-id" />`

### NOT valid
- `<input placeholder="Name" />` alone — placeholder disappears on input, not a reliable label
- A `<span>` visually positioned near the input but not programmatically connected

### Input types and autocomplete
```jsx
// Good — correct type enables mobile keyboard and browser validation
<input type="email" autoComplete="email" name="email" />
<input type="tel" autoComplete="tel" name="phone" />
<input type="url" name="website" />

// Good — inputmode for fine-grained control
<input type="text" inputMode="numeric" pattern="[0-9]*" />

// Good — disable spellcheck on non-prose fields
<input type="email" spellCheck={false} />
<input type="text" name="invite-code" spellCheck={false} />

// Bad — blocks password managers and assistive tech
<input onPaste={(e) => e.preventDefault()} />

// Good — autocomplete off on non-auth fields to prevent password manager triggers
<input type="text" name="search" autoComplete="off" />
```

### Form behavior patterns
```jsx
// Good — submit button with loading state
<button type="submit" disabled={isSubmitting}>
  {isSubmitting ? <Spinner /> : 'Save'}
</button>

// Good — inline error + focus first error
const onSubmit = () => {
  const errors = validate(fields)
  if (errors.length) {
    document.getElementById(errors[0].field)?.focus()
  }
}

// Good — unsaved changes warning
useEffect(() => {
  if (!isDirty) return
  const handler = (e: BeforeUnloadEvent) => e.preventDefault()
  window.addEventListener('beforeunload', handler)
  return () => window.removeEventListener('beforeunload', handler)
}, [isDirty])
```

### Checkbox/radio hit targets
Label and control must share a single clickable area — no dead zones between them:
```jsx
// Good — wrapping label, entire area is clickable
<label className="flex items-center gap-2 cursor-pointer">
  <input type="checkbox" />
  <span>Accept terms</span>
</label>

// Bad — gap between label and checkbox is not clickable
<input type="checkbox" id="terms" />
<label htmlFor="terms" className="ml-4">Accept terms</label>
```

---

## 6. Icon-Only Buttons

### Source
- **WCAG 1.1.1** (A): https://www.w3.org/WAI/WCAG22/Understanding/non-text-content.html
  - "All non-text content that is presented to the user has a text alternative that serves the equivalent purpose"
  - For controls: "it has a name that describes its purpose"

### Implementation
```jsx
// Good — aria-label on button
<button aria-label="Close dialog"><XIcon aria-hidden="true" /></button>

// Good — sr-only text
<button><XIcon aria-hidden="true" /><span className="sr-only">Close dialog</span></button>

// Bad — no accessible name
<button><XIcon /></button>

// Bad — icon has name but button doesn't (redundant, confusing)
<button><XIcon aria-label="close" /></button>
```

The accessible name belongs on the **button**, not on the icon inside it. Icons inside labeled buttons should be `aria-hidden="true"`.

---

## 7. ARIA Widget Patterns

### Tabs
**Source**: https://www.w3.org/WAI/ARIA/apg/patterns/tabs/

| Role/Attribute | Element | Required |
|---------------|---------|----------|
| `role="tablist"` | Container | Yes |
| `aria-label` or `aria-labelledby` | Tablist | Yes |
| `role="tab"` | Each tab button | Yes |
| `aria-selected="true"/"false"` | Each tab | Yes |
| `aria-controls` | Each tab | Yes — points to its panel |
| `role="tabpanel"` | Each panel | Yes |
| `aria-labelledby` | Each panel | Yes — points to its tab |
| `tabindex="0"` | Active tab + panel | Yes (if panel has no focusable content) |

**Keyboard**: Left/Right arrows move between tabs (wrap); Tab moves to panel content; Home/End to first/last (optional).

### Menu Button
**Source**: https://www.w3.org/WAI/ARIA/apg/patterns/menu-button/

| Role/Attribute | Element | Required |
|---------------|---------|----------|
| `aria-haspopup="menu"` | Button | Yes |
| `aria-expanded="true"/"false"` | Button | Yes |
| `role="menu"` | Menu container | Yes |
| `role="menuitem"` | Each item | Yes |

**Keyboard**: Enter/Space opens and focuses first item; Down Arrow opens and focuses first item; Up Arrow opens and focuses last item; Escape closes.

### Alert
**Source**: https://www.w3.org/WAI/ARIA/apg/patterns/alert/

- Use `role="alert"` for error messages and urgent notifications
- Alerts do not move keyboard focus
- Avoid auto-dismissing alerts (WCAG 2.2.3)
- For non-urgent status: use `aria-live="polite"` instead

### Status Messages
**Source**: WCAG 4.1.3 (AA) — https://www.w3.org/WAI/WCAG22/Understanding/status-messages.html
- "Status messages can be programmatically determined through role or properties such that they can be presented to the user by assistive technologies without receiving focus."
- Use `role="status"` (implicitly `aria-live="polite"`) for non-urgent updates

---

## 8. Keyboard Accessibility

### Source
- **WCAG 2.1.1** (A): https://www.w3.org/WAI/WCAG22/Understanding/keyboard.html
  - "All functionality of the content is operable through a keyboard interface without requiring specific timings for individual keystrokes"

### Custom interactive elements
When using non-semantic elements as interactive controls:
```jsx
// Bad — keyboard users can't interact
<div onClick={handleClick}>Click me</div>

// Good — full keyboard support
<div
  role="button"
  tabIndex={0}
  onClick={handleClick}
  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleClick(); } }}
>
  Click me
</div>

// Best — use a real button
<button onClick={handleClick}>Click me</button>
```

### Hover-only patterns
```jsx
// Bad — invisible to keyboard users
<div className="opacity-0 group-hover:opacity-100">
  <button>Options</button>
</div>

// Good — visible on focus too
<div className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100">
  <button>Options</button>
</div>
```

---

## 9. Loading States

### Sources
- **WCAG 4.1.3** (AA): https://www.w3.org/WAI/WCAG22/Understanding/status-messages.html
- **React Suspense docs**: https://react.dev/reference/react/Suspense
  - "Don't put a Suspense boundary around every component. Suspense boundaries should not be more granular than the loading sequence that you want the user to experience."
  - "Replacing visible UI with a fallback creates a jarring user experience."

### Rules
1. Never `return null` during loading — show a spinner, skeleton, or placeholder
2. Use `aria-busy="true"` on containers that are loading content
3. Use `aria-live="polite"` on regions that update dynamically
4. Use `startTransition` when updating already-visible content to avoid replacing it with a loading fallback

---

## 10. Text Size

### Source
- **WCAG 1.4.4** (AA): https://www.w3.org/WAI/WCAG22/Understanding/resize-text.html
  - "Text can be resized without assistive technology up to 200 percent without loss of content or functionality."
  - **No minimum font size is specified by WCAG.**

### Best practice (NOT WCAG)
- Body: 16px recommended baseline
- Secondary: 12px practical minimum
- Below 12px: readability concern, especially mobile
- Tailwind `text-xs` = 12px = acceptable
- `text-[10px]`, `text-[9px]` = flag as Warning

---

## 11. Component Extraction

### Sources
- **Tailwind docs — Reusing Styles**: https://tailwindcss.com/docs/reusing-styles
  - "If you need to reuse some styles across multiple files, the best strategy is to create a component if you're using a front-end framework like React."
  - On same-file duplication: "the easiest way to deal with it is to use multi-cursor editing"
- **Kent C. Dodds — AHA Programming**: https://kentcdodds.com/blog/aha-programming
  - "After you've got a few places where that code is running, the commonalities will scream at you for abstraction"

### Extraction threshold
- **3+ identical patterns across 2+ files** = extract to a shared component
- **Same file**: fine — use multi-cursor (Tailwind guidance)
- **1-2 occurrences**: too early to extract (AHA principle)

### Do NOT flag
- Long class strings appearing once (Tailwind by-design)
- Structural classes that naturally repeat (`flex items-center gap-2`)

---

## 12. Component Size & Responsibility

### Sources
- **React docs — Thinking in React**: https://react.dev/learn/thinking-in-react
- **Robert C. Martin — Single Responsibility Principle**

### Guidelines
- ~200 lines total = consider splitting
- ~50 lines of JSX return = consider extracting subcomponents
- SRP heuristic: a component's purpose should be describable in one sentence without "and"
- Business logic (API calls, optimistic updates) belongs in custom hooks, not inline in render

---

## 13. Layout Consistency

### Sources
- **Radix Themes — Layout**: https://www.radix-ui.com/themes/docs/overview/layout
  - "Container's sole responsibility is to provide a consistent max-width to the content it wraps"
- **CSS-Tricks — Magic Numbers in CSS**: https://css-tricks.com/magic-numbers-in-css/
  - "Magic numbers in CSS refer to values which 'work' under some circumstances but are fragile and prone to break when those circumstances change"

### Rules
- Max-width should be set once in a layout wrapper, not repeated per-screen
- `calc(100vh - 140px)` is a magic number — breaks when header/footer changes. Use flex layout instead.
- Page-level padding should come from the layout component, not individual pages

---

## 14. Design Token Usage

### Sources
- **Tailwind docs — Theme**: https://tailwindcss.com/docs/theme
- **Robert C. Martin — Clean Code, Chapter 17**: numbers other than 0 and 1 should be named constants

### Rules
- Colors must come from theme tokens, never hardcoded hex/rgb
- If an arbitrary Tailwind value (`text-[14px]`) appears in 2+ files, extract to a token
- Timeouts, thresholds, sizes used in logic should be named constants

---

## 15. Loading & Error Patterns

### Sources
- **React Suspense docs**: https://react.dev/reference/react/Suspense
- **React Error Boundaries**: https://react.dev/reference/react/Component#catching-rendering-errors-with-an-error-boundary

### Rules
- `.catch(() => {})` on user-initiated actions = swallowed error. User needs feedback.
- `.catch(() => {})` on background/best-effort operations = acceptable (auto-sync, prefetch)
- Every data-fetching section should have error boundary coverage
- Consistent loading patterns across screens

---

## 16. State & Hook Patterns

### Source
- **React docs — Reusing Logic with Custom Hooks**: https://react.dev/learn/reusing-logic-with-custom-hooks

### Verified quotes from React docs
- "Extracting a `useFormInput` Hook to wrap a single `useState` call like earlier is probably unnecessary."
- "However, whenever you write an Effect, consider whether it would be clearer to also wrap it in a custom Hook."
- "If your function doesn't call any Hooks, avoid the `use` prefix."
- "Custom Hooks let you share stateful logic but not state itself. Each call to a Hook is completely independent from every other call to the same Hook."
- "Keep your custom Hooks focused on concrete high-level use cases."

### Anti-patterns
- `useMount()`, `useEffectOnce()`, `useUpdateEffect()` — lifecycle wrappers that add indirection
- `useValue()` wrapping a single `useState` — no benefit over direct `useState`
- `useSorted(items)` when the function doesn't call any hooks — just make it `getSorted(items)`

---

## 17. Animation & Motion

### Sources
- **WCAG 2.3.3** (AAA): https://www.w3.org/WAI/WCAG22/Understanding/animation-from-interactions.html
  - "Motion animation triggered by interaction can be disabled, unless the animation is essential to the functionality or the information being conveyed."
- **Web Interface Guidelines — Animation**: https://github.com/vercel-labs/web-interface-guidelines

### Compositor-friendly properties
Only `transform` and `opacity` run on the GPU compositor thread. Animating layout properties (`width`, `height`, `top`, `left`, `margin`, `padding`) triggers layout recalculation on every frame.

```css
/* Good — compositor only */
transition: transform 200ms ease-out, opacity 200ms ease-out;

/* Bad — triggers layout */
transition: all 300ms ease;
transition: width 300ms ease, height 300ms ease;
```

### prefers-reduced-motion
```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
```

Tailwind: `motion-reduce:transition-none` or `motion-reduce:animate-none`

### SVG animation
Apply transforms on a `<g>` wrapper, not directly on shape elements:
```jsx
<g style={{ transformBox: 'fill-box', transformOrigin: 'center' }}>
  <rect className="transition-transform hover:scale-110" />
</g>
```

---

## 18. Images & Media

### Sources
- **Web Core Vitals — CLS**: https://web.dev/cls/
  - Images without dimensions are the #1 cause of Cumulative Layout Shift
- **Web Interface Guidelines — Images**: https://github.com/vercel-labs/web-interface-guidelines

### Dimension requirements
```jsx
// Good — explicit dimensions prevent layout shift
<img src="/photo.jpg" width={800} height={600} alt="Team photo" />

// Good — Next.js Image with priority for above-fold
<Image src="/hero.jpg" width={1200} height={630} priority alt="Hero" />

// Bad — no dimensions, causes CLS
<img src="/photo.jpg" alt="Team photo" />
```

### Loading strategy
| Position | Attribute | Effect |
|----------|-----------|--------|
| Above fold | `priority` (Next.js) or `fetchpriority="high"` | Preloaded, no lazy |
| Below fold | `loading="lazy"` | Deferred until near viewport |

---

## 19. Typography & Content

### Source
- **Web Interface Guidelines — Typography, Content & Copy**: https://github.com/vercel-labs/web-interface-guidelines

### Character replacements
| Bad | Good | Rule |
|-----|------|------|
| `...` | `…` (U+2026) | Single ellipsis character |
| `"text"` | `"text"` (U+201C/U+201D) | Curly/smart quotes |
| `10 MB` | `10&nbsp;MB` | Non-breaking space for units |
| `Cmd K` | `⌘&nbsp;K` | Non-breaking space for shortcuts |

### Tailwind utilities
- `tabular-nums` — fixed-width numerals for aligned columns, prices, countdowns
- `text-balance` — `text-wrap: balance` on headings (equal line lengths)
- `text-pretty` — `text-wrap: pretty` on body text (prevents orphan last word)

### Copy rules
- Active voice: "Install the CLI" not "The CLI will be installed"
- Specific button labels: "Save API Key" not "Continue"
- Error messages include a fix or next step, not just the problem
- Numerals for counts: "8 deployments" not "eight"
- Loading states end with `…`: "Loading…", "Saving…"

---

## 20. Content Handling & Overflow

### Source
- **Web Interface Guidelines — Content Handling**: https://github.com/vercel-labs/web-interface-guidelines

### Overflow patterns
```jsx
// Truncate single line
<p className="truncate">Very long text...</p>

// Clamp to N lines
<p className="line-clamp-2">Multi-line text that gets cut off...</p>

// Break long words (URLs, hashes)
<p className="break-words">https://very-long-url.example.com/path/to/thing</p>
```

### Flex truncation gotcha
Flex children don't shrink below their content width by default:
```jsx
// Bad — text won't truncate
<div className="flex">
  <span className="truncate">Long text</span>
</div>

// Good — min-w-0 allows shrinking
<div className="flex">
  <span className="min-w-0 truncate">Long text</span>
</div>
```

### Empty state handling
Always handle empty arrays/strings — don't render a broken list or empty card:
```jsx
// Bad — renders empty <ul> or broken layout
<ul>{items.map(i => <li key={i.id}>{i.name}</li>)}</ul>

// Good — explicit empty state
{items.length > 0 ? (
  <ul>{items.map(i => <li key={i.id}>{i.name}</li>)}</ul>
) : (
  <EmptyState message="No items yet" />
)}
```

---

## 21. Performance Patterns

### Sources
- **Web Interface Guidelines — Performance**: https://github.com/vercel-labs/web-interface-guidelines
- **Web Core Vitals — INP**: https://web.dev/inp/

### Virtualization
For lists >50 items, rendering all DOM nodes degrades scroll performance and memory:
```jsx
// Using virtua (lightweight)
import { VList } from 'virtua';

<VList style={{ height: 400 }}>
  {items.map(item => <Row key={item.id} item={item} />)}
</VList>
```

Alternative: CSS `content-visibility: auto` for simpler cases (browser skips rendering off-screen items).

### Layout thrashing in React
These APIs force synchronous layout when called in render:
- `getBoundingClientRect()`
- `offsetHeight`, `offsetWidth`, `offsetTop`, `offsetLeft`
- `scrollTop`, `scrollHeight`, `clientHeight`
- `getComputedStyle()`

Move to `useLayoutEffect` or `ResizeObserver` — never call in the render path.

### Resource hints
```html
<!-- Preconnect to CDN/API domains -->
<link rel="preconnect" href="https://cdn.example.com" />

<!-- Preload critical fonts -->
<link rel="preload" href="/fonts/inter.woff2" as="font" type="font/woff2" crossorigin />
```

Font loading: use `font-display: swap` to prevent invisible text during font load.

---

## 22. Touch & Interaction

### Source
- **Web Interface Guidelines — Touch & Interaction**: https://github.com/vercel-labs/web-interface-guidelines

### touch-action: manipulation
Eliminates the 300ms delay on double-tap-to-zoom:
```css
/* Apply to interactive elements or globally */
button, a, [role="button"] {
  touch-action: manipulation;
}
```

### Scroll containment
Prevent background scroll when modal/drawer is open:
```css
.modal {
  overscroll-behavior: contain;
}
```

### Drag operations
During drag: disable text selection to prevent accidental highlighting, and mark dragged element as `inert`:
```jsx
<div
  draggable
  onDragStart={() => document.body.style.userSelect = 'none'}
  onDragEnd={() => document.body.style.userSelect = ''}
/>
```

### autoFocus
- Desktop only, single primary input per page
- Avoid on mobile — causes viewport to scroll to the input and keyboard to appear immediately
- Always needs clear justification

---

## 23. Navigation & URL State

### Source
- **Web Interface Guidelines — Navigation & State**: https://github.com/vercel-labs/web-interface-guidelines

### URL-driven state
UI state that should be in the URL (shareable, bookmarkable, back-button friendly):
- Active tab
- Filters and sort order
- Pagination / page number
- Expanded panels or modal open state
- Search query

If a component uses `useState` for view state, consider whether it should be URL-synced (e.g., via `nuqs`, `next/navigation` searchParams, or `URLSearchParams`).

### Link behavior
- Navigation must use `<a>` or `<Link>` — supports Cmd/Ctrl+click (new tab), middle-click, right-click copy
- `<div onClick={() => router.push(...)}` breaks all native link behavior

### Destructive actions
Never fire immediately on click. Require either:
- Confirmation modal ("Are you sure you want to delete?")
- Undo window (toast with "Undo" action, 5–10s delay before actual deletion)

---

## 24. Dark Mode & Theming

### Source
- **Web Interface Guidelines — Dark Mode & Theming**: https://github.com/vercel-labs/web-interface-guidelines

### color-scheme
```html
<!-- Tells the browser this page uses a dark theme -->
<html style="color-scheme: dark">
```
Without this, native elements (scrollbars, form inputs, `<select>`) render in light mode even on a dark page.

### theme-color
```html
<meta name="theme-color" content="#0a0a0a" />
```
Sets the browser chrome (address bar, tab bar) color on mobile. Should match the page background.

### Windows dark mode `<select>` fix
Native `<select>` on Windows renders white text on white background in dark mode unless explicit colors are set:
```css
select {
  background-color: var(--bg);
  color: var(--fg);
}
```

---

## 25. Hydration Safety

### Sources
- **React docs — Hydration**: https://react.dev/reference/react-dom/client/hydrateRoot
- **Web Interface Guidelines — Hydration Safety**: https://github.com/vercel-labs/web-interface-guidelines

### Controlled vs uncontrolled inputs
```jsx
// Hydration error — value without onChange
<input value={text} />

// Good — controlled
<input value={text} onChange={(e) => setText(e.target.value)} />

// Good — uncontrolled
<input defaultValue={text} />
```

### Date/time hydration mismatch
Server renders in UTC; client renders in local timezone. This causes hydration mismatch:
```jsx
// Bad — different output on server vs client
<span>{new Date().toLocaleString()}</span>

// Good — defer to client
const [time, setTime] = useState<string>()
useEffect(() => { setTime(new Date().toLocaleString()) }, [])
<span suppressHydrationWarning>{time ?? ''}</span>
```

Use `suppressHydrationWarning` only on the specific element, not as a blanket wrapper.

---

## 26. Internationalization

### Source
- **Web Interface Guidelines — Locale & i18n**: https://github.com/vercel-labs/web-interface-guidelines

### Date formatting
```jsx
// Bad — hardcoded format, breaks in non-US locales
<span>{`${date.getMonth()+1}/${date.getDate()}/${date.getFullYear()}`}</span>

// Good — locale-aware
<span>{new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(date)}</span>
```

### Number formatting
```jsx
// Bad — hardcoded separator and currency
<span>${price.toFixed(2)}</span>

// Good — locale-aware
<span>{new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(price)}</span>
```

### Language detection
- Use `Accept-Language` header (server) or `navigator.languages` (client)
- Never infer language from IP address (VPNs, expats, multilingual users)
