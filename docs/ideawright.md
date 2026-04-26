# ideawright

> Daily ranked list of novel, code-only product ideas backed by quoted public evidence. Mines pain-point posts (Reddit / HN / GitHub issues) and newly-published capabilities (arXiv / bioRxiv / PubMed), runs a six-source novelty check, gates on three feasibility constraints, and writes a top-N Markdown digest with build sketches and quoted evidence.

**Version**: 0.9.0 · [Source](https://github.com/Joys-Dawn/toolwright/tree/master/ideawright) · [README](https://github.com/Joys-Dawn/toolwright/blob/master/ideawright/README.md)

## Install

```text
/plugin marketplace add Joys-Dawn/toolwright
/plugin install ideawright@Joys-Dawn/toolwright
```

Requires **Node.js ≥ 22.5** (uses the built-in `node:sqlite`) and `claude` on `PATH`. Zero npm dependencies.

## Token cost — read this first

ideawright burns a lot of LLM tokens. A single `/ideawright:daily` on a fresh database can spawn **hundreds of `claude -p` subprocesses** even on Haiku 4.5:

- One batched validator call per 10 mined observations (six miners × default settings → 50–200 batched calls).
- One search battery + one batched scoring call per `status='new'` idea (100 new ideas → 100 scoring calls).
- One feasibility-gate call per 10 `verified` ideas.

Order-of-magnitude for a first big run: **a few hundred to a few thousand** invocations, in the **single-digit dollars** range on Haiku and proportionally more on bigger models. Subsequent scans only see new posts/papers thanks to per-source cursors.

**To cap spend**: shrink `sources.reddit.subreddits`, lower `sources.reddit.max_pages`, tighten `sources.arxiv.categories`, set `sources.arxiv.require_code_url=true`, lower `sources.<name>.lookback_days` and `sources.<name>.max_per_query` (or `max_per_run`/`max_posts_per_sub`), disable sources you don't need, stick with the default Haiku model, and run `/ideawright:scan` and `/ideawright:vet` separately on small slices before committing to `/ideawright:daily` end-to-end. There is no built-in budget cap.

## Using it

```text
/ideawright:daily        # full pipeline: scan + vet + gate + rank + digest
/ideawright:scan         # miners only — populate status='new'
/ideawright:vet          # novelty verification on status='new'
/ideawright:status       # JSON dump of status counts + top 10 promoted
/ideawright:config-init  # write fully-defaulted .claude/ideawright.json
```

A typical first run:

```text
/ideawright:scan        # 6 miners × pagination + LLM validation
/ideawright:vet         # one search battery + LLM batch per idea
/ideawright:daily       # rolls scan + vet + orchestration into one
/ideawright:status      # see what got promoted
```

A daily digest lands in `.claude/ideawright/digests/YYYY-MM-DD.md` listing the top promoted ideas with title, target user, novelty + feasibility verdicts, an implementation sketch, and a quoted piece of evidence.

## How a daily run works

```text
Demand sources               Supply sources
  reddit, hn, github           arxiv, biorxiv, pubmed
        │                            │
        └────────────┬───────────────┘
                     │  observations
                     ▼
        Validator (LLM, batched)            → status = new
                     ▼
        Novelty engine
              query-variant generator
              search battery (Exa · GitHub repos+code · HN · npm · Scholar)
              prefilter → competitor judge (LLM) → verdict
                                              → status = verified / archived
                     ▼
        Feasibility gate (LLM, batched)
              code_only? no_capital? no_private_data?
                                              → status = gated / archived
                     ▼
        Composite ranker
              composite_rank = 0.3·pain + 0.4·novelty + 0.3·feasibility
                     ▼
        Top-N digest → .claude/ideawright/digests/YYYY-MM-DD.md
                                              → status = promoted
```

Every status transition is recorded in the `state_log` table with actor + note, so you can trace why an idea ended up where it did.

The deterministic idea `id` is `sha256(lowercase(trim(title)) + "|" + lowercase(trim(target_user)))` — same title + same target user = same `id`, so the same idea synthesized from different sources deduplicates automatically across runs and across miners.

## Status lifecycle

```text
new → scored → verified → gated → promoted
         ↓         ↓         ↓
      archived  archived  archived
```

| Status | Set by | Meaning |
|---|---|---|
| `new` | Miner + validator | Real, code-only need; not yet checked for novelty. |
| `scored` | Novelty engine | Pipeline ran (intermediate, usually flips to `verified` or `archived` immediately). |
| `verified` | Novelty engine | Verdict was `novel` or `niche` (≤ `niche_max` qualifying competitors). |
| `gated` | Feasibility judge | Passed `code_only` + `no_capital` + `no_private_data`; ranked by composite score. |
| `promoted` | Digest builder | Made today's top-N digest. |
| `archived` | Any stage | Filtered out (`crowded` novelty, failed gates, judge rejected). |

## Commands

| Command | What it does |
|---|---|
| `/ideawright:scan` | Run all enabled miners. Validates each observation via the LLM judge, inserts ideas as `status='new'`. |
| `/ideawright:vet` | Run the novelty pipeline against `status='new'` rows. |
| `/ideawright:daily` | `scan` + `vet` + feasibility gate + ranker + digest write. |
| `/ideawright:status` | JSON dump of status counts and the top 10 promoted ideas. |
| `/ideawright:config-init` | Write a fully-defaulted `.claude/ideawright.json`. Pass `--force` to overwrite. |

## Sources

### Demand pipeline

| Source | Coverage | Auth | Rate limit |
|---|---|---|---|
| Reddit | 16 default subs (`SomebodyMakeThis`, `AppIdeas`, `Entrepreneur`, `SaaS`, `indiehackers`, `webdev`, `selfhosted`, …); pain-phrase regex (`"i wish there was"`, `"why is there no"`, `"frustrated with"`, …) | None | ~60 req/min per UA |
| Hacker News | HN Algolia comments search, scoped to last `lookback_days` (default 60); pre-canned "i wish there was" / "someone should build" / "i would pay for" queries | None | None documented |
| GitHub Issues | `is:closed reason:"not planned" comments:>5`, `label:"help wanted" no:assignee comments:>3`, `label:wontfix reactions:>10` | `GITHUB_TOKEN` recommended | 30 req/min auth, 10 req/min unauth (Search API) |

### Supply pipeline

| Source | Coverage | Auth | Rate limit |
|---|---|---|---|
| arXiv | Atom feed per category (default `cs.AI/LG/CL/CV/IR/DB/SE/HC, stat.ML, q-bio.QM`); detects GitHub / GitLab / HuggingFace / Codeberg / Sourceforge / PapersWithCode link in abstract or links | None | 1 req / 3s API policy; miner uses 8s |
| bioRxiv | `server` = `biorxiv` or `medrxiv`; filters by category — `bioinformatics`, `systems biology`, `synthetic biology`, `genomics`, `genetics`, `neuroscience` | None | None documented |
| PubMed | E-utilities `esearch` + `esummary`; query strings target software / algorithm / ML papers | `NCBI_API_KEY` raises rate limit | 3 req/s unauth, 10 req/s with key |

Each miner emits observations. The runner routes them to a validator that uses the LLM judge to decide whether a real product idea is present. Validators batch by `novelty.batch_size` (default 10, one `claude -p` per batch) and fall back to per-item calls if the batch response fails to parse — so one bad observation doesn't lose the whole batch.

Per-source cursors persist back to the database, so subsequent scans only see new posts/papers.

## Novelty engine

Per `status='new'` idea:

1. **Variants** — generates several queries (exact title, title + target user, capability terms, site-specific scopes).
2. **Battery** — runs every enabled source in parallel under per-host concurrency limits:

    | Source | Default | Cap | Auth |
    |---|---|---|---|
    | `exa` | on | 2 | `EXA_API_KEY` (silently skipped if unset) |
    | `github` (repo + code search) | on | 2 | `GITHUB_TOKEN` recommended |
    | `hn` | on | 4 | None |
    | `npm` | on | 4 | None |
    | `scholar` | on | 1 | `SEMANTIC_SCHOLAR_API_KEY` raises limit (optional) |

3. **Dedup** — URLs are normalized (drop tracking params, strip trailing `/`) and merged across sources; each result records its `origins`.
4. **Prefilter** — drops obvious non-competitors and caps at `maxCandidates` (default 25).
5. **Score** — calls the LLM for each candidate: `is_competitor`, `overlap_score (0..1)`, `reason`.
6. **Verdict**:
    - Counts results with `overlap_score >= competitor_overlap` (default 0.6).
    - `≤ novel_max` (default 2) → `novel`; `≤ niche_max` (default 5) → `niche`; else → `crowded`.
    - If > 50% of judge calls errored, downgrades `novel` to `niche`.
    - `score_0_100 = 100 - min(count·12, 80) - avg(overlap)·20`, with extra dampening on high error ratio.

`verified` and `crowded → archived` writes log the transition into `state_log`.

## Feasibility gate + ranker

`/ideawright:daily` runs after `/vet`:

1. **Feasibility gate** — pulls all `verified` ideas, batches by `novelty.batch_size`, sends to the LLM with the system prompt:

    > Judge whether a product idea satisfies three hard constraints: `code_only`, `no_capital`, `no_private_data`. Also produce `impl_sketch`, `effort` (`hours`/`days`/`weeks`), `score_0_100`, `verdict` (`go` if all gates true and score ≥ 60; `defer` if all gates true and 30 ≤ score < 60; `reject` otherwise).

    Per-item fallback fires if the batch parse fails. Pass → `gated`. Any failed gate or `verdict='reject'` → `archived`.

2. **Composite ranker** — for every `gated` idea:

    ```
    composite_rank = w.pain * (avg(pain_score_0_10)/10)
                   + w.novelty * (novelty.score_0_100/100)
                   + w.feasibility * (feasibility.score_0_100/100)
    ```

    Default weights: `0.3 / 0.4 / 0.3`.

3. **Digest** — selects the top `digest.top_n` (default 10) gated/promoted ideas with `composite_rank IS NOT NULL`, restricted to today's date by `updated_at`. Promotes them to `status='promoted'` and writes the Markdown digest with title + composite rank, target user, category, summary, novelty verdict, feasibility verdict, implementation sketch, and one quoted piece of pain evidence (truncated to 180 chars) per idea.

## Config

`.claude/ideawright.json` (all fields optional). See [`ideawright.example.json`](https://github.com/Joys-Dawn/toolwright/blob/master/ideawright/ideawright.example.json).

Run `/ideawright:config-init` to drop the full default config into your repo — every key populated so you can edit any knob in place.

### LLM models

| Key | Default | Description |
|---|---|---|
| `llm.model` | `claude-haiku-4-5-20251001` | Global default for every judge call. |
| `novelty.llm.model` | `claude-haiku-4-5-20251001` | Competitor classifier — Haiku-fast yes/no. |
| `sources.<name>.llm.model` | — | Per-miner override (e.g. Opus for arxiv capability validation). |

### Source toggles

Every source has the same shape: an `enabled` flag, plus per-source knobs. Run `/ideawright:config-init` to drop a fully-defaulted file with every key populated and inline comments.

| Key | Default | Notes |
|---|---|---|
| `sources.reddit.enabled` | `true` | Master switch. |
| `sources.reddit.subreddits` | `null` | Array of sub names without `/r/`; `null` falls back to 25 built-ins. |
| `sources.reddit.max_pages` | `10` | Pages per sub on first run; cursor-paginates afterward. Reddit hard-caps pagination at ~1000 posts deep regardless, so `>10` is wasted. |
| `sources.reddit.max_posts_per_sub` | `null` | Cap on **posts considered** per sub per run (observations emitted are typically fewer — only pain-matching posts pass). `null` = no cap (uses `max_pages * 100`). |
| `sources.reddit.seed_listings` | `["new"]` | Listings to scan only on the **first scan** of each sub (when no cursor exists). Each entry is its own ~1000-post window. Combine for deeper history. After the first scan, only `/new` runs incrementally. Format: `"<endpoint>"` or `"<endpoint>:<time>"`. Endpoints: `new`, `hot`, `top`, `controversial`. Time filters (top/controversial only): `hour`, `day`, `week`, `month`, `year`, `all`. Example: `["new", "top:all", "controversial:all"]`. |
| `sources.hn.enabled` | `true` | Master switch. |
| `sources.hn.lookback_days` | `60` | First-run window in days; cursor takes over after. |
| `sources.hn.max_per_query` | `100` | Algolia `hitsPerPage` per query (max 1000). |
| `sources.hn.queries` | `null` | Array of Algolia query strings; `null` falls back to 8 built-in pain phrases (`"i wish there was"`, `"someone should build"`, …). |
| `sources.github.enabled` | `true` | `GITHUB_TOKEN` env raises rate limit. |
| `sources.github.lookback_days` | `14` | First-run window for `updated:>=…` filter. |
| `sources.github.max_per_query` | `50` | GitHub `per_page` (max 100). |
| `sources.github.queries` | `null` | Array of GitHub Search query strings; `null` falls back to 3 built-ins (`is:closed reason:"not planned" comments:>5`, `label:"help wanted" no:assignee comments:>3`, `label:wontfix reactions:>10`). |
| `sources.arxiv.enabled` | `true` | Master switch. |
| `sources.arxiv.categories` | `["cs.AI", …]` | Array of arXiv categories; defaults to 10 cs+stat+qbio cats. |
| `sources.arxiv.require_code_url` | `false` | Set `true` to drop papers without a detected code link. |
| `sources.arxiv.lookback_days` | `14` | First-run window in days; cursor takes over after. |
| `sources.arxiv.max_per_query` | `50` | arXiv `max_results` per category. |
| `sources.biorxiv.enabled` | `true` | Master switch. |
| `sources.biorxiv.server` | `"biorxiv"` | `"biorxiv"` or `"medrxiv"` for medical preprints. |
| `sources.biorxiv.categories` | `["bioinformatics", …]` | Array of subject categories; defaults to 6 cats. |
| `sources.biorxiv.lookback_days` | `14` | First-run window in days. |
| `sources.biorxiv.max_per_run` | `300` | Hard cap on papers fetched per run (paginates 100 at a time). |
| `sources.pubmed.enabled` | `true` | `NCBI_API_KEY` env raises rate limit. |
| `sources.pubmed.lookback_days` | `14` | First-run window in days; cursor takes over after. |
| `sources.pubmed.max_per_query` | `100` | E-utilities `retmax` per query. |
| `sources.pubmed.queries` | `null` | Array of PubMed query strings; `null` falls back to 6 built-in software/algorithm/ML queries. |

### Novelty + ranking + digest

| Key | Default | Description |
|---|---|---|
| `novelty.batch_size` | 10 | Ideas per `/vet` batch and judge batch. |
| `novelty.novel_max` | 2 | ≤ this many competitors → `novel`. |
| `novelty.niche_max` | 5 | ≤ this many → `niche`. > → `crowded`. |
| `novelty.competitor_overlap` | 0.6 | Minimum overlap (0..1) for a search hit to count as a competitor. |
| `novelty.sources.<name>.enabled` | see above | Per-source novelty-battery toggle. |
| `feasibility.require_code_only` / `require_no_capital` / `require_no_private_data` | all `true` | Hard gates. Set `false` to keep ideas that fail them. |
| `weights.pain` / `novelty` / `feasibility` | `0.3 / 0.4 / 0.3` | Composite rank weights. |
| `digest.top_n` | `10` | Ideas in each daily digest file. |

### Optional env vars

| Var | Effect |
|---|---|
| `GITHUB_TOKEN` | Raises GitHub limits in both the issues miner and the novelty battery. |
| `NCBI_API_KEY` | Raises PubMed E-utilities to 10 req/s. |
| `EXA_API_KEY` | Required to enable the Exa source in the novelty battery. |
| `SEMANTIC_SCHOLAR_API_KEY` | Optional; raises Semantic Scholar rate limit. |
| `IDEAWRIGHT_LLM_MODEL` | Overrides the judge default model. |
| `IDEAWRIGHT_REPO_ROOT` | Override the working-directory root (where `.claude/ideawright/` lives). |

## State

`.claude/ideawright/` (auto-created):

| Path | Contents |
|---|---|
| `ideas.db` | SQLite WAL mode. Tables: `ideas` (lifecycle + JSON-stringified novelty/feasibility), `sources` (per-miner cursor + last-run timestamp), `state_log` (every status transition with actor + note). |
| `digests/YYYY-MM-DD.md` | One Markdown digest per `/ideawright:daily` run, listing the top-N promoted ideas. |

## Notes

- On Node 22.5–23 you'll see `ExperimentalWarning: SQLite is an experimental feature` on first DB touch. Suppress with `NODE_NO_WARNINGS=1` or upgrade to Node 24+.
- The runner doesn't schedule itself. Wire `/ideawright:daily` into a cron, GitHub Actions, or the Claude Code background agents feature.
- Each judge call spawns a fresh `claude -p` subprocess. Expect the LLM bill to dominate runtime — minimize by tightening source filters, lowering `novelty.batch_size`, or routing capability validation to Haiku via `sources.<name>.llm.model`.
