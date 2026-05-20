# mindwright

> Per-agent memory and cross-session learning for Claude Code multi-agent setups. Each session quietly accumulates short-term observations as you work, then — automatically or on demand — distills them into long-term facts (preferences, conventions, role know-how, lessons learned). Future prompts pull from that memory by relevance; nothing is dumped at session start, nothing irrelevant is injected.

**Version**: 0.4.0 · [Source](https://github.com/Joys-Dawn/toolwright/tree/master/mindwright) · [README](https://github.com/Joys-Dawn/toolwright/blob/master/mindwright/README.md)

## Install

```text
/plugin marketplace add Joys-Dawn/toolwright
/plugin install mindwright@Joys-Dawn/toolwright
```

Then download the local embedder + cross-encoder (one-time, ~5 GB, ~5–15 min depending on connection):

```text
/mindwright:setup
```

Requires **Node.js ≥ 20**. Ships native npm dependencies (`better-sqlite3`, `sqlite-vec`, `@huggingface/transformers`). `claude` on `PATH` is used by the auto-spawned background consolidator — without it, mindwright falls back to a manual "time to dream" nudge. After `/mindwright:setup`, the first prompt in any session starts populating short-term memory.

### Model supply-chain trust

`/mindwright:setup` downloads two ONNX models from Hugging Face — `Xenova/bge-m3` (embedder) and `Alibaba-NLP/gte-reranker-modernbert-base` (cross-encoder). They run inside ONNX Runtime in a single machine-wide model daemon (one process per machine, shared by every session and project), so a tampered model could in principle exfiltrate query text or bias retrieval. The download is HTTPS to Hugging Face's CDN — the trust root is HF infrastructure plus your system CA bundle. If your threat model includes a CA compromise or DNS hijack on the install machine, fetch the models manually on a trusted host, copy them into the model cache (`${CLAUDE_PLUGIN_DATA}/model-cache`, overridable with `MINDWRIGHT_MODEL_CACHE_DIR`, laid out as `<org>/<name>/`), and skip `/mindwright:setup` (the model daemon picks up the on-disk cache). Model revision hashes are not pinned; an upstream update is picked up on the next setup.

## What you'll notice

- **Sessions feel context-aware.** Prompts whose topic overlaps prior work get a small `mindwright recall:` block in front listing the most relevant prior facts. If nothing relevant exists, nothing is injected — you never see noise.
- **Memory is dual-tier.** Recent observations sit in **short-term**, which fills over a few days of normal use. When the cap crosses (or you run `/mindwright:dream`), the oldest ~70% are distilled into durable **long-term** facts. Each long-term fact carries a `category` (procedural | episodic | fact) and a `scope` (user | project | role:&lt;role&gt;) — orthogonal axes.
- **Auto-consolidation.** When short-term crosses the cap (50 rows by default), mindwright spawns a `claude --bg` background session that runs `/mindwright:dream` autonomously. If `claude` isn't on `PATH` (or the spawn fails), the manual "time to dream" nudge shows up instead.
- **Memory is auditable.** Every fact is mirrored to plain markdown under `.claude/mindwright/mirrors/` — `recent.md`, `preferences.md`, `project.md`, `episodes.md`, `agents/<role>/heuristics.md`. Read them, diff them in git.
- **Drained short-term is archived.** Before `/mindwright:dream` hard-deletes drained rows, they're copied to `.claude/mindwright/mirrors/dropped/<date>-<drain_id>.md`. Set `MINDWRIGHT_DROPPED_ARCHIVE=off` to skip the archive.
- **Models load once per machine.** The embedder + cross-encoder live in a single machine-wide model daemon shared by every session across every project — ten open sessions load the ~1–2 GB of weights once, not ten times. Lazy-spawned on first need, singleton via a lock file, idle-exits after 15 min. Hooks and skills reach it over a fixed local socket and degrade cleanly when it's down (writes proceed; embeddings back-fill once it's up). No per-session memory server.
- **Seeding is manual and explicit.** There is no automatic on-install bootstrap. Run `/mindwright:seed-from-repo` and mindwright folds `CLAUDE.md`, `README.md`, Claude Code's native per-project memory, **and your conversation transcript history** (every pre-install `*.jsonl`; the current live session excluded) into short-term in one bounded, resumable pass — each item anchored to *when it actually happened* — then run `/mindwright:dream` to distill it. No background process is spawned on your behalf.
- **Prior conversations are skipped by default.** Resume an existing session after installing and mindwright skips the already-present transcript, starting fresh from the next turn (the SessionStart message says so). Use `/mindwright:seed-from-repo` to ingest history. For the narrower "re-ingest *this* resumed session's prior transcript" case, `MINDWRIGHT_SEED_TRANSCRIPT=1` before launching does that; while it's set the auto-spawned consolidator is suspended and the manual nudge is used (re-ingest typically pushes short-term past the cap — review before consolidating).

## Lifecycle

