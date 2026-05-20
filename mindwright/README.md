# mindwright

Per-agent memory and cross-session learning for Claude Code multi-agent setups. Sibling of [wrightward](../wrightward), [agentwright](../agentwright), and [forgewright](../forgewright) in the toolwright family.

Each Claude session in your project quietly accumulates short-term observations as you work, then — either automatically (when the cap is crossed, mindwright spawns a background consolidator session) or on demand (`/mindwright:dream`) — distills them into long-term facts: user preferences, project conventions, role-specific procedural know-how, lessons learned from prior incidents. Future prompts pull from that memory by relevance; nothing is dumped at session start, nothing irrelevant is injected.

## Install

```
/plugin install mindwright@Joys-Dawn/toolwright
```

Mindwright prepares its local dependencies automatically in the background — there is no `npm install` step, and it self-heals the same way after every plugin update. While that finishes (a minute or two on a fresh install), memory capture stays quietly dormant, then switches on by itself. Recall additionally needs a one-time model download.

Then download the local embedder + cross-encoder — the one part that is *not* automatic (one-time, ~5 GB, ~5–15 min depending on your connection):

```
/mindwright:setup
```

If you run this right after installing, the background dependency prep may still be finishing — `/mindwright:setup` will tell you so and ask you to re-run it in a minute. That's expected, not a failure: the re-run proceeds to the model download once the dependencies are ready.

That's it. Mindwright is now active. The first prompt you type in any session will start populating its short-term memory.

#### Model supply-chain trust

`/mindwright:setup` downloads two ONNX models from Hugging Face — `Xenova/bge-m3` (embedder) and `Alibaba-NLP/gte-reranker-modernbert-base` (cross-encoder). They run inside ONNX Runtime in a single **machine-wide model daemon** (one process per machine, shared by every session and project — lazy-spawned, idle-exits), so a tampered model could in principle exfiltrate query text or produce embeddings that bias retrieval. The download path goes over HTTPS to Hugging Face's CDN — the trust root is the HF infrastructure plus your system's CA bundle. If your threat model includes a CA compromise or DNS hijack on the install machine, fetch the models manually on a trusted host, copy them into the model cache (`${CLAUDE_PLUGIN_DATA}/model-cache`, overridable with `MINDWRIGHT_MODEL_CACHE_DIR`, laid out as `<org>/<name>/`), and skip `/mindwright:setup` (the model daemon picks up the on-disk cache). Mindwright does not pin model revision hashes; if upstream updates the model, the next setup picks up the new weights.

## What you'll notice

