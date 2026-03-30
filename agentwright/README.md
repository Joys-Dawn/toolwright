# agentwright

Claude Code plugin for running chained audit pipelines. Spawns a headless auditor subprocess against a frozen snapshot while the current session acts as the verifier/fixer on the live repo.

## How it works

1. The coordinator creates a frozen snapshot of the codebase
2. A headless `claude -p` process audits the snapshot using vendored skill definitions
3. Findings stream back as newline-delimited JSON
4. The current session verifies each finding against the live repo as it arrives
5. Objectively correct fixes are applied immediately; subjective or broad findings are deferred for user approval
6. After all stages complete, the `agentwright:verifier` subagent validates the applied fixes
7. Deferred findings are presented to the user for explicit approval before implementation

## Commands

| Command | Description |
|---------|-------------|
| `/audit-run [pipeline-or-stages] [scope]` | Run the default or named audit pipeline |
| `/audit-step <stage> [scope]` | Run a single audit stage |
| `/audit-resume <run-id>` | Resume an interrupted run from the next incomplete group |
| `/audit-status [run-id]` | Show audit run status (or list all runs) |
| `/audit-reset [run-id]` | Guided instructions for discarding a run |
| `/audit-clean [--logs-only]` | Clean retained artifacts from completed runs |

Examples:

```
/audit-run                              # default pipeline on git diff
/audit-run src/api/                     # default pipeline on specific directory
/audit-run full --diff                  # named "full" pipeline on git diff
/audit-run correctness,security src/    # specific stages on specific directory
/audit-step security src/auth/          # single stage
```

## Skills

Skills are structured audit checklists that the spawned auditor follows. Each skill defines what to look for, how to classify findings, and what evidence to cite.

| Skill | What it audits |
|-------|----------------|
| **correctness-audit** | Correctness bugs, uncaught edge cases, and scalability problems — logic errors, null/undefined handling, async race conditions, type coercion, resource leaks, N+1 queries. |
| **security-audit** | Security vulnerabilities against OWASP Top 10 2025, OWASP API Security Top 10 2023, CWE taxonomy, GDPR, and PCI-DSS. Covers auth, injection, access control, cryptography, API security, and data exposure. |
| **best-practices-audit** | Code quality against DRY, SOLID, KISS, YAGNI, Clean Code, and similar industry standards. Naming, function length, coupling, error handling, and anti-patterns. |
| **migration-audit** | PL/pgSQL migration files for NULL traps, TOCTOU race conditions, missing constraints, error handling gaps, JSONB pitfalls, volatility mismarks, financial safety, and SECURITY DEFINER issues. |
| **ui-audit** | React/Tailwind UI for WCAG 2.2 accessibility violations (touch targets, focus, contrast, ARIA patterns) and structural anti-patterns (component duplication, separation of concerns). |
| **systematic-debugging** | Guides root-cause analysis: reproduce, isolate, hypothesize, verify, fix. Evidence-based debugging with no random fixes. |
| **feature-planning** | Plans a feature before coding: context, requirements, design (behavior, data, API, state), implementation steps, and quality/risk assessment. |
| **test-deno** | Deno integration tests for Supabase Edge Functions. Enforces sanitizers, assertions, mocking, HTTP testing, and environment isolation. |
| **test-frontend** | React tests using Vitest and React Testing Library. Enforces RTL query priority, Vitest mocking, Zustand/TanStack Query testing, and common-mistakes guidance. |
| **test-pgtap** | pgTAP database tests for Supabase SQL migrations. Transaction isolation, plan counts, assertion selection, RLS verification, privilege testing, and trigger testing. |

The default pipeline runs `correctness`, `security`, and `best-practices`. Other skills are available for named pipelines or single-stage runs.

## Subagents

Focused agents dispatched as subprocesses for specific tasks.

| Subagent | What it does |
|----------|-------------|
| **verifier** | Validates that completed work matches what was claimed. Checks that implementations exist and work, flags unstated changes, runs tests, and reports a PASS/FAIL/PARTIAL verdict. Dispatched automatically after audit fixes are applied. |
| **deep-research** | Deep research and literature review. Searches the web and synthesizes answers with pros/cons and sources. |
| **update-docs** | Keeps project documentation in sync with the code — architecture docs, setup guides, README, docstrings. |

## Config

Create `.agentwright.json` in the repo root to customize pipelines and add custom stages:

```json
{
  "pipelines": {
    "default": ["correctness", "security", "best-practices"],
    "full": [
      "correctness",
      "security",
      "best-practices",
      ["migration", "ui"],
      "tests-migration",
      "tests-edge",
      "tests-frontend"
    ]
  },
  "customStages": {
    "perf": {
      "type": "skill",
      "skillId": "performance-investigation"
    }
  },
  "retention": {
    "keepCompletedRuns": 20,
    "deleteCompletedLogs": true,
    "deleteCompletedFindings": false,
    "maxRunAgeDays": 14
  }
}
```

A copyable template is provided at `.agentwright.example.json`.

Pipeline rules:
- A string entry runs sequentially
- A nested array runs as one parallel group (all stages audit the same frozen snapshot)
- The next group snapshots the newly fixed live repo before auditing
- Duplicate stage names are not allowed within a pipeline

## Fix vs. defer

The verifier/fixer applies fixes only when they are **objectively correct** — meaning any competent reviewer would agree with no meaningful tradeoff. This applies to all finding types: bugs, security flaws, clean-code improvements, naming, dead code removal.

Findings that involve judgment calls, style preferences, architectural opinions, large refactors, or meaningful tradeoffs are marked `valid_needs_approval` and presented to the user after the run completes. No deferred finding is implemented without explicit user approval.

## State

Run state is stored under `.claude/audit-runs/<run-id>/`:

| File | Purpose |
|------|---------|
| `run.json` | Run metadata, stage statuses, group state |
| `summary.json` | Completed stages, rejected findings, pending approvals |
| `group-<N>-snapshot.json` | Snapshot metadata for parallel group N |
| `stage-<name>-findings.json` | Final findings after audit completes |
| `stage-<name>-findings.jsonl` | Streamed findings (append-only during audit) |
| `stage-<name>-decisions.json` | Verifier decisions for each finding |
| `stage-<name>-meta.json` | Live audit progress (emitted count, status) |
| `stage-<name>-verifier.json` | Verifier progress tracking |
| `stage-<name>-logs/` | Raw auditor stdout/stderr/parse-errors |

Retention defaults: keep 20 completed runs, prune after 14 days, delete logs after verification, keep findings.

## Testing

```bash
node --test
```

## Requirements

- Node.js >= 18
- Claude CLI (`claude` on PATH)
- No external dependencies

## License

Apache-2.0