```
                       ┌────────────────────────┐
   user prompt ───────▶│   working memory       │◀────── retrieval (TEMPR)
                       │  (LLM context window)  │        relevance-ranked,
                       │                        │        pulled from BOTH
                       │  user msg, thinking,   │        tiers, injected via
                       │  tool I/O, retrieved   │        additionalContext
                       │  facts                 │
                       └───────────┬────────────┘
                                   │ chunker writes short-term rows
                                   │ (cli_prompt, thinking,
                                   │  outbound_send, inbox-event)
                                   ▼
         ┌─────────────┐  /mindwright:dream    ┌─────────────┐
         │ short-term  │ ────────────────────▶ │  long-term  │
         │    tier     │  drains oldest 70% →  │     tier    │
         │             │  calling session      │             │
         │             │  distills facts →     │             │
         │             │  retain_fact +        │             │
         │             │  mark_superseded      │             │
         └──────┬──────┘                       └──────┬──────┘
                │                                     │
                └──────────── retrieval ──────────────┘
                         pulls candidates from
                         BOTH tiers, ranks via
                         TEMPR (4-way → RRF →
                         cross-encoder → floor)
```

Working memory is the live context window the LLM reasons over. Mindwright writes short-term rows from it (as the chunker observes the transcript), drains short-term into long-term via `/mindwright:dream`, and pulls relevance-ranked candidates from both tiers back into working memory whenever a prompt arrives or a thinking block trips the retrieval gate.

## Slash commands

| Command | What it does |
|---|---|
| `/mindwright:setup` | Download the embedder + cross-encoder, run a smoke test. Run once after install. |
| `/mindwright:status` | Short / long-term counts, by-(category, scope) breakdown, last consolidation, model-cache state, the auto-spawned consolidator's session id / handle when one exists. |
| `/mindwright:recall <query>` | Explicit retrieval, returns top-K with scores. Useful for debugging "why didn't X surface?" |
| `/mindwright:retain` | Manually save a fact (short or long term). |
| `/mindwright:forget <fact_id>` | Soft-archive a fact (stops surfacing in retrieval; row stays for audit). |
| `/mindwright:restore <fact_id>` | Inverse of forget — un-archive a soft-archived fact. |
| `/mindwright:update-memory <fact_id>` | Supersede a fact with corrected content. Old row is archived, chain recorded. |
| `/mindwright:resolve-contradiction <a> <b>` | When two long-term facts contradict: prefer one, merge, or scope each. |
| `/mindwright:dream` | Consolidate short-term into long-term. The session running the skill does the LLM distillation itself — no separate API call. The auto-spawned consolidator runs this same skill on cue. |
| `/mindwright:seed-from-repo` | Bootstrap from CLAUDE.md, README, and Claude Code's native per-project memory when memory is empty. Idempotent. |
| `/mindwright:assign-role <session> <role>` | Tag a session with a role (e.g. `consolidator`). |
| `/mindwright:unassign-role <session> <role>` | Untag a session. |
| `/mindwright:reset` | DESTRUCTIVE — drop the database and markdown mirrors. Models survive. Requires `--yes`. |
| `/mindwright:help` | List the skills with one-line descriptions. |

## Config

Defaults are baked into `lib/constants.js`. There is no config file — to change a default, edit `lib/constants.js` and re-run. The knobs you're most likely to tune:

| Knob | Default | Effect |
|---|---|---|
| `cap_exchanges` | 50 | Short-term row count that surfaces the "time to dream" hint. Raise on quiet projects; lower if you want long-term hotter. |
| `drain_pct` | 0.70 | Fraction of oldest short-term rows consumed per dream. |
| `safety_net_days` | 3 | Surfaces the same nudge when any short-term row is older than this — catches quiet sessions that never cross the row-count cap. |
| `rerank_floor` | 0.75 | Cross-encoder sigmoid score below which a retrieval candidate is dropped. Calibrated against `gte-reranker-modernbert-base` — its score distribution is narrower than the older bge-reranker's, so the floor sits much higher than the legacy 0.10. |
| `recency_boost_days` | 14 | Recent rows get an additive boost on the semantic path (ordering only — the abstention floor still applies). |

### Environment variables

Each is read at hook-firing time, so toggling mid-session works on the next event.

| Env var | Effect |
|---|---|
| `MINDWRIGHT_NUDGE=off` | Full opt-out for cap-tracking on the Stop hook: no auto-spawned consolidator, no pending nudge, no state-machine updates. |
| `MINDWRIGHT_SPAWN_DISABLE=1` | Disables the auto-spawned background consolidator. Cap/age crossings fall back to the manual nudge. |
| `MINDWRIGHT_SEED_TRANSCRIPT=1` | Re-ingest *this* resumed session's prior transcript on the next tool call (for full history seeding use `/mindwright:seed-from-repo`). Also implicitly suspends the auto-spawned consolidator while set. |
| `MINDWRIGHT_MODEL_DAEMON_DISABLE=1` | Don't lazy-spawn the machine-wide model daemon; embed/rerank degrade to NULL-embedding writes back-filled by a later sweep. Only if you manage the daemon out-of-band. |
| `MINDWRIGHT_DROPPED_ARCHIVE=off` | Skip the post-drain `dropped/` archive that captures rows about to be hard-deleted. |