- **Sessions feel context-aware.** Prompts whose topic overlaps with previous work get a small `mindwright recall:` block in front, listing the most relevant prior facts. If nothing relevant exists, nothing is injected (so you never see noise).
- **Memory is dual-tier.** Recent observations sit in **short-term**, which fills up over a few days of normal use. When the cap crosses (or you explicitly run `/mindwright:dream`), the oldest ~70% are distilled into durable **long-term** facts. The dream is reversible until you finalize it. Each long-term fact carries a `category` (procedural | episodic | fact) and a `scope` (user | project | role:<role>) — orthogonal axes, so a `fact/user` is a preference, a `fact/project` is a codebase truth, a `procedural/role:planner` is planner-specific know-how, and an `episodic/project` is a lesson-from-incident.
- **Auto-consolidation.** When short-term crosses the cap (50 rows by default), mindwright spawns a `claude --bg` background session that runs `/mindwright:dream` autonomously — you don't have to. The spawned consolidator is keyed by `(project, requesting_handle)` so it's stable across boots. If `claude` isn't on PATH (or the spawn fails for any other reason), the old "time to dream" prompt shows up on the next turn instead.
- **Memory is auditable.** Every fact is mirrored to plain markdown under `.claude/mindwright/mirrors/` — `recent.md`, `preferences.md`, `project.md`, `episodes.md`, `agents/<role>/heuristics.md`. Read them. Diff them in git if you want.
- **Drained short-term is archived.** When `/mindwright:dream` finalizes a drain, the raw short-term rows it discarded are copied to `.claude/mindwright/mirrors/dropped/<date>-<drain_id>.md` *before* the hard-delete runs. If the consolidator judged something not worth retaining, you can still grep the archive for it and hand-re-import. Set `MINDWRIGHT_DROPPED_ARCHIVE=off` to skip the archive entirely.
- **Models load once per machine.** The embedder + cross-encoder live in a single machine-wide model daemon shared by every session across every project — open ten sessions and the ~1–2 GB of weights load once, not ten times. It's lazy-spawned on first need, elects a singleton via a lock file, and idle-exits after 15 minutes of no requests. Hooks and skills reach it over a fixed local socket; if it's down they degrade cleanly (writes proceed with embeddings back-filled once it's up). There is no per-session memory server.
- **You can teach it your project's history — explicitly.** Seeding is **manual only**: run `/mindwright:seed-from-repo` and mindwright folds your existing material into short-term memory in one bounded, resumable pass — `CLAUDE.md`, `README.md`, Claude Code's native per-project memory, **and your conversation transcript history** (every pre-install `*.jsonl`, the current live session excluded). Each seeded item is anchored to *when it actually happened* (a fact from six months ago is recalled as six months old, not "just now"). The command distills each bounded slice into long-term right then, in the same session as it runs — seeding and consolidation are one user-invoked operation, not a separate dream step you run afterward. **Run it from a fresh session.** Because that pass *is* a consolidation, it also distills any short-term memory already present — including the working memory of the session you launch it from — into long-term (raw rows archived first, see above). That is exactly what you want when a clean session ingests history; launch it from one you have been actively working in and that session's in-progress memory is consolidated along with the history. There is no automatic on-install bootstrap and no background process is spawned on your behalf — it all happens only when you ask.
- **Prior conversations are skipped by default.** If you install mindwright mid-project and resume an existing Claude session, it skips the already-present transcript and starts fresh from the next turn — resuming does not retroactively pull in conversation that predates the install. To ingest history, run `/mindwright:seed-from-repo` (above). For the narrower "re-ingest *this* resumed session's prior transcript" case there is also `MINDWRIGHT_SEED_TRANSCRIPT=1`: set it before launching and the first tool call re-chunks that session's prior transcript from byte 0 (a SessionStart warning notes duplicates are likely; `/mindwright:dream`'s supersede check dedups them). While that env is set, the auto-spawned consolidator is suspended and the manual "time to dream" nudge is used instead — review the re-ingested content before consolidating.

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

Working memory is what the LLM is actively reasoning over — the live context window. Mindwright writes short-term rows from it (as the chunker observes the transcript), drains short-term into long-term via `/mindwright:dream`, and pulls relevance-ranked candidates from BOTH tiers back into working memory whenever a prompt arrives or a thinking block trips the retrieval gate.

## Slash commands

Run any of these from the Claude Code prompt.

| Command | What it does |
|---|---|
| `/mindwright:setup` | Download the embedder + cross-encoder, run a smoke test. Run once after install. |
| `/mindwright:status` | Current short / long-term counts, by-(category, scope) breakdown, last consolidation, model-cache state, and the auto-spawned consolidator's session id / handle when one exists. |
| `/mindwright:recall <query>` | Explicit retrieval, returns top-K with scores. Useful for debugging "why didn't X surface?" |
| `/mindwright:retain` | Manually save a fact (short or long term). |
| `/mindwright:forget <fact_id>` | Soft-archive a fact (it stops surfacing in retrieval; the row stays for audit). |
| `/mindwright:restore <fact_id>` | Inverse of forget — un-archive a soft-archived fact and put it back in retrieval. |
| `/mindwright:update-memory <fact_id>` | Supersede a fact with corrected content. The old row is archived and the chain is recorded. |
| `/mindwright:resolve-contradiction <a> <b>` | When two long-term facts contradict each other: prefer one, merge them, or scope each. |
| `/mindwright:dream` | Consolidate short-term into long-term. The session that runs the skill does the LLM distillation work itself — no separate API call. The auto-spawned background consolidator runs this same skill on cue. |
| `/mindwright:seed-from-repo` | Bootstrap from CLAUDE.md, README, and Claude Code's native per-project memory when memory is empty. Idempotent — re-running won't duplicate sources already waiting to be consolidated. |
| `/mindwright:assign-role <session> <role>` | Tag a session with a role (e.g. `consolidator`). |
| `/mindwright:unassign-role <session> <role>` | Untag a session. |
| `/mindwright:reset` | DESTRUCTIVE — drop the database and markdown mirrors. Models survive. Requires `--yes` to actually delete. |
| `/mindwright:help` | List the skills with one-line descriptions. |

