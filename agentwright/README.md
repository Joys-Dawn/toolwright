# agentwright

Claude Code plugin for structured code audits, planning, debugging, and testing. Run `/audit-run` and a headless subprocess audits a frozen snapshot of your code while the current session independently verifies each finding and applies fixes on the live repo. Turns AI slop into beautiful working code.

## Installation

Add the marketplace and install the plugin:

```
/plugin marketplace add Joys-Dawn/toolwright
/plugin install agentwright@Joys-Dawn/toolwright
```

### Customize defaults

Run `/agentwright:config-init` to drop a fully-defaulted `.claude/agentwright.json` into your repo — pipelines, custom stages, and retention settings all visible and editable in one place. Edit any value; delete the file to revert. Pass `--force` to overwrite.

## How audits work

1. A frozen snapshot of the codebase is created (`.gitignore`-aware)
2. A headless `claude -p` subprocess audits the snapshot using a vendored or custom skill
3. Findings stream back as newline-delimited JSON
4. The current session independently verifies each finding against the live repo — auditor claims are never blindly trusted
5. Objectively correct fixes are applied immediately; judgment calls are deferred for user approval
6. After all stages complete, a verifier agent validates the applied fixes
7. A per-finding summary table is presented with every finding's disposition

## Commands

| Command | Description |
|---------|-------------|
| `/audit-run [pipeline\|stages] [scope]` | Run the default or a named pipeline |
| `/audit-step <stage> [scope]` | Run a single audit stage |
| `/audit-resume <run-id>` | Resume an interrupted run from the next incomplete stage |
| `/audit-status [run-id]` | Show run status or list all runs |
| `/audit-stop [run-id]` | Kill running auditor processes and mark the run cancelled |
| `/audit-reset [run-id]` | Guided instructions for discarding a run |
| `/audit-clean [--logs-only]` | Clean retained audit artifacts |

### Examples

```
/audit-run                              # default pipeline on git diff
/audit-run src/api/                     # default pipeline on a directory
/audit-run full --diff                  # named pipeline on git diff
/audit-run correctness,security src/    # specific stages only
/audit-step security src/auth/          # single stage on a directory
```

**Default pipeline** (when no pipeline is specified): `correctness → security → best-practices`

**Default scope** (when no scope is specified): files changed in `git diff` (staged + unstaged)

## Skills

21 vendored skills:

### Audit skills (used by the pipeline)

| Skill | Focus |
|-------|-------|
| **correctness-audit** | Logic errors, null handling, async races, type coercion, resource leaks, N+1 queries |
| **security-audit** | OWASP Top 10 2025, API Security Top 10, CWE, GDPR, PCI-DSS |
| **best-practices-audit** | DRY, SOLID, KISS, YAGNI, Clean Code, naming, coupling, anti-patterns |
| **migration-audit** | PL/pgSQL: NULL traps, race conditions, missing constraints, JSONB pitfalls |
| **implementation-audit** | Roundabout solutions, unnecessary complexity, reinvented wheels, naive designs |
| **ui-audit** | WCAG 2.2 accessibility, WAI-ARIA patterns, component anti-patterns (React/Tailwind) |
| **test-coverage-audit** | Maps source files against tests, produces risk-prioritized coverage gaps |

### Planning skills

| Skill | Focus |
|-------|-------|
| **feature-planning** | Impact analysis, requirements, design, implementation steps, risk assessment |
| **project-planning** | Stack selection, directory structure, tooling, scaffolding for greenfield projects |
| **bug-fix-planning** | Root cause mapping, change impact, minimal fix, regression tests |
| **refactor-planning** | Blast radius mapping, safe transformation sequence, behavior preservation verification |

### Debugging

| Skill | Focus |
|-------|-------|
| **systematic-debugging** | Reproduce, isolate, hypothesize, verify — evidence-based root-cause analysis |

### Test writing skills

Write, review, and fix tests. Typically invoked by the main agent after `test-coverage-audit` identifies gaps.

| Skill | Focus |
|-------|-------|
| **write-tests** | General test quality: assertions, isolation, flakiness, over-mocking (any language/framework) |
| **write-tests-frontend** | React with Vitest + React Testing Library |
| **write-tests-deno** | Deno integration tests for Supabase Edge Functions |
| **write-tests-pgtap** | pgTAP database tests for Supabase SQL migrations |

### Agent shortcuts

Skill wrappers that invoke the built-in agents. Use `/agentwright:<name>` instead of typing the full `@agent-agentwright:<agent>` mention.

| Skill | Agent | Pattern |
|-------|-------|---------|
| **research** `<topic>` | deep-research | Forked — self-contained topic |
| **update-docs** `[scope]` | update-docs | Forked — infers from git diff |
| **critique** `[focus]` | party-pooper | Forked — reads session transcript |
| **verify** `[focus]` | verifier | Forked — reads session transcript + git diff |
| **challenge** `[claim]` | detective (x2) | Inline — dispatches two detectives with opposing hypotheses |

## Agents

Five built-in agents available for dispatch:

| Agent | What it does | Permissions |
|-------|-------------|-------------|
| **detective** | Investigates a hypothesis about code behavior — traces logic, reads files, runs tests, reports evidence. Used by `/challenge` to independently verify disputed claims. | Read-only |
| **verifier** | Validates applied fixes: implementations exist, tests pass, no unstated changes. Dispatched automatically after audit fixes. | Read-only |
| **deep-research** | Web search and literature review with synthesis | Read-only |
| **party-pooper** | Adversarial critique of ideas, plans, and proposals | Read-only |
| **update-docs** | Keeps project docs in sync with code changes | `.md` files only |

## Fix vs. defer

During an audit, fixes are applied only when **objectively correct** — any competent reviewer would agree with no meaningful tradeoff. This covers bugs, security flaws, naming, dead code, and clean-code improvements alike.

Judgment calls, style preferences, large refactors, and architectural opinions are marked `valid_needs_approval` and presented to the user after the run. Nothing deferred is implemented without explicit approval.

## Configuration

Create `.claude/agentwright.json` in your project to customize pipelines and retention. All fields are optional — only include what you want to override. See [agentwright.example.json](agentwright.example.json) for a complete example.

### Reorder the default pipeline

```json
{
  "pipelines": {
    "default": ["security", "correctness", "best-practices"]
  }
}
```

### Named pipelines with parallel and custom stages

```json
{
  "pipelines": {
    "default": ["correctness", "security", "best-practices"],
    "full": ["correctness", "security", "best-practices", ["migration", "ui"], "test-coverage"]
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
- Nested arrays (`["a", "b"]`) run as a parallel group — all stages in the group audit the same snapshot concurrently. Use for independent audits (e.g., UI and test coverage)
- After a group completes and fixes are applied, the next group gets a fresh snapshot of the now-fixed repo
- Duplicate stage names are automatically suffixed (`correctness` → `correctness-2`)

### Custom stages

Reference a builtin skill by `skillId` or a project-relative SKILL.md by `skillPath`. Only needed if you define your own audit stages — the 6 vendored audit skills are available by name without any configuration.

### Retention

Controls cleanup of completed runs. Defaults: keep 2 runs, prune after 2 days, delete logs, keep findings.

## Requirements

- Node.js >= 18
- Claude CLI (`claude` on PATH)
- No external dependencies
- **Recommended**: a `.gitignore` that excludes large non-source files (datasets, binaries, virtual environments). The auditor snapshots the working tree before each stage group — large untracked files slow this down.

## License

Apache-2.0
