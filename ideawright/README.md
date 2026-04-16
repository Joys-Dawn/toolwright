# ideawright

Claude Code plugin that auto-surfaces **novel**, **code-only** product opportunities by combining two signal pipelines:

- **Pipeline 1 (demand-driven)** — mines pain-point posts on Reddit, Hacker News, and GitHub issues to find unmet needs.
- **Pipeline 2 (supply-driven)** — mines newly-published capabilities on arXiv, bioRxiv, and PubMed to find products that only became feasible because a new technique, tool, or dataset exists.

Both pipelines feed the same novelty check + feasibility gate + ranker, so the output is a unified ranked list of ideas regardless of origin.

Built for solo developers who can ship quickly but are rate-limited on *ideas*.

## Installation

```
/plugin marketplace add Joys-Dawn/toolwright
/plugin install ideawright@Joys-Dawn/toolwright
```

## How it works

```
  Miners (A)                          →    Novelty Engine (B)   →    Orchestrator (C)
  ──────────────────────────────           search battery             feasibility gate + rank
  P1 demand  → Reddit, HN, GitHub          DDG, GitHub, HN,           code-only? no private data?
               pain-phrase extractor       Product Hunt, npm,         composite score → top-N digest
                         ↓                 PyPI, Chrome Web           → Discord via wrightward bridge
  P2 supply  → arXiv, bioRxiv, PubMed      Store, App Store
               capability validator
                         ↓                       ↓                           ↓
                         └───────→ SQLite at .claude/ideawright/ideas.db ←───┘
```

Each miner emits `observations`; the runner routes them to a validator (pain-signal for P1 miners, capability-synthesis for P2 miners) that uses the judge LLM to decide whether a real product idea is present. Valid ideas are inserted with `status=new` and flow downstream.

### Status lifecycle

```
new → scored → verified → gated → promoted
         ↓         ↓         ↓
      archived  archived  archived
```

- **new** — miner inserted, not yet scored
- **scored** — novelty engine ran (keeps `niche` + `novel`, archives `crowded`)
- **verified** — passed novelty threshold (≤ 3 direct competitors)
- **gated** — feasibility checked (code-only + no-capital + no-private-data hard gates)
- **promoted** — made the top-N digest
- **archived** — filtered out at any stage

## Commands

| Command | What it does |
|---------|-------------|
| `/ideawright:scan` | Run the signal miners |
| `/ideawright:vet` | Score novelty on new ideas |
| `/ideawright:daily` | Full end-to-end pipeline |
| `/ideawright:status` | Show counts by status + top-promoted ideas |
| `/ideawright:config-init` | Write `.claude/ideawright.json` with all defaults |

## Configuration

Run `/ideawright:config-init` to drop a fully-defaulted `.claude/ideawright.json`. Tunable:

- `llm.model` — global default for LLM judge calls (`claude-opus-4-6`). Overridable via `IDEAWRIGHT_LLM_MODEL` env.
- `novelty.llm.model` — model for the competitor classifier (default `claude-haiku-4-5-20251001`). Competitor scoring is a simple yes/no classification; Haiku handles it ~10× faster than Opus, and the novelty pipeline already batches all 25 candidates into one judge call per idea.
- `sources.<name>.llm.model` — per-miner model override for pain / capability validation.
- `sources.*.enabled` — toggle each miner
- `sources.reddit.subreddits` — override the default subreddit list
- `sources.arxiv.categories` — arXiv categories to query (default covers `cs.*`, `stat.ML`, `q-bio.QM`)
- `sources.arxiv.require_code_url` — drop papers without a detected GitHub/HF/GitLab link (default `false`)
- `sources.biorxiv.server` — `biorxiv` or `medrxiv`
- `sources.biorxiv.categories` — subject filter (default: bioinformatics / systems biology / synthetic biology / genomics / genetics / neuroscience)
- `sources.pubmed.queries` — E-utilities query strings (defaults surface algorithm/software/ML papers)
- `novelty.novel_max` / `niche_max` — competitor-count thresholds for the novelty verdict
- `feasibility.*` — which feasibility axes are hard gates
- `weights.{pain,novelty,feasibility}` — composite rank weights
- `digest.top_n` — how many ideas in each daily digest (default 10)
- `schedule.daily_cron` — cron expression for automated runs

Optional env vars:

- `GITHUB_TOKEN` — raises GitHub search rate limit from 10 → 30 req/min
- `NCBI_API_KEY` — raises PubMed rate limit from 3 → 10 req/s
- `IDEAWRIGHT_LLM_MODEL` — overrides the judge default without editing config

## Architecture

Three coordinated layers, each owned by a separate module:

- `lib/miners/` — signal connectors (Pipeline 1 + Pipeline 2), pain-phrase extractor, pain + capability validators
- `lib/novelty/` — query-variant generator + search battery + verdict
- `lib/orchestration/` — feasibility gate + composite scoring + Discord digest

Shared primitives:

- `lib/db.mjs` — SQLite helpers (open, insert, update, list, source cursors)
- `lib/schema.sql` — `ideas`, `sources`, `state_log` tables
- `lib/contract.schema.json` — JSON Schema for the canonical `Idea` shape
- `lib/judge.mjs` — LLM structured-output helper that spawns `claude -p` (default model `claude-opus-4-6`)
- `lib/miners/validator.mjs` — pain-signal judge prompt (Pipeline 1)
- `lib/miners/capability-validator.mjs` — supply-side synthesis prompt (Pipeline 2)

## Contract

Each idea flows through the pipeline as a JSON object matching `lib/contract.schema.json`. Key fields:

- `id` — `sha256(lowercase(trim(title)) + "|" + lowercase(trim(target_user)))` (deterministic, dedup-friendly)
- `pain_evidence[]` — source URLs + quotes proving latent demand
- `novelty` — set by module B (score, verdict, competitors, queries_run)
- `feasibility` — set by module C (code_only, no_capital, no_private_data, effort, verdict)
- `composite_rank` — final ranking score (higher = better)
- `status` — lifecycle state

## Requirements

- Node.js ≥ 22.5 (uses the built-in `node:sqlite` — stable on 24+, experimental-flagged on 22.5–23)
- Claude CLI on PATH (used by `lib/judge.mjs` for structured LLM calls)
- No external npm dependencies

> On Node 22.5–23 you will see `ExperimentalWarning: SQLite is an experimental feature` on first DB touch. Suppress with `NODE_NO_WARNINGS=1` or upgrade to Node 24+.

## License

Apache-2.0