## Config

Defaults are baked into the code (`lib/constants.js`). The knobs you're most likely to want to tune:

| Knob | Default | Effect |
|---|---|---|
| `cap_exchanges` | 50 | Short-term row count that surfaces the "time to dream" hint. Raise on quiet projects; lower if you want long-term hotter. |
| `drain_pct` | 0.70 | Fraction of oldest short-term rows consumed per dream. |
| `safety_net_days` | 3 | Surfaces the same "time to dream" nudge when any short-term row is older than this — catches quiet sessions that never cross the row-count cap. |
| `rerank_floor` | 0.75 | Cross-encoder sigmoid score below which a retrieval candidate is dropped. Calibrated against `gte-reranker-modernbert-base` — its score distribution is narrower than the older bge-reranker's, so the floor sits much higher than the legacy 0.10. |
| `recency_boost_days` | 14 | Recent rows get an additive boost on the semantic path (ordering only — the abstention floor still applies). |

If you want non-default values, edit `lib/constants.js` and re-run.

### Environment variables

Set these in your shell before launching Claude Code. Each one is read at hook firing time, so toggling mid-session works on the next event.

| Env var | Effect |
|---|---|
| `MINDWRIGHT_NUDGE=off` | Full opt-out for cap-tracking on the Stop hook: no auto-spawned consolidator, no pending nudge, no state-machine updates. Useful when you want to consolidate on your own cadence with `/mindwright:dream` and have mindwright stay completely quiet about it. |
| `MINDWRIGHT_SPAWN_DISABLE=1` | Disables the auto-spawned background `claude --bg` consolidator. Cap- and age-crossings fall back to the manual nudge instead. Use when you want every dream cycle to be explicit. |
| `MINDWRIGHT_SEED_TRANSCRIPT=1` | Re-ingest *this* resumed session's prior transcript on the next tool call (`What you'll notice` → "Prior conversations are skipped"). For full history seeding use `/mindwright:seed-from-repo` instead. Also implicitly suspends the auto-spawned consolidator while set — re-ingest typically pushes short-term past the cap, and you should review the seeded content before consolidation runs. |
| `MINDWRIGHT_MODEL_DAEMON_DISABLE=1` | Don't lazy-spawn the machine-wide model daemon. Embed/rerank then degrade to NULL-embedding writes (back-filled by a later sweep when a daemon is available). Use only if you run/manage the model daemon out-of-band. |
| `MINDWRIGHT_AUTO_INSTALL=false` | Opt out of the automatic background install of the plugin's native dependencies. Use only if you manage the plugin's `node_modules` yourself; with this set and the deps missing, mindwright stays dormant instead of self-healing. |
| `MINDWRIGHT_DROPPED_ARCHIVE=off` | Skip the post-drain `.claude/mindwright/mirrors/dropped/` archive that captures rows about to be hard-deleted. The audit copy is on by default — turn off only if disk usage matters more than recoverability. |

## Storage and audit

Everything mindwright knows about your project lives at:

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
└── tickets/                            # transient session-id files (SessionStart writes them; scripts + liveness read them)
```

**`.claude/mindwright/` should be gitignored.** Mirrors regenerate on every consolidation, and tracking the DB pollutes diffs.

Models cache in the plugin's persistent data dir (`${CLAUDE_PLUGIN_DATA}/model-cache`; override with `MINDWRIGHT_MODEL_CACHE_DIR`) — they survive plugin updates, `/mindwright:reset`, and project-level cleanup.

## Cost

