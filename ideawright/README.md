# ideawright

Claude Code plugin that gives you a daily ranked list of **novel**, **code-only** product ideas backed by quoted public evidence.

- **Demand mining** — pain-point posts on Reddit, Hacker News, and GitHub issues ("I wish there was…", "frustrated with…", closed-not-planned issues with traction).
- **Supply mining** — newly-published capabilities on arXiv, bioRxiv, and PubMed (techniques, tools, datasets that just became available).
- **Novelty verification** — every candidate is checked against a five-source web search (Exa, GitHub repos+code, Hacker News, npm, Semantic Scholar) and labeled `novel` / `niche` / `crowded`.
- **Feasibility gates** — three hard gates (`code_only`, `no_capital`, `no_private_data`) drop ideas a solo developer can't realistically ship.
- **Composite ranking** — pain × novelty × feasibility weights produce a daily Top-N digest with a one-paragraph build sketch and a quoted piece of evidence per idea.
- **Per-source cursors** — first scan is the expensive one; subsequent runs only pull what's new.

Built for solo developers who can ship quickly but are rate-limited on *ideas*.

## Token cost — read this first

ideawright burns a LOT of LLM tokens. Even with the default Haiku 4.5 model, a single `/ideawright:daily` run on a fresh database can spawn **hundreds of `claude -p` subprocesses**:

- **Validators** — one batched call per 10 mined observations. Six miners on default settings can produce 500–2,000 raw observations per scan, → 50–200 batched judge calls.
- **Novelty engine** — one search-battery + one batched scoring call per `status='new'` idea. 100 new ideas → 100 scoring calls, each judging up to 25 candidates.
- **Feasibility gate** — one batched call per 10 `verified` ideas.

Order-of-magnitude for a first big run: **a few hundred to a few thousand `claude -p` invocations**, in the **single-digit dollars** range on Haiku and proportionally more on bigger models. Subsequent scans only see new posts/papers thanks to per-source cursors.

**To cap spend**:

- Drop `sources.reddit.subreddits` to a smaller list and lower `sources.reddit.max_pages` (default 10).
- Tighten `sources.arxiv.categories` and set `sources.arxiv.require_code_url=true` to skip papers without code.
- Lower `sources.<name>.lookback_days` and `sources.<name>.max_per_query` (or `max_per_run` / `max_posts_per_sub`) to bound how much each miner pulls per run.
- Disable sources you don't need: `sources.<name>.enabled=false` for miners, `novelty.sources.<name>.enabled=false` for the novelty battery.
- Stick with the default Haiku model. Each per-source `llm.model` override applies to that miner's validator only — Opus on `arxiv` will multiply that miner's cost by ~10×.
- Run `/ideawright:scan` and `/ideawright:vet` separately on small slices before committing to `/ideawright:daily` end-to-end.

There is no built-in budget cap. If you walk away from a fresh `/ideawright:daily` and come back an hour later, expect a real bill.

## Installation

```
/plugin marketplace add Joys-Dawn/toolwright
/plugin install ideawright@Joys-Dawn/toolwright
```

### Customize defaults

Run `/ideawright:config-init` to drop a fully-defaulted `.claude/ideawright.json` — every source, judge, gate, weight, and digest knob visible and editable in one place. Edit any value; delete the file to revert. Pass `--force` to overwrite.

## Quick start

```
/ideawright:daily        # full pipeline: scan + vet + gate + rank + digest
/ideawright:status       # status counts + current top-promoted ideas
```

A daily digest lands in `.claude/ideawright/digests/YYYY-MM-DD.md` listing the top promoted ideas with title, target user, novelty + feasibility verdicts, an implementation sketch, and a quoted piece of evidence.

## How a daily run works

1. **Mine** — six source adapters (Reddit, Hacker News, GitHub issues, arXiv, bioRxiv, PubMed) pull new posts/papers since the last per-source cursor.
2. **Judge** — each batch of 10 observations goes to a `claude -p` validator that decides whether it's a real, code-only need; valid ones land as `status='new'`.
3. **Vet** — for every `new` idea, the novelty engine runs a six-source web-search battery, scores up to 25 candidates per idea, and labels the idea `novel` / `niche` / `crowded`. Crowded ideas are archived; the rest become `verified`.
4. **Gate** — `verified` ideas hit three feasibility gates (`code_only`, `no_capital`, `no_private_data`); failures are archived, passes become `gated`.
5. **Rank** — composite score = `weights.pain × verified_pain + weights.novelty × novelty_score + weights.feasibility × feasibility_score`.
6. **Digest** — top `digest.top_n` (default 10) become `promoted` and a Markdown digest lands in `.claude/ideawright/digests/YYYY-MM-DD.md` with title, target user, verdicts, build sketch, and quoted evidence.

The deterministic idea `id` is `sha256(lowercase(trim(title)) + "|" + lowercase(trim(target_user)))`, so the same idea synthesized from different sources deduplicates automatically.

## Commands

| Command | What it does |
|---|---|
| `/ideawright:daily` | Full pipeline: `scan` + `vet` + feasibility gate + ranker + digest. |
| `/ideawright:scan` | Run the miners only. Each observation is LLM-classified; valid ideas land as `status='new'`. |
| `/ideawright:vet` | Run novelty verification on `status='new'` ideas. Promotes to `verified` (or archives `crowded`). |
| `/ideawright:status` | JSON dump of lifecycle counts + top 10 promoted. |
| `/ideawright:config-init` | Drop a fully-defaulted `.claude/ideawright.json`. Pass `--force` to overwrite. |

## Status lifecycle