## Storage and audit

```
.claude/mindwright/
├── mindwright.db                       # SQLite + sqlite-vec + FTS5 — source of truth
├── mirrors/
│   ├── recent.md                       # most-recent short-term rows
│   ├── preferences.md                  # active fact/user rows
│   ├── project.md                      # active fact/project rows
│   ├── episodes.md                     # active episodic rows (lessons, post-mortems)
│   ├── agents/<role>/heuristics.md     # active procedural rows scoped to role:<role>
│   └── dropped/<date>-<drain>.md       # rows discarded by /mindwright:dream (audit)
└── tickets/                            # transient session-id files (SessionStart writes; scripts + liveness read)
```

**`.claude/mindwright/` should be gitignored.** Mirrors regenerate on every consolidation, and tracking the DB pollutes diffs. Models cache to `${CLAUDE_PLUGIN_DATA}/model-cache/` (overridable with `MINDWRIGHT_MODEL_CACHE_DIR`) — they survive `/mindwright:reset` and project-level cleanup.

## Cost

- **Setup (one-time)**: model download, ~5 GB to disk. No API calls.
- **Steady state**: local embeddings on every UserPromptSubmit / gated PreToolUse plus a cross-encoder rerank on RRF survivors. All local. No API spend.
- **Consolidation**: runs inside your active Claude Code session, billed against whatever subscription / API mode that session uses. Per-pass footprint at default settings: ~70K input + ~3–5K output tokens. With `ANTHROPIC_API_KEY` unset (recommended), this comes out of your Max quota.
- **Auto-spawned consolidation**: when short-term crosses `cap_exchanges` or trips the age safety-net, the Stop hook spawns a background `claude --bg` consolidator running `/mindwright:dream`. Same subscription / API account as foreground sessions. Set `MINDWRIGHT_SPAWN_DISABLE=1` to disable the autonomous spawn and fall back to a manual nudge.

## How memory comes to be

Every prompt, tool call, and reasoning block writes a short-term row (local SQLite, ~10 ms per write — no network). Inbound peer messages and Discord events from wrightward are captured too.

The prompt text and each thinking block are embedded and compared against the previous retrieval's query embedding via cosine similarity. If similarity exceeds the novelty threshold (`0.85`), retrieval is skipped — no fresh injection of nearly-identical context. Otherwise the embedding becomes the retrieval query, mindwright pulls top-K candidates (K scales with query length: 3 / 5 / 8), filters against a per-session `injected_fact_ids` set so the same fact never re-injects, and the cross-encoder drops anything below the `0.75` sigmoid floor (calibrated for `gte-reranker-modernbert-base`); if nothing survives, you see nothing.

When you run `/mindwright:dream`, the calling session reads the oldest 70% of short-term in exchange-grouped batches, distills durable facts in its own context, categorizes each, marks contradictions against existing long-term, and writes the result through deterministic helper commands (`node scripts/mindwright.mjs <tool>`, the path every memory skill uses — there is no MCP server). The whole loop is reversible until the `finalize_drain` call that hard-deletes the consumed rows.

## Multi-agent / wrightward

Mindwright is built for [wrightward](wrightward.md)'s peer setup but works fine solo. When peers exchange `agent_message`, `handoff`, `blocker`, `finding`, or `decision` events through the wrightward bus, the chunker picks them up as short-term content — a peer's hand-off context becomes future retrieval signal across the team.

The `consolidator` role is the natural fit for a peer dedicated to dreaming: assign it via `/mindwright:assign-role <peer-handle-or-session-id> consolidator` and mindwright auto-spawns a background session running `/mindwright:dream` on cue (keyed by `(project, requesting_handle)`, stable across boots, won't dogpile). The role argument also drives procedural-memory retrieval — `role:planner`, `role:reviewer`, `role:tester`, and any custom string all work.

## Architecture

A deterministic chunker writes short-term rows from the live transcript via Claude Code hooks. The **TEMPR** retrieval pipeline — 4-way candidate generation → RRF fusion → cross-encoder rerank → abstention floor — pulls relevance-ranked facts from both tiers back into context. `/mindwright:dream` drains short-term into long-term. Every memory operation runs through one CLI (`scripts/mindwright.mjs`, invoked by the skills) against a per-project SQLite store; embed/rerank go to the single machine-wide model daemon. There is no MCP server and no per-session model process. Source: [github.com/Joys-Dawn/toolwright/mindwright](https://github.com/Joys-Dawn/toolwright/tree/master/mindwright).

## License

Apache-2.0
