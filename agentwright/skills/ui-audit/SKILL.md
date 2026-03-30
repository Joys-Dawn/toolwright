---
name: ui-audit
description: Use after any UI edit, when reviewing UI components, or when asked for an accessibility or structure audit. Triggers on WCAG 2.2 violations, WAI-ARIA APG pattern issues, touch target sizing, focus management, component duplication, or separation of concerns problems in React/Tailwind code.
---

# UI Audit — Accessibility & Structure

Audit React/Tailwind UI code for accessibility violations and structural anti-patterns. Every finding must cite the specific standard (WCAG SC, WAI-ARIA APG pattern, platform guideline) so the developer knows the authoritative source.

See [REFERENCE.md](REFERENCE.md) for detailed standard definitions, exact requirements, and code examples.

## Scope

Determine what to audit based on context:

- **Git diff mode** (default when no scope specified and changes exist): run `git diff` and `git diff --cached` to audit only changed/added UI code (`.tsx`, `.css` files)
- **File/directory mode**: audit the files or directories the user specifies
- **Full audit mode**: when the user asks for a full UI audit, scan the project's `src/` directory (skip node_modules, build artifacts, test files)

Read all in-scope code before producing findings.

## Part 1 — Accessibility

Evaluate against each check. Skip checks with no findings.

### 1. Touch Target Size

**Standards**: WCAG 2.5.5 (AAA) — 44x44 CSS px; WCAG 2.5.8 (AA) — 24x24 CSS px; Apple HIG — 44x44 pt; Material Design — 48x48 dp

This project targets mobile (future native app). Enforce **44x44px minimum** (Tailwind `min-h-11` = 2.75rem = 44px at 16px root).

**What to check**:
- Every `<button>`, `<a>`, `<input>`, `<select>`, clickable `<div>`/`<li>`, and icon button must produce a tap target of at least 44x44px
- Padding classes that produce heights below 44px on small text: `py-0.5` (~24px), `py-1` (~28px), `py-1.5` (~32px), `py-2` (~36px) on `text-sm`/`text-xs` elements
- Toggle/switch components: the clickable area (not just the visual track) must be 44x44px
- Close buttons (especially bare `x` character): must have padding to reach 44x44px

**Exceptions** (per WCAG 2.5.5):
- Inline links within a sentence or block of text
- Size determined entirely by the user agent
- Equivalent control on the same page meets the size requirement
- Specific presentation is essential to the information being conveyed

### 2. Modal / Dialog Accessibility

**Standard**: WAI-ARIA APG — Dialog (Modal) Pattern

**What to check** (see REFERENCE.md §2 for full attribute table and focus management specs):
- Container has `role="dialog"`, `aria-modal="true"`, and `aria-labelledby` or `aria-label`
- Focus moves into the dialog on open and is trapped (Tab/Shift+Tab cycle within)
- Focus returns to the triggering element on close
- Escape key closes the dialog

**Violations to flag**:
- `role="presentation"` on a modal container
- No focus trap, no focus restoration, missing label

### 3. Focus Visibility

**Standard**: WCAG 2.4.7 (AA) — "Any keyboard operable user interface has a mode of operation where the keyboard focus indicator is visible."

**What to check**:
- Every interactive element (`<button>`, `<a>`, `<input>`, `<select>`, `[role="button"]`, `[role="tab"]`, `[tabindex]`) must have a visible focus indicator
- Look for `focus-visible:outline`, `focus-visible:ring`, `focus:ring`, or equivalent
- If NO interactive elements in scope have focus styles, flag as a blanket issue
- Custom components wrapping `<div onClick>` need `tabIndex={0}` AND a focus style
- Use `:focus-visible` over `:focus` — avoids showing focus rings on mouse clicks
- `outline-none` / `outline: none` without a `:focus-visible` replacement = violation
- `:focus-within` for compound controls (e.g., input + button group)

### 4. Color Contrast

**Standard**: WCAG 1.4.3 (AA) — Contrast (Minimum)

**Required ratios**:
- Normal text (< 18pt or < 14pt bold): **4.5:1**
- Large text (>= 18pt or >= 14pt bold): **3:1**
- UI components and graphical objects (WCAG 1.4.11 AA): **3:1**

**What to check**:
- Low-opacity text: `opacity-30`, `opacity-40`, or equivalent — compute effective contrast
- Stacked opacity (e.g., `bg-surface/50 opacity-60`) — compound reduction likely fails
- Placeholder text colors
- Note: WCAG 1.4.3 exempts "inactive" (disabled) UI components from contrast requirements

