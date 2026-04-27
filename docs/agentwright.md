# agentwright

> Chained audit pipelines with a spawned auditor and in-session verification. Run `/audit-run` — a headless `claude -p` subprocess audits a frozen snapshot, the current session independently verifies each finding and applies fixes to the live repo.

**Version**: 1.10.0 · [Source](https://github.com/Joys-Dawn/toolwright/tree/master/agentwright) · [README](https://github.com/Joys-Dawn/toolwright/blob/master/agentwright/README.md)

## Install

```text
/plugin marketplace add Joys-Dawn/toolwright
/plugin install agentwright@Joys-Dawn/toolwright
```

Requires Node.js ≥ 18 and `claude` on `PATH` (the auditor subprocess calls it). Zero config — a `.gitignore` that excludes large binaries/datasets keeps snapshots fast.

## Using it

```text
/audit-run                              # default pipeline on git diff (staged + unstaged)
/audit-run src/api/                     # default pipeline on a directory
/audit-run full --diff                  # named pipeline on git diff
/audit-run correctness,security src/    # ad-hoc stage list
/audit-step security src/auth/          # single stage
/audit-resume 2026-04-15-abc123         # resume an interrupted run
/audit-clean --logs-only                # keep findings, drop logs
```

**Default pipeline** (no argument): `correctness → security → best-practices`.
**Default scope**: `git diff` (staged + unstaged).

## How it runs

1. Frozen snapshot of the codebase (`.gitignore`-aware).
2. `claude -p` subprocess audits the snapshot using a vendored or custom skill.
3. Findings stream back as newline-delimited JSON.
4. The session verifies each finding against the live repo — auditor claims are never blindly trusted.
5. Objectively correct fixes apply immediately. Judgment calls are marked `valid_needs_approval` and presented after the run.
6. After all stages, the [verifier agent](#agents-5) validates applied fixes.
7. A per-finding summary table prints.

**Pipeline rules**: string entries run sequentially. Nested arrays (`["a", "b"]`) run as a parallel group on the same snapshot — N stages = N auditor agents. A custom stage with `skillIds: [...]` runs N audit skills in **one** agent on one snapshot ("fused stage" — useful for small diffs where the per-stage agent boot cost outweighs parallelism). Each new group gets a fresh snapshot of the fixed repo. Duplicate stage names auto-suffix (`correctness` → `correctness-2`).

## Commands

All seven live under the plugin's `/` namespace (they're in `commands/`, not skills).

| Command | Args | Purpose |
|---|---|---|
| `/audit-run` | `[pipeline\|stages] [scope]` | Run the default or a named pipeline. |
| `/audit-step` | `<stage> [scope]` | Run a single stage. |
| `/audit-resume` | `<run-id>` | Resume from the next incomplete stage. |
| `/audit-status` | `[run-id]` | Run state — active/completed/pending stages, verification progress. |
| `/audit-stop` | `[run-id]` | Kill worker/auditor processes and mark cancelled. |
| `/audit-reset` | `[run-id]` | Guided deletion of a run directory. |
| `/audit-clean` | `[--logs-only]` | Prune retained artifacts per the retention policy. |

## Skills (23)

Auto-discovered from `agentwright/skills/` and invokable as `/agentwright:<name>` or via the `Skill` tool.

### Audit skills (used by the pipeline)

| Skill | Focus |
|---|---|
| `/agentwright:correctness-audit` | Logic errors, null handling, async races, type coercion, resource leaks, N+1 queries. |
| `/agentwright:security-audit` | OWASP Top 10 2025, OWASP API Security Top 10 2023, CWE, GDPR, PCI-DSS. |
| `/agentwright:best-practices-audit` | DRY, SOLID, KISS, YAGNI, Clean Code, naming, coupling, anti-patterns. |
| `/agentwright:migration-audit` | PL/pgSQL: NULL traps, race conditions, missing constraints, JSONB pitfalls. Auto-triggers when a `supabase/migrations/*.sql` file is written. |
| `/agentwright:implementation-audit` | Roundabout solutions, unnecessary complexity, reinvented wheels, naive designs. |
| `/agentwright:ui-audit` | WCAG 2.2, WAI-ARIA patterns, touch target sizing, focus management, React/Tailwind anti-patterns. |
| `/agentwright:test-coverage-audit` | Maps source files against tests, produces a risk-prioritized list of gaps. |

### Planning

| Skill | Focus |
|---|---|
| `/agentwright:feature-planning` | Impact analysis, requirements, design, implementation steps, risk assessment. |
| `/agentwright:project-planning` | Stack selection, directory structure, tooling, scaffolding for a new project. |
| `/agentwright:bug-fix-planning` | Root-cause mapping, change impact, minimal fix, regression tests. |
| `/agentwright:refactor-planning` | Blast radius mapping, safe transformation sequence, behavior-preservation verification. |

### Debugging

| Skill | Focus |
|---|---|
| `/agentwright:systematic-debugging` | Reproduce, isolate, hypothesize, verify. |

### Test writing

| Skill | Focus |
|---|---|
| `/agentwright:write-tests` | General test quality (assertions, isolation, flakiness, over-mocking). Defers to the three below when applicable. |
| `/agentwright:write-tests-frontend` | React components/hooks with Vitest + RTL. |
| `/agentwright:write-tests-deno` | Deno integration tests for Supabase Edge Functions. |
| `/agentwright:write-tests-pgtap` | pgTAP database tests for Supabase SQL migrations. |

### Agent-shortcut skills

Thin wrappers that invoke the built-in agents — use `/agentwright:<name>` instead of typing `@agent-agentwright:<agent>`.

| Skill | Agent |
|---|---|
| `/agentwright:research <topic>` | deep-research |
| `/agentwright:update-docs [scope]` | update-docs |
| `/agentwright:critique [focus]` | party-pooper |
| `/agentwright:verify [focus]` | verifier |
| `/agentwright:verify-plan [--plan-path <path>] [--against <ref>]` | plan-verifier |
| `/agentwright:challenge [claim]` | detective (×2) |

### Utilities

| Skill | Focus |
|---|---|
| `/agentwright:config-init` | Write `.claude/agentwright.json` with every default populated. Pass `--force` to overwrite. |

## Agents (6)

Invokable as `@agent-agentwright:<name>` or via the shortcut skills above.

| Agent | Role | Tools |
|---|---|---|
| **detective** | Investigates a hypothesis — traces logic, reads files, runs tests, reports evidence. Backs `/agentwright:challenge`. | Read-only + research MCPs + Bash for tests |
| **verifier** | Validates applied fixes — implementations exist, tests pass, no unstated changes. Auto-dispatched after audit fixes. | Read-only + Bash for tests |
| **plan-verifier** | Validates that an approved plan was implemented faithfully. Anchors on three independent sources — plan, implementer's transcript (assistant turns + user directives + tool-use trace, pre-extracted from the session JSONL), and `git diff` — and emits a six-bucket report (`unreported_skips`, `unreported_additions`, `unreported_out_of_scope`, `unreported_missing_tests`, `fabricated_claims`, `acknowledged_deviations`) with a PASS/PARTIAL/FAIL verdict. Backs `/agentwright:verify-plan`. | Read-only |
| **deep-research** | Web search and literature review. Uses Exa, Context7, AlphaXiv, Scholar Gateway, Hugging Face, PubMed, bioRxiv in parallel. | Read-only |
| **party-pooper** | Adversarial critique. Parallel counter-evidence searches across academic, web, and docs sources. | Read-only + research MCPs |
| **update-docs** | Keeps `.md` files in sync with code. Scoped by [`hooks/md-only-edit.js`](https://github.com/Joys-Dawn/toolwright/blob/master/agentwright/hooks/md-only-edit.js) to `.md` files only. | `.md` files only |

All agents run with `permissionMode: dontAsk`.

## Config

`.claude/agentwright.json` (all fields optional). See [`agentwright.example.json`](https://github.com/Joys-Dawn/toolwright/blob/master/agentwright/agentwright.example.json).

Run `/agentwright:config-init` to drop the full default config into your repo — every key populated so you can edit pipelines, custom stages, and retention in place. Add `--force` to overwrite an existing file; delete the file to fall back to built-in defaults.

```json
{
  "pipelines": {
    "default": ["correctness", "security", "best-practices"],
    "full": ["correctness", "security", ["best-practices", "perf"], ["my-checks", "ui"], "test-coverage"],
    "quick": ["audit-bundle"]
  },
  "customStages": {
    "perf": { "type": "skill", "skillId": "performance-investigation" },
    "my-checks": { "type": "skill", "skillPath": "skills/my-custom-audit/SKILL.md" },
    "audit-bundle": { "type": "skill", "skillIds": ["correctness-audit", "security-audit", "best-practices-audit"] }
  },
  "retention": {
    "keepCompletedRuns": 2,
    "deleteCompletedLogs": true,
    "deleteCompletedFindings": false,
    "maxRunAgeDays": 2
  }
}
```

Custom stages are referenced by their key inside `pipelines` (e.g., `"perf"` in `full` above), or run directly with `/audit-step perf`. A custom stage with `skillIds` is a **fused stage**: one auditor agent loads all listed skills against one snapshot, instead of spawning N agents. Each finding the fused agent emits is tagged with an `auditType` field naming which skill it came from; the tag flows through into `summary.json`'s `rejectedFindings` and `pendingApprovals` entries. Best for 2–3 fusions on small diffs.

| Key | Default | Description |
|---|---|---|
| `pipelines.default` | `["correctness", "security", "best-practices"]` | Pipeline for `/audit-run` with no argument. |
| `pipelines.<name>` | — | Named pipeline. Array of stage names or nested arrays for parallel groups. |
| `customStages.<key>.skillId` | — | Reference a single builtin skill by ID. |
| `customStages.<key>.skillIds` | — | Array of builtin skill IDs to fuse into one agent (mutually exclusive with `skillId` / `skillPath`). |
| `customStages.<key>.skillPath` | — | Reference a project-relative `SKILL.md`. |
| `retention.keepCompletedRuns` | 2 | Completed runs to retain. |
| `retention.deleteCompletedLogs` | true | Delete stage log folders for completed runs. |
| `retention.deleteCompletedFindings` | false | Delete per-finding JSON for completed runs. |
| `retention.maxRunAgeDays` | 2 | Prune completed runs older than this. |

## State

`.claude/audit-runs/<run-id>/` holds each run:

- `findings/` — per-finding JSON as it streams from the auditor
- `logs/` — per-stage auditor subprocess logs
- `group-<N>-snapshot.json` — path to the frozen snapshot consumed by the verifier
- Run metadata for `/audit-status` and `/audit-resume`
