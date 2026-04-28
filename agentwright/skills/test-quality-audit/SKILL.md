---
name: test-quality-audit
description: Audits existing test files for anti-patterns and best-practice violations using the rules defined in the four write-tests skills (write-tests, write-tests-frontend, write-tests-deno, write-tests-pgtap). Use to find flaky patterns, weak assertions, over-mocking, isolation issues, structure-coupled tests, and other quality problems in tests that already exist. Complements test-coverage-audit (which finds missing tests).
---

# Test Quality Audit

Audit existing test files for anti-patterns and best-practice violations against the rules defined in the four `write-tests-*` skills. This audit finds **bad tests that already exist** — not missing tests (use `test-coverage-audit` for that) and not bugs in production code (use `correctness-audit`).

The rule definitions live in the per-domain skills. This audit does NOT restate them — it routes test files to the right skill, loads that skill, and applies its rules.

## Scope

Audit only files that are tests. Skip everything else (production code, configs, generated files, fixtures with no assertions).

Test file locators:

| Domain | Where they live |
|---|---|
| pgTAP | `*.test.sql` (Supabase convention: `supabase/tests/database/*.test.sql`) |
| Deno edge | `supabase/functions/tests/**`, plus any `*_test.ts` / `*-test.ts` that imports `Deno.test`, `@std/assert`, or `@std/testing` |
| Frontend (React/RTL) | `*.test.tsx`, `*.test.jsx`, files under `__tests__/` that import `@testing-library/react` or `vitest` |
| Generic | every other `*.test.{ts,js,py,go,rs,java,...}`, `*_test.{ts,js,py,go,rs,...}`, `test_*.py`, etc. |

Skip `node_modules/`, `vendor/`, build output, generated files.

## Process

### 1. Discover and classify

Use Glob/Grep to enumerate every in-scope test file. Classify each by domain:

| Domain | Skill |
|---|---|
| pgTAP | `agentwright:write-tests-pgtap` |
| Deno edge | `agentwright:write-tests-deno` |
| Frontend (React/RTL) | `agentwright:write-tests-frontend` |
| Generic | `agentwright:write-tests` |

A single project usually has tests from multiple domains.

### 2. Load the matching skills — MANDATORY

**Once the correct test writing skills are identified you MUST load them before doing anything else.** Use the `Skill` tool to load each identified one. The skills are:

- `agentwright:write-tests-pgtap` — for `*.test.sql`
- `agentwright:write-tests-deno` — for Deno edge function tests
- `agentwright:write-tests-frontend` — for React/RTL tests
- `agentwright:write-tests` — for everything else

Load every skill that applies to the domains found in scope. Do not audit from memory — the rule definitions in the loaded skills are the source of truth, including their `REFERENCE.md` files when present.

### 3. Apply each loaded skill's review-mode rules

Each loaded skill has a "Principles to Enforce" / "Common Anti-Patterns" / "Output Format (Review Mode)" section. Apply those rules to every test file in the matching domain. Do not cross-apply rules across domains — a `.test.sql` file is not subject to React/RTL rules.

### 4. Verify version-pinned claims before reporting

For findings about library APIs or version-specific behavior (RTL query priorities, Vitest mocking semantics, Deno sanitizer flags, pgTAP function names), use `WebFetch`, `WebSearch`, or `mcp__context7__` to confirm the rule still applies in the version the project uses. Read `package.json`, `deno.json`, or the project's lockfile to see what's pinned. Don't flag a violation based on a memory of a library's older API.

### 5. Run available linters

If the project ships testing-related linters, run them on the in-scope test files and fold the results into the findings:

- ESLint with `eslint-plugin-testing-library` for React/RTL tests (`cd app && npx eslint <test-paths>`)
- `npx supabase db lint` for SQL-side migrations referenced by pgTAP tests
- `deno lint` on Deno test directories

A linter error that maps to a write-tests-* principle should be reported under that principle, not as a separate "linter said so" finding.

## Output Format

Group findings by severity, matching the loaded skill's "Output Format (Review Mode)" structure (Critical / Warning / Suggestion). Each finding must name the violated principle.

```
## Critical
Tests that are unreliable, flaky, or misleading — they can falsely pass and mask real regressions.

### [PRINCIPLE] Brief title
**File**: `path/to/file.test.ts` (lines X–Y)
**Principle**: What the loaded skill's rule requires.
**Violation**: What the test does wrong and the concrete impact (false confidence, flakiness, masked regression).
**Fix**: Specific, actionable change.
**Evidence**: Quote the offending line(s) or name the rule violated.

## Warning
Tests that weaken value, structure-couple to implementation, or violate domain conventions but are unlikely to falsely pass on their own.

(same structure)

## Suggestion
Style, naming, idiom alignment with the loaded skill's conventions.

(same structure)

## Summary
- Total findings: N (X critical, Y warning, Z suggestion)
- Domains audited: pgTAP / Deno / frontend / generic — and per-domain principle hot spots
- Linter results: ESLint testing-library: clean / deno lint: clean / supabase db lint: clean (etc.)
- Overall assessment: 1–2 sentence verdict on test-suite reliability
```

## Rules

- **Load the skill, don't paraphrase from memory** — every finding must trace back to a rule in a skill that was loaded for that domain.
- **One domain per skill** — apply only the matching skill's rules; don't cross-pollinate (no React rules on SQL tests).
- **Cite the principle** — the title or problem field must name the violated rule.
- **Verify version-pinned claims** — use WebFetch/Context7 before flagging behavior tied to a specific library version.
- **Stay in test code** — bugs in production code go to `correctness-audit`; missing tests go to `test-coverage-audit`.
- **Respect scope** — in diff mode only flag issues in test files that appear in the diff.
- **Don't flag fixtures without assertions** — a `.spec.ts` that only seeds data and is imported by real tests is not a quality violation by itself.