### 5. Form Accessibility

**Standards**: WCAG 1.3.1 (A) — Info and Relationships; WCAG 4.1.2 (A) — Name, Role, Value; Web Interface Guidelines — Forms

**Label association** — every `<input>`, `<select>`, `<textarea>` must have ONE of:
- A `<label>` with `htmlFor` matching the input's `id`
- `aria-label` on the input
- `aria-labelledby` pointing to a visible label element
- Visible label text NOT programmatically connected = violation
- `placeholder` alone is NOT a label (it disappears on input)

**Input types and attributes**:
- Correct `type` attribute: `email`, `tel`, `url`, `number` — enables mobile keyboards and browser validation
- `inputmode` for fine-grained keyboard control where `type` doesn't fit
- `autocomplete` with meaningful values on form fields (browser autofill, password managers)
- `autocomplete="off"` on non-auth fields to avoid password manager triggers
- `spellCheck={false}` on emails, codes, usernames

**Form behavior**:
- Never block paste (`onPaste` + `preventDefault`) — accessibility and password manager violation
- Submit button stays enabled until request starts; show spinner during request
- Errors inline next to fields; focus first error on submit
- Checkboxes/radios: label + control share single hit target (no dead zones between them)
- Warn before navigation with unsaved changes (`beforeunload` or router guard)

### 6. Icon-Only Buttons

**Standards**: WCAG 1.1.1 (A) — "All non-text content that is presented to the user has a text alternative that serves the equivalent purpose"; WCAG 4.1.2 (A) — Name, Role, Value

**What to check**:
- Every button/link containing only an icon (SVG, icon component, single character like `x`) must have:
  - `aria-label` describing the action, OR
  - `<span className="sr-only">` with descriptive text
- Icons inside buttons with visible text should have `aria-hidden="true"`

### 7. ARIA Widget Patterns

**Standard**: WAI-ARIA APG

**What to check** (see REFERENCE.md §7 for full attribute tables and keyboard specs):
- **Tabs**: tablist/tab/tabpanel roles, `aria-selected`, `aria-controls`/`aria-labelledby` linkage, arrow key navigation
- **Menu buttons**: `aria-haspopup`, `aria-expanded`, menu/menuitem roles, Enter/Space/Arrow/Escape keyboard
- **Alerts**: `role="alert"` for urgent, `aria-live="polite"` for non-urgent, no auto-dismiss (WCAG 2.2.3)

### 8. Semantic HTML & Keyboard Accessibility

**Standard**: WCAG 2.1.1 (A) — "All functionality of the content is operable through a keyboard interface"

**Semantic HTML first**:
- `<button>` for actions, `<a>`/`<Link>` for navigation — never `<div onClick>` for either
- Use semantic elements (`<button>`, `<a>`, `<label>`, `<table>`, `<nav>`, `<main>`, `<header>`) before reaching for ARIA roles
- Headings hierarchical `<h1>`–`<h6>` — don't skip levels
- Include a skip link for main content on pages with navigation
- Decorative icons must have `aria-hidden="true"`
- Images need `alt` (or `alt=""` if decorative)

**Keyboard support for custom elements**:
- Clickable non-interactive elements (`<div onClick>`, `<li onClick>`, `<span onClick>`) must have:
  - `role="button"` (or appropriate role)
  - `tabIndex={0}`
  - `onKeyDown` handler (Enter and Space should activate)
- Context menus, dropdowns, popovers: closeable with Escape
- Hover-only interactions (`opacity-0 group-hover:opacity-100` on buttons): invisible to keyboard — must add `group-focus-within:opacity-100`

### 9. Loading States

**Standard**: WCAG 4.1.3 (AA) — "Status messages can be programmatically determined through role or properties such that they can be presented to the user by assistive technologies without receiving focus"; React Suspense docs

**What to check**:
- Components that `return null` during loading = blank screen with no feedback — always show a loading indicator
- Dynamic content regions that update should use `aria-live` or `role="status"` to announce changes
- React Suspense docs: "Don't put a Suspense boundary around every component. Suspense boundaries should not be more granular than the loading sequence that you want the user to experience."
- React Suspense docs: "Replacing visible UI with a fallback creates a jarring user experience" — use `startTransition` for updates to already-visible content

