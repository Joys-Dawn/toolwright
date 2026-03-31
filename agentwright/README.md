# agentwright

Claude Code plugin for running chained audit pipelines. Spawns a headless auditor subprocess against a frozen snapshot while the current session independently verifies findings and applies fixes on the live repo.

## Installation

```
/install-plugin https://github.com/Joys-Dawn/toolwright/tree/master/agentwright
```

## How it works

1. The coordinator creates a frozen snapshot of the codebase (`.gitignore`-aware)
2. A headless `claude -p` process audits the snapshot using vendored skill definitions
3. Findings stream back as newline-delimited JSON
4. The current session independently verifies each finding against the live repo as it arrives — subagent claims are never blindly accepted
5. Objectively correct fixes are applied immediately; subjective or broad findings are deferred for user approval
6. If another agent owns a file (via wrightward), the finding is skipped and revisited later
7. After all stages complete, the `agentwright:verifier` subagent validates the applied fixes — its claims are also independently verified
8. A concise per-finding summary table is presented with every finding's disposition
9. Deferred findings are presented to the user for explicit approval before implementation

## Commands

| Command | Description |
|---------|-------------|
| `/audit-run [pipeline-or-stages] [scope]` | Run the default or named audit pipeline |
| `/audit-step <stage> [scope]` | Run a single audit stage |
| `/audit-resume <run-id>` | Resume an interrupted run from the next incomplete group |
| `/audit-status [run-id]` | Show audit run status (or list all runs) |
| `/audit-reset [run-id]` | Guided instructions for discarding a run |
| `/audit-stop [run-id]` | Stop a running audit and kill its processes |
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

Skills are structured checklists and planning guides. Audit skills define what to look for, how to classify findings, and what evidence to cite. Planning skills produce implementation-ready plans in plan mode.

| Skill | What it does |
|-------|-------------|
| **correctness-audit** | Audits for correctness bugs, uncaught edge cases, and scalability problems — logic errors, null/undefined handling, async race conditions, type coercion, resource leaks, N+1 queries. |
| **security-audit** | Audits for security vulnerabilities against OWASP Top 10 2025, OWASP API Security Top 10 2023, CWE taxonomy, GDPR, and PCI-DSS. Covers auth, injection, access control, cryptography, API security, and data exposure. |
| **best-practices-audit** | Audits code quality against DRY, SOLID, KISS, YAGNI, Clean Code, and similar industry standards. Naming, function length, coupling, error handling, and anti-patterns. |
| **migration-audit** | Audits PL/pgSQL migration files for NULL traps, TOCTOU race conditions, missing constraints, error handling gaps, JSONB pitfalls, volatility mismarks, financial safety, and SECURITY DEFINER issues. |
| **ui-audit** | Audits React/Tailwind UI for WCAG 2.2 accessibility violations (touch targets, focus, contrast, ARIA patterns) and structural anti-patterns (component duplication, separation of concerns). |
| **systematic-debugging** | Guides root-cause analysis for hard-to-find bugs: reproduce, isolate, hypothesize, verify, fix. Evidence-based debugging with no random fixes. |
| **feature-planning** | Plans a feature before coding: context, change impact analysis, requirements, design (behavior, data, API, state), implementation steps, and risk assessment. |
| **project-planning** | Plans a new project from scratch: stack selection, directory structure, tooling, configuration, scaffolding steps, and risk assessment for greenfield codebases. |
| **bug-fix-planning** | Plans a bug fix before any code is written — maps root cause, change impact, minimal fix, and regression tests. |
| **test-coverage-audit** | Identifies untested code by mapping source files against their tests. Produces a risk-prioritized list of coverage gaps. |
| **test-writing** | General test writing and review across any language or framework. Assertion quality, test isolation, flakiness, over-mocking, naming, and coverage. Defers to framework-specific skills when applicable. |
| **test-deno** | Deno integration tests for Supabase Edge Functions. Enforces sanitizers, assertions, mocking, HTTP testing, and environment isolation. |
| **test-frontend** | React tests using Vitest and React Testing Library. Enforces RTL query priority, Vitest mocking, Zustand/TanStack Query testing, and common-mistakes guidance. |
| **test-pgtap** | pgTAP database tests for Supabase SQL migrations. Transaction isolation, plan counts, assertion selection, RLS verification, privilege testing, and trigger testing. |

The default pipeline runs `correctness`, `security`, and `best-practices`. Other skills are available for named pipelines or single-stage runs.

## Subagents

Focused agents dispatched as subprocesses for specific tasks.