- **Setup (one-time)**: model download, ~5 GB to disk. No API calls.
- **Steady state**: local embeddings on every UserPromptSubmit / gated PreToolUse, plus a cross-encoder rerank on the candidates that survive RRF. All local. No API spend.
- **Consolidation**: runs inside your active Claude Code session, so its tokens are billed against whatever subscription / API mode that session is using. Per-pass footprint at default settings: ~70K input tokens + ~3–5K output tokens. With `ANTHROPIC_API_KEY` unset (as recommended above), this comes out of your Max subscription quota.
- **Auto-spawned consolidation**: when short-term crosses `cap_exchanges` or trips the age safety-net, the Stop hook autonomously spawns a background `claude --bg` consolidator session that runs `/mindwright:dream` (see [Auto-consolidation](#what-youll-notice)). Its tokens come out of the same subscription / API account as your foreground sessions. **To disable the autonomous spawn and fall back to a manual "time to dream" nudge**, set `MINDWRIGHT_SPAWN_DISABLE=1` in your environment before launching Claude Code — `/mindwright:dream` then only runs when you invoke it explicitly.

## How memory comes to be

Every prompt, every tool call, and every reasoning block writes a short-term row. Inbound peer messages and Discord events from wrightward are also captured. None of this writes hits the network — it's local SQLite, ~10ms per write.

The prompt text and each thinking block are embedded and compared against the previous retrieval's query embedding via cosine similarity. If similarity exceeds the novelty threshold (`0.85`), the new query duplicates the one already on screen and retrieval is skipped — no fresh injection of nearly-identical context. Otherwise the embedding becomes the retrieval query, mindwright pulls top-K candidates (K scales with query length: 3 / 5 / 8) and filters against a per-session `injected_fact_ids` set so the same fact never re-injects. The cross-encoder then drops anything scoring below the `0.75` sigmoid floor (calibrated for gte-reranker's narrower score distribution; the legacy 0.10 was for bge-reranker); if nothing survives, you see nothing.

When you run `/mindwright:dream`, the calling Claude session reads the oldest 70% of short-term in batches grouped into exchanges, distills durable facts in its own context, categorizes each, marks contradictions against existing long-term, and writes the result back through deterministic helper commands (`node scripts/mindwright.mjs <tool>`, the same path every memory skill uses — there is no MCP server). The whole loop is reversible until the `finalize_drain` call that hard-deletes the consumed short-term rows.

## Multi-agent / wrightward

Mindwright is built for wrightward's peer setup but works fine on a solo session too. When peers send each other `agent_message`, `handoff`, `blocker`, `finding`, or `decision` events through the wrightward bus, the chunker picks them up as short-term content — so a peer's hand-off context becomes future retrieval signal across the whole team.

The `consolidator` role is the natural fit for a peer dedicated to dreaming: assign it via `/mindwright:assign-role <peer-handle-or-session-id> consolidator` and mindwright auto-spawns a background `claude --bg` session that runs `/mindwright:dream` on cue (the spawn is keyed by `(project, requesting_handle)`, so it's stable across boots and won't dogpile). The role argument also drives procedural-memory retrieval — `role:planner`, `role:reviewer`, `role:tester`, and any custom string all work; the built-in roles additionally inject a one-line role-identity fragment via SessionStart so a fresh peer knows what hat it's wearing.

## Architecture

The moving parts: a deterministic chunker writes short-term rows from the live transcript via Claude Code hooks; the **TEMPR** retrieval pipeline (4-way candidate gen → RRF fusion → cross-encoder rerank → abstention floor) pulls relevance-ranked facts from both tiers back into context; `/mindwright:dream` drains short-term into long-term. All memory operations run through one CLI (`scripts/mindwright.mjs`, invoked by the skills) against a per-project SQLite store; embed/rerank go to a single machine-wide model daemon. There is no MCP server and no per-session model process. The published overview lives at [the toolwright docs site](https://joys-dawn.github.io/toolwright/mindwright/).

## Requirements

- Node.js ≥ 20, with `npm` on `PATH`.
- Native dependencies (`better-sqlite3`, `sqlite-vec`, `@huggingface/transformers`) install automatically in the background on first use and re-heal after every plugin update — no manual `npm install`. `better-sqlite3` ships prebuilt binaries for common platforms; where one isn't available it compiles from source, which needs a C/C++ build toolchain.
- A one-time local model download via `/mindwright:setup` (the `Xenova/bge-m3` embedder + `Alibaba-NLP/gte-reranker-modernbert-base` cross-encoder, cached in the plugin's persistent data dir so it survives plugin updates and resets). No API calls; all retrieval is local.
- `claude` on `PATH` is used by the auto-spawned background consolidator. Optional — without it, mindwright falls back to the manual "time to dream" nudge.

## License

Apache-2.0