### 10. Text Size

**Important**: WCAG has NO minimum font size requirement. WCAG 1.4.4 (AA) requires text to be resizable to 200% without loss of content — not a minimum size.

**Best practice** (Apple HIG, Material Design, general UX):
- Body text: 16px recommended
- Secondary/caption text: 12px practical minimum
- Text below 12px (`text-[10px]`, `text-[9px]`) is a readability concern, especially on mobile

**Severity**: Warning (best practice), never Critical. Always note this is NOT a WCAG requirement.

## Part 2 — UI Structure

### 11. Component Extraction (DRY)

**Sources**: Tailwind docs — "Reusing Styles"; Kent C. Dodds — AHA Programming (see REFERENCE.md §11 for full quotes)

**What to check**:
- Same Tailwind class combination (5+ utility classes forming one visual pattern) appearing 3+ times across different files — extract to a shared component
- Common extraction candidates: Button variants, Card, Input, Badge, Modal close button
- Utility style patterns (e.g., focus rings) repeated 10+ times — bake into base components

**Threshold**: 3+ identical patterns across 2+ files = extract. Duplication within a single file is fine.

**Do NOT flag**:
- Single-use class combinations, even if long (this is Tailwind by-design)
- Structural Tailwind classes that naturally repeat (`flex items-center gap-2`)

### 12. Component Size & Responsibility

**Sources**: React docs — "Thinking in React"; Robert C. Martin — Single Responsibility Principle

SRP heuristic: a component's purpose should be describable in one sentence without "and."

**What to check**:
- Components exceeding ~200 lines — likely multiple responsibilities
- JSX return exceeding ~50 lines — consider splitting into subcomponents
- Business logic (API calls, optimistic updates, complex state transforms) inline in render components — extract to custom hooks
- Inline event handlers exceeding ~10 lines — extract to named functions or hooks
- Multiple unrelated `useState`/`useEffect` clusters in one component

### 13. Layout Consistency

**What to check**:
- Individual screens overriding the app-level layout constraint (e.g., screen sets `max-w-lg` when layout uses `max-w-2xl`)
- Hardcoded heights with `calc()` and magic numbers (`calc(100vh - 140px)`) — use flex/grid layout instead; these break when surrounding layout changes
- Inconsistent page-level spacing (one screen `p-4`, another `p-6` for the same structural role)

### 14. Design Token Usage

**Source**: Tailwind docs — Theme configuration

**What to check**:
- Hardcoded hex colors (`#1a1a2e`, `rgb(...)`, inline `style={{ color: '...' }}`) bypassing the project's CSS custom properties / Tailwind theme
- Hardcoded pixel values for spacing/sizing that should use Tailwind's scale
- Magic numbers for timeouts, thresholds, row heights, page sizes — should be named constants (Clean Code Ch. 17: numbers other than 0 and 1 should be named)

### 15. Loading & Error Patterns

**Sources**: React Suspense docs; React docs — Error Boundaries

**What to check**:
- `.catch(() => {})` on user-initiated actions (buy, claim, save) — user sees nothing on failure. Note: acceptable for best-effort background operations (auto-sync, prefetch)
- Missing error boundaries around independently-failing sections
- Inconsistent loading patterns across screens (some `useQuery`, some manual `useState`, some `return null`)

### 16. State & Hook Patterns

**Source**: React docs — "Reusing Logic with Custom Hooks"

**What to check**:
- Custom hooks wrapping a single `useState` with no other hooks — React docs: "extracting a useFormInput Hook to wrap a single useState call is probably unnecessary"
- Functions prefixed with `use` that don't call any React hooks — React docs: "If your function doesn't call any Hooks, avoid the use prefix"
- Components with 4+ `useState` calls that could be consolidated into a custom hook or `useReducer`
- React docs: "Custom Hooks let you share stateful logic but not state itself. Each call to a Hook is completely independent."

## Part 3 — Animation, Performance & Platform

### 17. Animation & Motion

**Standard**: WCAG 2.3.3 (AAA) — Animation from Interactions; Web Interface Guidelines — Animation

**What to check**:
- `prefers-reduced-motion` must be honored — provide reduced variant or disable animation entirely
- Only animate compositor-friendly properties: `transform` and `opacity`. Animating `width`, `height`, `top`, `left`, `margin` causes layout thrashing.
- `transition: all` is an anti-pattern — list properties explicitly (e.g., `transition-colors`, `transition-opacity`)
- Animations should be interruptible — respond to user input mid-animation
- SVG transforms: apply on `<g>` wrapper with `transform-box: fill-box; transform-origin: center`

