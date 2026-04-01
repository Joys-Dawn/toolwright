# agentwright

Claude Code plugin for structured code audits, planning, debugging, and testing. Audit skills run as chained pipelines — a headless subprocess audits a frozen snapshot while the current session independently verifies each finding and applies fixes on the live repo. Turns AI slop into beautiful working code.

## Installation

```
/plugin marketplace add Joys-Dawn/toolwright
/plugin install agentwright@Joys-Dawn/toolwright
```

## How audits work

1. A frozen snapshot of the codebase is created (`.gitignore`-aware)
2. A headless `claude -p` subprocess audits the snapshot using a vendored or custom skill definition
3. Findings stream back as newline-delimited JSON
4. The current session independently verifies each finding against the live repo — auditor claims are never blindly accepted
5. Objectively correct fixes are applied immediately; judgment calls are deferred for user approval
6. After all stages complete, a verifier subagent validates the applied fixes
7. A per-finding summary table is presented with every finding's disposition

## Commands

| Command | Description |
|---------|-------------|
| `/audit-run [pipeline\|stages] [scope]` | Run the default or a named pipeline |
| `/audit-step <stage> [scope]` | Run a single audit stage |
| `/audit-resume <run-id>` | Resume an interrupted run |
| `/audit-status [run-id]` | Show run status or list all runs |
| `/audit-stop [run-id]` | Kill processes and mark cancelled |
| `/audit-reset [run-id]` | Guided instructions for discarding a run |
| `/audit-clean [--logs-only]` | Clean retained artifacts |

**Examples:**

```
/audit-run                              # default pipeline on git diff
/audit-run src/api/                     # default pipeline on a directory
/audit-run full --diff                  # named pipeline on git diff
/audit-run correctness,security src/    # specific stages
/audit-step security src/auth/          # single stage
```

## Skills

14 vendored skills, usable in pipelines or standalone:

### Audit skills

| Skill | Focus |
|-------|-------|
| **correctness-audit** | Logic errors, null handling, async races, type coercion, resource leaks, N+1 queries |
| **security-audit** | OWASP Top 10 2025, API Security Top 10, CWE, GDPR, PCI-DSS |
| **best-practices-audit** | DRY, SOLID, KISS, YAGNI, Clean Code, naming, coupling, anti-patterns |
| **migration-audit** | PL/pgSQL: NULL traps, race conditions, missing constraints, JSONB pitfalls |
| **ui-audit** | WCAG 2.2 accessibility, WAI-ARIA patterns, component anti-patterns (React/Tailwind) |
| **test-coverage-audit** | Maps source files against tests, produces risk-prioritized coverage gaps |

### Planning skills

| Skill | Focus |
|-------|-------|
| **feature-planning** | Impact analysis, requirements, design, implementation steps, risk assessment |
| **project-planning** | Stack selection, directory structure, tooling, scaffolding for greenfield projects |
| **bug-fix-planning** | Root cause mapping, change impact, minimal fix, regression tests |

### Debugging

| Skill | Focus |
|-------|-------|
| **systematic-debugging** | Reproduce, isolate, hypothesize, verify — evidence-based root-cause analysis for hard to find bugs |

### Testing skills

| Skill | Focus |
|-------|-------|
| **test-writing** | General test quality: assertions, isolation, flakiness, over-mocking (any language) |
| **test-frontend** | React with Vitest + React Testing Library |
| **test-deno** | Deno integration tests for Supabase Edge Functions |
| **test-pgtap** | pgTAP database tests for Supabase SQL migrations |

## Subagents

| Subagent | What it does | Permissions |
|----------|-------------|-------------|
| **verifier** | Validates applied fixes: implementations exist, tests pass, no unstated changes. Dispatched automatically after audit fixes. | Read-only |
| **deep-research** | Web search and literature review with synthesis | Read-only |
| **party-pooper** | Adversarial critique of ideas, plans, and proposals | Read-only |
| **update-docs** | Keeps project docs in sync with code | `.md` files only |

## Fix vs. defer

Fixes are applied only when **objectively correct** — any competent reviewer would agree with no meaningful tradeoff. This covers bugs, security flaws, naming, dead code, and clean-code improvements alike.

Judgment calls, style preferences, large refactors, and architectural opinions are marked `valid_needs_approval` and presented to the user after the run. Nothing deferred is implemented without explicit approval.

## Configuration

Create `.claude/agentwright.json` to customize pipelines and retention. All fields are optional — only include what you want to override. See [agentwright.example.json](agentwright.example.json) for a full example.

**Minimal — reorder the default pipeline:**

```json
{
  "pipelines": {
    "default": ["security", "correctness", "best-practices"]
  }
}
```

**With named pipelines, parallel and custom stages:**

```json
{
  "pipelines": {
    "default": ["correctness", "security", "best-practices"],
    "full": ["correctness", "security", "best-practices", ["migration", "ui", "perf"], "my-checks"]
  },
  "customStages": {
    "perf": { "type": "skill", "skillId": "performance-investigation" },
    "my-checks": { "type": "skill", "skillPath": "skills/my-custom-audit/SKILL.md" }
  },
  "retention": {
    "keepCompletedRuns": 2,
    "deleteCompletedLogs": true,
    "deleteCompletedFindings": false,
    "maxRunAgeDays": 2
  }
}
```

### Pipeline rules

- String entries run sequentially — each stage must complete before the next starts
- Nested arrays (`["a", "b"]`) run as a parallel group — all stages audit the same snapshot. Use for completely independent audits (i.e. test coverage and UI)
- The next group snapshots the newly fixed repo before auditing
- Duplicate stage names are allowed — the second occurrence is automatically suffixed (e.g., `correctness` -> `correctness-2`)

### Custom stages

Reference a builtin skill by `skillId` or a project-relative SKILL.md by `skillPath`. Only needed if you define your own audit stages.

### Retention

Controls cleanup of completed runs. Defaults: keep 2 runs, prune after 2 days, delete logs, keep findings.

## Requirements

- Node.js >= 18
- Claude CLI (`claude` on PATH)
- No external dependencies
- **Recommended**: a `.gitignore` that excludes large non-source files (datasets, binaries, virtual environments). The auditor snapshots the working tree before each group — large untracked files slow this down.

## License

Apache-2.0
