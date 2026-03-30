---
name: best-practices-audit
description: Audits code against named industry standards and coding best practices (DRY, SOLID, KISS, YAGNI, Clean Code, OWASP, etc.). Use when the user asks to check best practices, enforce standards, audit for anti-patterns, review code quality against principles, or ensure code follows industry conventions. Works on git diffs, specific files, or an entire codebase.
---

# Best Practices Audit

Audit code against established industry standards and named best practices. Cite the specific principle violated for every finding so the developer learns *which* standard applies and why.

## Scope

Determine what to audit based on user request and context:

- **Git diff mode** (default when no scope specified and changes exist): run `git diff` and `git diff --cached` to audit only changed/added code
- **File/directory mode**: audit the files or directories the user specifies
- **Codebase mode**: when the user explicitly asks for a full codebase audit, scan the project broadly (focus on source code, skip vendor/node_modules/build artifacts)

Read all in-scope code before producing findings.

## Principles to Enforce

Evaluate code against each category. Skip categories with no findings. See [REFERENCE.md](REFERENCE.md) for detailed definitions and examples of each principle.

### 1. DRY (Don't Repeat Yourself)

- Duplicated logic across functions, components, or modules
- Copy-pasted code blocks with minor variations
- Repeated string literals, magic numbers, or config values that should be constants
- Similar data transformations that could be unified

### 2. SOLID Principles

- **S — Single Responsibility**: classes/modules/functions doing more than one thing
- **O — Open/Closed**: code that requires modification (instead of extension) to add behavior
- **L — Liskov Substitution**: subtypes that break the contract of their parent type
- **I — Interface Segregation**: interfaces/types forcing implementers to depend on methods they don't use
- **D — Dependency Inversion**: high-level modules depending on concrete implementations instead of abstractions

### 3. KISS (Keep It Simple, Stupid)

- Unnecessary complexity or over-engineering
- Convoluted control flow when a simpler approach exists
- Abstractions that add indirection without clear value
- Clever tricks that sacrifice readability

### 4. YAGNI (You Ain't Gonna Need It)

- Code for features that don't exist yet and aren't requested
- Premature generalization or unnecessary configurability
- Unused parameters, flags, or code paths "just in case"
- Speculative abstractions with a single implementation

### 5. Clean Code (Robert C. Martin)

- **Naming**: vague, misleading, or inconsistent names; abbreviations that hinder readability
- **Functions**: functions longer than ~20 lines; too many parameters (>3); mixed abstraction levels
- **Comments**: comments that restate the code; commented-out code; missing comments on *why* for non-obvious decisions
- **Formatting**: inconsistent indentation, spacing, or file organization within the project

### 6. Error Handling Best Practices

- Swallowed exceptions (empty catch blocks)
- Generic catch-all without meaningful handling
- Missing error propagation — errors that should bubble up but don't
- No user-facing feedback on failure
- Using exceptions for control flow

### 7. Security Standards (OWASP Top 10)

- Unsanitized user input (injection, XSS, path traversal)
- Broken authentication or session management
- Sensitive data exposure (secrets in code, insecure storage, unencrypted transmission)
- Missing access control checks
- Security misconfiguration (permissive CORS, missing CSP headers)
- Using components with known vulnerabilities

### 8. Performance Best Practices

- Unnecessary re-renders or re-computations
- N+1 queries, unbounded result sets, missing pagination
- Synchronous blocking in async-capable contexts
- Missing memoization, caching, or debouncing where clearly beneficial
- Large bundle imports when a smaller alternative exists

### 9. Testing Best Practices

- Untested public API surface or critical paths
- Tests tightly coupled to implementation details
- Missing edge case coverage for non-trivial logic
- Flaky patterns (time-dependent, order-dependent, network-dependent tests)
- Test code that violates DRY without justification

### 10. Code Organization & Architecture

- Circular dependencies between modules
- Business logic mixed into UI/presentation layers
- Shared mutable state across module boundaries
- Inconsistent project structure or file placement conventions
- Missing or inconsistent use of the project's established patterns

### 11. Defensive Programming

- Missing input validation at system boundaries (API endpoints, user forms, external data)
- Assumptions about data shape without type guards or runtime checks
- Missing null/undefined handling where values can realistically be absent
- No graceful degradation on partial failures