### 18. Images & Media

**Standard**: Web Interface Guidelines — Images; Web Core Vitals — CLS

**What to check**:
- `<img>` needs explicit `width` and `height` attributes (prevents Cumulative Layout Shift)
- Below-fold images: `loading="lazy"`
- Above-fold critical images: `priority` (Next.js) or `fetchpriority="high"`
- Images need `alt` text (or `alt=""` if purely decorative) — also covered in §8

### 19. Typography & Content

**Source**: Web Interface Guidelines — Typography, Content & Copy

**What to check**:
- `…` not `...` (ellipsis character)
- Loading states end with `…`: `"Loading…"`, `"Saving…"`
- Curly quotes `"` `"` not straight `"` in user-facing strings
- Non-breaking spaces for units and shortcuts: `10&nbsp;MB`, `⌘&nbsp;K`
- `font-variant-numeric: tabular-nums` (Tailwind: `tabular-nums`) on number columns, prices, countdowns
- `text-wrap: balance` or `text-pretty` on headings (prevents orphan words)
- Error messages must include a fix or next step, not just the problem
- Specific button labels: "Save API Key" not "Continue"

### 20. Content Handling & Overflow

**Source**: Web Interface Guidelines — Content Handling

**What to check**:
- Text containers must handle long content: `truncate`, `line-clamp-*`, or `break-words`
- Flex children need `min-w-0` to allow text truncation (flex items don't shrink below content width by default)
- Handle empty states — don't render broken UI for empty strings/arrays
- User-generated content: anticipate short, average, and very long inputs

### 21. Performance Patterns

**Source**: Web Interface Guidelines — Performance; Web Core Vitals

**What to check**:
- Large lists (>50 items): virtualize with `virtua`, `react-window`, or `content-visibility: auto`
- No layout reads in render: `getBoundingClientRect`, `offsetHeight`, `offsetWidth`, `scrollTop` in a React render path causes forced synchronous layout
- Batch DOM reads/writes — don't interleave reads and writes
- Prefer uncontrolled inputs (`defaultValue`); controlled inputs must be cheap per keystroke
- `<link rel="preconnect">` for CDN/asset domains
- Critical fonts: `<link rel="preload" as="font">` with `font-display: swap`

### 22. Touch & Interaction

**Source**: Web Interface Guidelines — Touch & Interaction

**What to check**:
- `touch-action: manipulation` on interactive areas (prevents 300ms double-tap zoom delay)
- `overscroll-behavior: contain` in modals, drawers, sheets (prevents background scroll)
- During drag operations: disable text selection, use `inert` on dragged elements
- `autoFocus` sparingly — desktop only, single primary input; avoid on mobile (causes viewport scroll to input)
- `-webkit-tap-highlight-color` set intentionally (transparent or themed, not browser default)

### 23. Navigation & URL State

**Source**: Web Interface Guidelines — Navigation & State

**What to check**:
- URL should reflect UI state — filters, active tab, pagination, expanded panels stored in query params
- Links use `<a>`/`<Link>` (supports Cmd/Ctrl+click, middle-click open-in-new-tab)
- `<div onClick>` used for navigation = violation — use `<Link>` or `<a>`
- Destructive actions need confirmation modal or undo window — never fire immediately on click
- Deep-linkable stateful UI: if a component uses `useState` for view state, consider URL sync

### 24. Dark Mode & Theming

**Source**: Web Interface Guidelines — Dark Mode & Theming

**What to check**:
- `color-scheme: dark` on `<html>` for dark themes (fixes native scrollbar, form inputs, etc.)
- `<meta name="theme-color">` matches page background
- Native `<select>`: must set explicit `background-color` and `color` (Windows dark mode renders white text on white background without this)

### 25. Hydration Safety

**Source**: Web Interface Guidelines — Hydration Safety; React docs

**What to check**:
- Inputs with `value` prop need `onChange` handler (or use `defaultValue` for uncontrolled)
- Date/time rendering: guard against hydration mismatch (server renders UTC, client renders local — use `suppressHydrationWarning` or defer to client)
- `suppressHydrationWarning` should only be used where truly needed — not as a blanket fix

### 26. Internationalization

**Source**: Web Interface Guidelines — Locale & i18n

**What to check**:
- Dates/times: use `Intl.DateTimeFormat` — never hardcode format strings
- Numbers/currency: use `Intl.NumberFormat` — never hardcode separators or currency symbols
- Hardcoded date/number formats are an anti-pattern even in English-only apps (user locale varies)

## Output Format

Group findings by severity. Each finding MUST name the specific standard.

```
## Critical
Violations that directly harm users — screen reader users can't navigate, keyboard users are trapped, touch users can't tap targets.

### [STANDARD] Brief title
**File**: `path/to/file.tsx` (lines X-Y)
**Standard**: Full standard ID and one-line requirement.
**Violation**: What the code does wrong and who is affected.
**Fix**: Specific, actionable code change.

## Warning
Violations that degrade usability but have workarounds, or best-practice violations with real UX impact.

(same structure)

## Suggestion
Improvements that increase robustness or consistency but aren't urgently broken.

(same structure)

## Summary
- Total findings: N (X critical, Y warning, Z suggestion)
- Standards most frequently violated: list top 2-3
- Overall assessment: 1-2 sentence verdict
```

## False Positive Filtering

### Always flag these anti-patterns:

- `user-scalable=no` or `maximum-scale=1` — disabling zoom is an accessibility violation
- `onPaste` with `preventDefault` — blocks password managers and assistive tech
- `transition: all` — list properties explicitly
- `outline-none` without `:focus-visible` replacement
- `<div>` or `<span>` with click handlers that should be `<button>` or `<a>`
- Images without `width`/`height` dimensions
- Large arrays `.map()` without virtualization (>50 items)
- Form inputs without labels
- Icon buttons without `aria-label`
- Hardcoded date/number formats (use `Intl.*`)
- `autoFocus` without clear justification

### Hard Exclusions — do NOT report:

1. **Inline links within body text** — exempt from touch target size per WCAG 2.5.5
2. **Disabled/inactive elements** — exempt from contrast requirements per WCAG 1.4.3
3. **Purely decorative elements** — exempt from text alternative requirements per WCAG 1.1.1
4. **Third-party component internals** — don't audit inside node_modules
5. **Test files** — skip `.test.tsx`, `.spec.tsx`
6. **Theme/token definitions** — CSS variable definitions in theme config ARE the design system

### Severity Calibration:

- **Critical**: Users physically cannot complete an action (can't tap, can't navigate, can't perceive content). Screen reader users locked out.
- **Warning**: Users CAN complete the action but with significant difficulty. UX best-practice violations with real impact.
- **Suggestion**: Improvements that help but aren't urgently broken. Minor inconsistencies.

## Verification Pass

Before finalizing your report, verify every finding:

1. **Re-read the code**: Go back to the flagged file and re-read the flagged lines in full context (±20 lines). Confirm the issue actually exists — not a misread, not handled elsewhere in the same file, not guarded by a wrapper or parent component.
2. **Check for existing mitigations**: Search the codebase for related patterns. Is the "missing" attribute set by a shared component, layout wrapper, or design system primitive? If so, drop the finding.
3. **Verify against official docs**: For every standard you cite, confirm your interpretation is correct. If you're unsure whether a pattern violates the standard, look it up — don't guess. Use available tools (context7, web search, REFERENCE.md) to check current documentation when uncertain.
4. **Filter by confidence**: If you're certain a finding is a false positive after re-reading, drop it entirely. If doubt remains but the issue seems plausible, move it to a brief "Worth Investigating" note at the end of the report — don't include it as a formal finding.

## Rules

- **Cite the standard**: every finding must reference the specific WCAG SC, ARIA APG pattern, or platform guideline.
- **Be specific**: always cite file paths and line numbers.
- **Be actionable**: every finding must include a concrete fix — not "add aria-label" but `aria-label="Close dialog"` on line 42.
- **Measure real impact**: severity by who is affected and how badly.
- **Don't over-report text size**: WCAG has no minimum font size. Sub-12px = Warning (best practice), never Critical.
- **Don't over-report DRY**: same-file duplication is fine per Tailwind guidance. Only flag cross-file duplication of 3+ occurrences.
- **Respect scope**: in diff mode, only flag issues in changed lines and their immediate context.
- **Don't duplicate other skills**: a11y and UI structure only. Logic bugs go to `correctness-audit`, security to `security-audit`, general code quality to `best-practices-audit`.