```
new → scored → verified → gated → promoted
         ↓         ↓         ↓
      archived  archived  archived
```

| Status | Meaning |
|---|---|
| `new` | Validator judged it a real, code-only need; not yet checked for novelty. |
| `verified` | Novelty verdict was `novel` or `niche` (≤ 5 qualifying competitors by default). |
| `gated` | Passed all three feasibility gates; ranked by composite score. |
| `promoted` | Made today's top-N digest. |
| `archived` | Filtered out — `crowded`, failed gate, or judge rejected. |

## Configuration

`.claude/ideawright.json` (all fields optional). See [`ideawright.example.json`](https://github.com/Joys-Dawn/toolwright/blob/master/ideawright/ideawright.example.json).

Run `/ideawright:config-init` to drop the full default config into your repo — every key populated so you can edit any knob in place.

### Sources

Every source has the same shape: an `enabled` flag plus per-source knobs. Run `/ideawright:config-init` to drop a fully-defaulted file with every key visible.

| Key | Default | Notes |
|---|---|---|
| `sources.<name>.enabled` | `true` (per source) | Toggle any source off. |
| `sources.reddit.subreddits` | `null` (16 built-ins) | Array of sub names without `/r/`. |
| `sources.reddit.max_pages` | `10` | Pages per sub on first run; cursor-paginates afterward. |
| `sources.reddit.max_posts_per_sub` | `null` | Cap observations per sub per run; `null` = no cap. |
| `sources.hn.lookback_days` | `60` | First-run window. |
| `sources.hn.max_per_query` | `100` | Algolia `hitsPerPage`. |
| `sources.hn.queries` | `null` (8 built-ins) | Array of pain-phrase queries. |
| `sources.github.lookback_days` | `14` | First-run window. |
| `sources.github.max_per_query` | `50` | GitHub `per_page` (max 100). |
| `sources.github.queries` | `null` (3 built-ins) | Array of GitHub Search queries. |
| `sources.arxiv.categories` | 10 cs+stat+qbio cats | arXiv categories to query. |
| `sources.arxiv.require_code_url` | `false` | When `true`, drops papers with no detected GitHub/HF/GitLab link. |
| `sources.arxiv.lookback_days` | `14` | First-run window. |
| `sources.arxiv.max_per_query` | `50` | arXiv `max_results` per category. |
| `sources.biorxiv.server` | `"biorxiv"` | Use `"medrxiv"` for medical preprints. |
| `sources.biorxiv.categories` | 6 default cats | Wet-lab-only categories are excluded by default. |
| `sources.biorxiv.lookback_days` | `14` | First-run window. |
| `sources.biorxiv.max_per_run` | `300` | Hard cap on papers fetched per run. |
| `sources.pubmed.lookback_days` | `14` | First-run window. |
| `sources.pubmed.max_per_query` | `100` | E-utilities `retmax` per query. |
| `sources.pubmed.queries` | `null` (6 built-ins) | Array of PubMed query strings. |

### Novelty + feasibility + ranking

| Key | Default | Description |
|---|---|---|
| `novelty.novel_max` | 2 | ≤ this many qualifying competitors → `novel`. |
| `novelty.niche_max` | 5 | ≤ this many → `niche`. > → `crowded` (archived). |
| `novelty.competitor_overlap` | 0.6 | Minimum overlap (0..1) for a search hit to count as a competitor. |
| `novelty.sources.<name>.enabled` | `true` | Per-source novelty-battery toggle for `exa`, `github`, `hn`, `npm`, `scholar`. |
| `feasibility.require_code_only` / `require_no_capital` / `require_no_private_data` | all `true` | Hard gates. Set `false` to keep ideas that fail them. |
| `weights.pain` / `novelty` / `feasibility` | `0.3 / 0.4 / 0.3` | Composite rank weights. |
| `digest.top_n` | `10` | Ideas in each daily digest file. |

### Models

| Key | Default | Description |
|---|---|---|
| `llm.model` | `claude-haiku-4-5-20251001` | Global default for every LLM judge call. |
| `novelty.llm.model` | `claude-haiku-4-5-20251001` | Competitor classifier — Haiku-fast yes/no. |
| `sources.<name>.llm.model` | — | Per-miner override. |

`IDEAWRIGHT_LLM_MODEL` env var overrides the global default without editing config.

### Optional env vars

| Var | Effect |
|---|---|
| `GITHUB_TOKEN` | Raises GitHub rate limits in both the issues miner and the novelty battery. |
| `NCBI_API_KEY` | Raises PubMed E-utilities to 10 req/s. |
| `EXA_API_KEY` | Required to enable the Exa source in the novelty battery. |
| `SEMANTIC_SCHOLAR_API_KEY` | Optional; raises Semantic Scholar rate limit. |

## State

| Path | Contents |
|---|---|
| `.claude/ideawright/ideas.db` | SQLite. Every idea, its lifecycle, novelty + feasibility verdicts, composite rank, and a full state-transition log. |
| `.claude/ideawright/digests/YYYY-MM-DD.md` | One Markdown digest per `/ideawright:daily` run. |

## Requirements

- Node.js ≥ 22.5 — uses the built-in `node:sqlite` (stable on 24+, experimental-flagged on 22.5–23).
- `claude` on `PATH` — the LLM judge spawns it for every classification call.
- No external npm dependencies.

> On Node 22.5–23 you'll see `ExperimentalWarning: SQLite is an experimental feature` on first DB touch. Suppress with `NODE_NO_WARNINGS=1` or upgrade to Node 24+.

## License

Apache-2.0