### 12. Separation of Concerns

- Mixed responsibilities in a single file or function (e.g. data fetching + rendering + business logic)
- Configuration values hardcoded in business logic
- Platform-specific code leaking into core/shared modules
- Presentation logic mixed with data transformation

## Output Format

Group findings by severity. Each finding MUST name the specific principle violated.

```
## Critical
Violations that will cause bugs, data loss, or security vulnerabilities in production.

### [PRINCIPLE] Brief title
**File**: `path/to/file.ts` (lines X-Y)
**Principle**: Full name of the principle and a one-line explanation of what it requires.
**Violation**: What the code does wrong and the concrete impact.
**Fix**: Specific, actionable suggestion.

## Warning
Violations that degrade maintainability, readability, or robustness.

(same structure)

## Suggestion
Improvements aligned with best practices but not urgent.

(same structure)

## Summary
- Total findings: N (X critical, Y warning, Z suggestion)
- Principles most frequently violated: list the top 2-3
- Overall assessment: 1-2 sentence verdict on the code's adherence to standards
```

## Linter Tools

Before producing findings, **always run the available linters** on in-scope code to supplement your manual review. Linter output should be incorporated into your findings (cite the linter rule alongside the principle).

### ESLint (TypeScript/React)

Run from the `app/` directory. Config: `app/eslint.config.js` (flat config with TypeScript-ESLint, React Hooks, React Refresh).

```bash
cd app && npx eslint .                    # full codebase
cd app && npx eslint src/path/to/file.ts  # specific file(s)
cd app && npx eslint --fix .              # auto-fix what's possible (only with user approval)
```

### Ruff (Python)

Run from the project root. Config: `ruff.toml` (pycodestyle, pyflakes, isort, pep8-naming, pyupgrade, bugbear, simplify, bandit).

```bash
ruff check scripts/                       # all Python scripts
ruff check scripts/wireframe.py           # specific file
ruff check --fix scripts/                 # auto-fix (only with user approval)
```

### How to use linter output

1. Run the relevant linter(s) based on which file types are in scope.
2. For each linter error/warning, map it to the matching principle category (e.g. `@typescript-eslint/no-unused-vars` → Clean Code / Naming, `react-hooks/set-state-in-effect` → Performance / React Best Practices, `S101` → Defensive Programming / Security).
3. Include linter findings in the appropriate severity section. Linter errors that indicate real bugs or security issues go under **Critical**; style/convention issues go under **Suggestion**.
4. If the linter finds no issues for a file type, note "ESLint: clean" or "Ruff: clean" in the Summary.

## Verification Pass

Before finalizing your report, verify every finding:

1. **Re-read the code**: Go back to the flagged file and re-read the flagged lines in full context (±20 lines). Confirm the issue actually exists — not a misread, not handled by an abstraction elsewhere in the same file, not an intentional design choice with a comment explaining why.
2. **Check for existing patterns**: Search the codebase for related code. Is the "violation" actually the established project convention? Is there a shared utility or base class that addresses the concern? If so, drop the finding.
3. **Verify against official docs**: For every principle or best practice you cite, confirm your interpretation is correct. If you're unsure whether a pattern violates the principle in this context, look it up — don't guess. Use available tools (context7, web search, REFERENCE.md) to check current documentation when uncertain.
4. **Filter by confidence**: If you're certain a finding is a false positive after re-reading, drop it entirely. If doubt remains but the issue seems plausible, mention it concisely as "Worth Investigating" at the end of the report — don't include it as a formal finding.

## Rules

- **Name the principle**: every finding must cite the specific standard (e.g. "DRY", "SRP from SOLID", "OWASP A03: Injection"). This is the core value of this skill.
- **Be specific**: always cite file paths and line numbers.
- **Be actionable**: every finding must include a concrete fix.
- **Respect scope**: only audit what's in scope. In diff mode, only flag issues in changed lines (and their immediate context).
- **Don't duplicate code-quality-review**: focus on named principles and standards, not generic bug-hunting. If using both skills, they complement each other.
- **Pragmatism over dogma**: a principle violation is only worth flagging if fixing it provides real value. Don't flag trivial or pedantic violations that would add noise.
- **Context matters**: consider the project's scale, team size, and existing patterns. A startup prototype has different standards than a production system.