| Subagent | What it does |
|----------|-------------|
| **verifier** | Validates that completed work matches what was claimed. Checks that implementations exist and work, flags unstated changes, runs tests, and reports a PASS/FAIL/PARTIAL verdict. Dispatched automatically after audit fixes are applied. Read-only — cannot edit files. |
| **deep-research** | Deep research and literature review. Searches the web and synthesizes answers with pros/cons and sources. Read-only — cannot edit files or run shell commands. |
| **update-docs** | Keeps project documentation in sync with the code — architecture docs, setup guides, README. Can only edit `.md` files. |
| **party-pooper** | Adversarial critique of ideas, plans, claims, or proposals. Stress-tests assumptions and pokes holes. Read-only — cannot edit files or run shell commands. |

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
    },
    "my-checks": {
      "type": "skill",
      "skillPath": "skills/my-custom-audit/SKILL.md"
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

Custom stages can reference either a `skillId` (builtin skill name) or a `skillPath` (project-relative path to a SKILL.md file).

Pipeline rules:
- A string entry runs sequentially
- A nested array runs as one parallel group (all stages audit the same frozen snapshot)
- The next group snapshots the newly fixed live repo before auditing
- For sequential stages, all valid findings from the current stage must be fixed before the next stage starts
- Duplicate stage names are not allowed within a pipeline

## Fix vs. defer

The verifier/fixer applies fixes only when they are **objectively correct** — meaning any competent reviewer would agree with no meaningful tradeoff. This applies to all finding types: bugs, security flaws, clean-code improvements, naming, dead code removal.

Findings that involve judgment calls, style preferences, architectural opinions, large refactors, or meaningful tradeoffs are marked `valid_needs_approval` and presented to the user after the run completes. No deferred finding is implemented without explicit user approval.

## Snapshots

Before each audit group, the coordinator creates a frozen snapshot of the codebase:

- **Clean git repo**: Uses `git worktree add --detach` for a fast, lightweight snapshot of HEAD.
- **Dirty working tree or non-git repo**: Copies the working tree using `git ls-files -co --exclude-standard` to respect `.gitignore`. Falls back to a hardcoded exclusion list for non-git repos.

Orphaned snapshots (from crashed processes) are automatically cleaned up on the next run start. SIGINT/SIGTERM signal handlers also trigger cleanup during active runs.

Snapshots are stored under `<tmpdir>/agentwright-snapshots/` and removed after each group completes.

## Verification CLI

The coordinator exposes two CLI commands (via `verification.js`) that the verifier/fixer workflow uses to process findings:

- **`next-finding --run <runId>`** — Polls for the next unprocessed finding across all active stages in the current group. Returns one of:
  - `"waiting"` — audit is still running, no new findings yet
  - `"finding"` — a finding to verify (includes the finding object and progress)
  - `"error"` — the auditor failed
  - `"done"` — all stages complete, pipeline finished

- **`record-decision --run <runId> --stage <name> --finding <id> --decision <valid|invalid|valid_needs_approval> [--action fixed|none] [--rationale "..."] [--files-changed "a.js,b.js"] [--evidence "..."]`** — Records a decision for a finding. When all findings in a stage are decided, the stage auto-completes and the pipeline auto-advances to the next group.

- **`stop --run <runId>`** — Kills all worker and auditor processes for the run and marks it as cancelled. Stages already completed are preserved. Safe to call if processes have already exited.

## State

Run state is stored under `.claude/audit-runs/<run-id>/`:

| File | Purpose |
|------|---------|
| `run.json` | Run metadata, stage statuses, group state |
| `summary.json` | Completed stages, rejected findings, pending approvals |
| `group-<N>-snapshot.json` | Snapshot metadata for parallel group N |
| `stages/<name>/findings.jsonl` | Streamed findings (append-only during audit) |
| `stages/<name>/decisions.json` | Verifier decisions for each finding |
| `stages/<name>/meta.json` | Live audit progress (emitted count, status) |
| `stages/<name>/verifier.json` | Verifier progress tracking |
| `stages/<name>/logs/` | Raw auditor stdout/stderr/parse-errors |

Retention defaults: keep 2 completed runs, prune after 2 days, delete logs after verification, keep findings.

## Testing

```bash
node --test
```

## Requirements

- Node.js >= 18
- Claude CLI (`claude` on PATH)
- No external dependencies
- **Strongly recommended**: a `.gitignore` that excludes large datasets, binary assets, virtual environments, and other non-source files. The auditor snapshots the working tree before each audit group — without a `.gitignore`, large untracked files will be copied into the snapshot, wasting disk space and slowing down snapshot creation.

## License

Apache-2.0