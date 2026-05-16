# mindwright — design snapshot

Scratch design doc to preserve context across compaction. Not finalized.

## Purpose

A claude-code plugin in the toolwright family. Memory + **learning** system for the multi-agent setup that wrightward enables. Goal: each peer session accumulates and applies relevant context over time, with shared project memory as the common substrate, and a consolidation cycle that produces durable behavioral improvements (not just dedup).

## Why build (not adopt)

Verified during scoping:

- **Hindsight (vectorize-io)** is the closest existing thing but is built around the Claude Code Task-tool subagent model — its `dynamicBankGranularity: ["agent", "project"]` keys on subagent identity, which doesn't exist for wrightward peer main processes. Also, Hindsight does **zero pruning, no TTLs, no size caps** (only an audit-log retention knob). Verified at https://github.com/vectorize-io/hindsight/blob/main/hindsight-docs/docs/developer/configuration.md
- **Anthropic Dreams API** (managed-agents-2026-04-01 + dreaming-2026-04-21 beta) is API-only, research-preview, not Claude Code CLI. Inspirational, not adoptable. We will build our own consolidation cycle.
- **Claude Code built-in memory** (CLAUDE.md + MEMORY.md) dumps first 200 lines / 25 KB into context at session start. Fails the relevance-on-demand requirement.
- **Letta, mem0, Zep/Graphiti** — all either competing runtimes or missing the multi-agent peer-main-process angle.

## Core requirements

1. **Per-agent memory** keyed by stable role identity (mindwright owns the role registry; wrightward only knows leader/peer).
2. **Project-wide memory** alongside — shared across all agents.
3. **Relevance-based retrieval**, not session-start dump. Inject what is relevant, when it is relevant.
4. **Consolidation / dream cycle** for pruning, summarization, reorganization, and behavioral refinement. Bounded growth.
5. **Learning, not just memory.** Per-agent stores capture procedural patterns (heuristics, calibrations, learned preferences) so the same role gets better at its job across sessions, not just remembers more.

## Decisions made so far

- **Storage**: SQLite (single `.claude/mindwright/mindwright.db`). FTS5 for keyword search, sqlite-vec extension for vector recall. Local, embedded, no external service — matches the "minimal user involvement" principle.
- **Embedding model**: `BAAI/bge-m3` by default — 1024-dim, **8192-token input context**, local (no API cost, no key required), ~570M params / ~2GB RAM when loaded. Chosen over bge-small-en-v1.5 (512-token window, 384-dim) so that every realistic thinking block fits in one pass — no chunking, no truncation. Empirically verified against the Stonk project transcripts (40 files, 7,784 thinking blocks): the largest single thinking block was ~4,060 tokens, well within 8192. Multilingual and strong on long-document retrieval. Configurable to API providers (OpenAI/Cohere/Gemini/Voyage) for users who want higher recall quality, but local is the default to honor the "minimal user involvement" principle.
- **Reranker model**: `BAAI/bge-reranker-v2-m3` — local cross-encoder paired with bge-m3, ~568M params, supports the same 8192-token context so query+candidate pairs never need truncation at rerank time. Used in step 4 of the retrieval pipeline to rerank the top-20 candidates from RRF fusion. Cross-encoder precision is much higher than bi-encoder cosine, but expensive at scale; affordable here because we only score 20 pairs.
- **Role identity**: stable identity is sessionId (which is stable across stop/resume — verified `wrightward/lib/handles.js:24-33`). A session has a *set* of active roles, not a single role — a single Claude process may simultaneously act as planner AND implementer on a small task. Mindwright maintains a registry mapping sessionId → role-set (additive). Per-role heuristics are keyed by role name, not sessionId, so a fresh session entering the planner role inherits the planner's accumulated learning.
- **Role assignment**: `/mindwright:assign-role` skill (additive — adds to the active set), invokable by the leader Claude OR by the user. Companion `/mindwright:unassign-role` to remove.
- **Memory categorization**: every fact produced by consolidation is tagged with two orthogonal axes — `category ∈ {procedural, episodic, fact}` (cognitive-science taxonomy: how-to vs what-happened vs declarative) and `scope ∈ {user, project, role:<role>}` (who it applies to). Cross-role bleed is controlled at consolidation time, not retrieval time. Retrieval is a single SELECT over the unified `entries` table filtered by `(tier, category, scope)` predicates that include `scope='user'`, `scope='project'`, and `scope='role:<r>'` for the session's active roles `r`. Single table → single index → no UNION.
- **Retrieval algorithm (TEMPR-style)**: 4-way parallel retrieval + Reciprocal Rank Fusion + cross-encoder reranking. Adapted from Hindsight's TEMPR (Temporal Entity Memory Priming Retrieval, arxiv:2512.12818). Always relevance-ranked; never dump-at-start. See "Retrieval pipeline" section below for the full algorithm.
- **Retrieval abstention via an absolute rerank floor** (default `rerank_floor=0.10` on the cross-encoder sigmoid score, calibrated for short-term tier; long-term tier will likely warrant a higher floor, deferred until the consolidator produces real distilled facts to test against). Hindsight returns top-K unconditionally even when nothing in memory matches — verified against their config. We do not. We drop any reranked candidate the cross-encoder scores below 10% likelihood of relevance, and return `[]` if everything is below the floor. **Surprise scoring (Bahri et al., arxiv:2010.09797) was the original choice and was tested-and-rejected via a real-data spike** at 325 rows and 7,778 rows: at 325 rows Surprise was neutral (the floor did all the abstention work); at 7,778 rows Surprise became actively harmful — it false-abstained on a clear-cut query ("What is Emma's role?", top-1 rerank=0.99 thrown away) and elevated demonstrably worse matches over better ones (a 0.29 candidate over a 0.73 candidate on "schema corrections"). Root cause: Surprise's noise-distribution assumption ("most candidates are non-relevant") breaks on thematically focused single-project transcripts where the lower half of top-50 is still on-topic content. The cross-encoder's sigmoid score IS the calibrated relevance signal we want; an absolute floor on it is the simpler, more reliable gate. Floor lives in `lib/constants.js` as `RERANK_FLOOR`; pin empirically via Cohere's 30–50-query procedure on real-workload data. Rejected alternatives: Hindsight's "no threshold" (returns top-K junk), two-stage Surprise (false abstention at scale, see spike), CRAG-style trained evaluator (requires labeled data we don't have), MemReranker swap (reranker upgrade, not an abstention mechanism — left as possible future drop-in).
- **Memory granularity**: facts are extracted per exchange (one user turn + assistant response). Number per exchange is determined by the consolidator model based on signal density — zero on a low-content turn (acknowledgements, routine tool churn), many on a high-content turn (architecture decisions, corrections, declarative claims, novel entities introduced). No numeric cap or floor. The Skill body provides examples and judgment criteria for what counts as signal. Hindsight's empirical 2-5 sweet spot is informative but enforced caps would underfit dense exchanges and overfit sparse ones.
- **Confidence scores on user-scoped facts**: rows with `category='fact'` and `scope='user'` carry a confidence value (0.0-1.0) set by the consolidator at distillation time as a one-shot signal-strength tag. The v1 store does not update confidence on reinforcement or contradiction — supersede-detection in step 5 of the dream pipeline produces a new row that supersedes the old; the new row carries its own (possibly higher or lower) one-shot confidence from the consolidator. A full "opinion network" with running confidence updates, decay-on-contradiction, and archive-below-threshold (matching Hindsight) is deferred — implementing it well needs deliberate choices about delta/decay rates, archival thresholds, and whether to expose those as user-tunable knobs, so it's a planned feature rather than something to grow inside the supersede helper. Future work; see Open Questions.
- **Consolidation triggers**: combination — size cap (primary), cadence safety net, and manual via `/mindwright:dream`. Size cap fires when short-term tier for a session reaches `CAP_EXCHANGES` rows. Cadence safety net fires if short-term has any content older than `SAFETY_NET_DAYS` (and the project-wide short-term row count is at least `SAFETY_NET_MIN_ROWS`, so a quiet repo doesn't re-nudge every few days on a couple of stale rows). Scheduled-cron and event-driven (post-audit, post-handoff-rejection, every N sessions) ideas dropped — size + cadence covers the same ground without coupling consolidation to bus events. Defaults `CAP_EXCHANGES=50`, `DRAIN_PCT=0.70`, `SAFETY_NET_DAYS=3`, `SAFETY_NET_MIN_ROWS=5` (calibrated to StepDx autonomy profile; edit `lib/constants.js` to override). See "Short-term and long-term memory tiers" section below for the full trigger model and rolling-drain algorithm.
- **Two-tier memory (short-term + long-term)**: memory is split into two tiers within a single unified `entries` table. Short-term holds incrementally-written filtered exchange chunks (thinking blocks, bus events, prompts) with embeddings — no LLM on the write path. Long-term holds distilled facts produced by consolidation. Both tiers share `vec_index` and `fts`; retrieval scans them in one pass with `tier` as a column filter. Consolidation drains the oldest `drain_pct` of short-term rows and produces long-term facts. See "Short-term and long-term memory tiers" section for the full model.
- **Short-term write path is multi-trigger and incremental**: writing only at the `Stop` hook is too coarse — an autonomous-loop turn can span hours with hundreds of tool calls, and concentrating writes at turn end loses within-turn learning. Writes happen at `UserPromptSubmit` (incoming prompt), `PreToolUse` (everything new in the transcript since last hook firing), and `Stop` (tail capture). The same deterministic chunker used during consolidation runs in streaming mode against `[last_offset, EOF]` of the live transcript file. Per-hook overhead ~10-15ms.
- **Storage shape**: single `entries` table with `tier` and `category` columns; `observations`, `facts`, `heuristics`, `preferences`, `project_facts` are views over it. Single `vec_index` and `fts` index — retrieval does not UNION across multiple physical tables. Closes prior Open Question #4.
- **Consolidator is per-`(project, requesting_handle)`** — keyed by the (project_path_hash, requester_handle) pair, persisted under `meta:consolidator_for:<requester_handle>`, so the same peer in the same project always resolves to the same consolidator session UUID across boots. Each peer that crosses the cap spawns its own consolidator (not a single shared one across the team) — Shared-consolidator was the alternative; rejected for coupling reasons (one stuck consolidator would hold up multiple peers' promotion). Cross-peer pattern detection is deferred to the next consolidation pass — the consolidator's supersede-detection step (step 5 in the dream pipeline) reads long-term, which already contains all sessions' freshly-promoted facts.
- **Pruning policy**:
  - Short-term (`tier='short'`) rows: drained by the rolling consolidation pass and hard-deleted (they are now reflected in long-term facts + supersede chain). The `(1 - drain_pct)` newest rows stay as the sliding window. Manual full-drain via `/mindwright:dream --scope=session` empties short-term entirely.
  - Long-term project-scoped facts (`tier='long', category='fact', scope='project'`): do **not** delete unless completely invalidated by changes. **Soft cleanup once a store passes a size threshold** — archive low-value/low-recency entries.
  - Long-term user-scoped facts: archived only via the same supersede chain as other rows (a newer fact superseding an older one) or via explicit `/mindwright:forget`. Confidence-decay-driven archival is deferred with the opinion-network work above.
  - Size threshold defaults: ~50K long-term rows OR ~100MB total, whichever first. sqlite-vec brute-force scan is O(N×D), so at bge-m3's 1024-dim float32 the same 100K-vector scan that takes 67ms at 384-dim runs ~2.7× slower (~180ms). int8 quantization is therefore **on by default for bge-m3** — 100K vectors at 1024-dim int8 lands around 45ms, restoring the comfortable sub-50ms budget. Threshold is a config knob.
  - One policy, no verbose debug tier. Tests cover correctness.
- **Consolidator is a registered role.** Consolidation/dream work is a heavy job (LLM-driven pattern extraction, categorization, synthesis), so it's handled by a session that has the `consolidator` role assigned. The leader Claude can spawn a dedicated peer to act as consolidator on a schedule, or any session can take the role for a one-off dream. Consolidation runs as a Skill invocation inside that session's normal turn loop — no separate API key, no background daemon, model is whatever Claude Code is running (Opus by default).
- **Bootstrap**: auto-seed from local Claude Code transcripts (`~/.claude/projects/<encoded-cwd>/*.jsonl`) on first run with empty memory. A dedicated bounded, resumable loop (`lib/seed-loop.js`) ingests pre-install transcripts into `tier='short', kind:'seed'` rows — each carrying its JSONL record's real `timestamp` as `event_ts` (true historical provenance) and a durable `<basename>:<uuid>` source_ref — then the **existing** `/mindwright:dream` consolidation cycle distills them. The loop does *not* reimplement distillation: same pipeline, same output shape as organic consolidation. It is separate from the cap-50 nudge only as an ingest/bounding driver (the nudge never fires on a zero-row install).
- **Transcript filter (deterministic, no LLM).** Pre-filter strips tool noise before consolidation reads transcripts. Verified against actual JSONL structure. Keep:
  - `user` records with plain-string content (real CLI-typed user messages + channel-doorbell notifications).
  - `user` records' `tool_result` blocks if the originating `tool_use_id` maps to a tool name in the wrightward inbox allowlist (`wrightward_list_inbox`) — this is where Discord user messages live in the transcript.
  - `assistant` content blocks of type `text` or `thinking`.
  - `assistant` content blocks of type `tool_use` if the tool name is in the wrightward communication allowlist: `wrightward_send_message`, `wrightward_send_note`, `wrightward_send_handoff`, `wrightward_ack` — captures outbound agent→user/peer Discord messages.
  Drop everything else: all other top-level record types (`attachment`, `last-prompt`, `permission-mode`, `ai-title`, `system`, `queue-operation`, `file-history-snapshot`), all non-wrightward `tool_use` blocks (file ops, shell, etc.), all non-wrightward `tool_result` blocks. Implementation is single-pass with a `tool_use_id → tool_name` map maintained as we go. Pure structural traversal; deterministic; ~5-10% of original token count retained, ~100% of signal preserved including the Discord conversation.
- **Repo/native-memory seed**: an always-included scan of README + CLAUDE.md + Claude Code's native per-project memory (`~/.claude/projects/<encoded-cwd>/memory/*.md`) into short `seed` rows, idempotent on re-run. Manual trigger: `/mindwright:seed-from-repo`. (No git-log scan — removed; commit subject-lines were low-signal noise next to transcripts and native memory.) The automatic transcript bootstrap above is gated by `MINDWRIGHT_AUTO_SEED=false` to disable. (Differentiator vs Hindsight, which has no seeding at all.)
- **Audit trail**: markdown mirrors (write-through from SQLite) for human auditability and git-diff visibility. SQLite is the source of truth; mindwright owns writes; markdown is rendered/regenerated, never edited by users directly.

## Architecture sketch

```
.claude/mindwright/
├── mindwright.db            # SQLite (source of truth)
│   ├── entries              # unified table — all memory rows live here
│   │                        #   columns: id, tier, category, scope, kind, content, source_ref,
│   │                        #            created_at, supersedes, confidence
│   │                        #   tier ∈ {short, long}
│   │                        #   category ∈ {raw, procedural, episodic, fact}
│   │                        #   scope ∈ {user, project, role:<role>}
│   │                        #   views (no physical tables, just SELECTs over entries):
│   │                        #     observations  := tier='short'
│   │                        #     facts         := tier='long'
│   │                        #     heuristics    := tier='long' AND category='procedural' AND scope LIKE 'role:%'
│   │                        #     preferences   := tier='long' AND category='fact' AND scope='user'
│   │                        #     project_facts := tier='long' AND category='fact' AND scope='project'
│   │                        #     episodes      := tier='long' AND category='episodic'
│   ├── entities             # extracted entities for graph-style joins
│   ├── entry_entities       # join table linking entries to entities (many-to-many)
│   ├── vec_index            # sqlite-vec embeddings (1024-dim, bge-m3, int8 by default), one row per entry
│   ├── fts                  # FTS5 keyword index over entry content
│   ├── offsets              # per-session transcript offset markers (session_id, last_read_byte, updated_at)
│   ├── consolidations       # dream history: session_id, fired_at, drained_count, drained_bytes, produced_count
│   └── meta                 # sessionId→role-set registry, retention state, config snapshot
├── project.md               # rendered mirror of long-term project-scoped facts (tier='long', category='fact', scope='project')
├── preferences.md           # rendered mirror of user-scoped facts (tier='long', category='fact', scope='user')
├── episodes.md              # rendered mirror of episodic long-term rows (tier='long', category='episodic')
├── recent.md                # rendered mirror of short-term entries (tier='short'), global across all roles
├── dropped/                 # dated audit trail of drained short-term rows that did not survive consolidation
│   └── <date>-<drain>.md
└── agents/
    └── <role>/
        └── heuristics.md    # rendered mirror of role-scoped procedural rows (tier='long', category='procedural', scope='role:<role>')
```

Plugin source tree (under `mindwright/`):

```
lib/
├── constants.js          # numeric defaults (RRF_K, RERANK_FLOOR, CAP_EXCHANGES, ...) +
│                         # ROLE_PATTERN / SESSION_ID_PATTERN path-safety regexes
├── paths.js              # resolves dataDir / dbPath / mirrorsDir / pipePath; rejects
│                         # session_ids that fail SESSION_ID_PATTERN before they reach disk
├── store.js              # better-sqlite3 wrapper: schema migration, insertEntry,
│                         # setOffset/getOffset, setPendingNudge/takePendingNudge,
│                         # markSuperseded, softArchive, countShortTermFor, countByTier, ...
├── transcript.js         # raw transcript JSONL reader (offset-aware)
├── chunker.js            # deterministic filter: turn JSONL records into short-term rows
├── transcript-flush.js   # shared "offset → chunk → insert → setOffset" loop used by
│                         # UPS, pre-tool-use, stop, session-end hooks
├── recall-format.js      # defangs + frames retrieved rows for additionalContext
│                         # injection (OWASP LLM01 mitigation)
├── retrievers.js         # the four parallel retrievers (semantic / BM25 / graph / temporal)
├── rrf.js                # reciprocal rank fusion (k=60)
├── retriever.js          # end-to-end TEMPR pipeline: query analysis → 4-way →
│                         # RRF → cross-encoder rerank → rerank_floor cutoff
├── models.js             # transformers.js bge-m3 + bge-reranker-v2-m3 singletons
├── pipe-client.js        # hook-side JSON-RPC client over the named-pipe / unix-socket
├── categorize.js         # deterministic fallback categorizer for retain when caller omits
│                         # `category` on a long-tier write
├── entities.js           # extractEntities (regex scan) + classifyEntity (single source
│                         # of truth for entity-kind mapping)
├── consolidator.js       # drainBatch / retainFact / markSuperseded / finalizeDrain
│                         # building blocks the /mindwright:dream skill drives
├── consolidator-spawn.js # spawnConsolidator: `claude --bg --session-id <uuid>
│                         # --permission-mode acceptEdits --append-system-prompt
│                         # <consolidator role prompt> "/mindwright:dream"`. Identity
│                         # keyed by (project_path_hash, requester_handle) and
│                         # persisted under meta:consolidator_for:<requester_handle>.
│                         # MINDWRIGHT_SPAWN_DISABLE=1 short-circuits to fallback.
├── role-prompts.js       # registry of role → prompt-fragment strings. SessionStart and
│                         # the inbox PostToolUse hook concatenate the fragments for
│                         # the session's assigned roles into additionalContext.
├── role-sidecar.js       # per-session role-set cache at
│                         # `.claude/mindwright/sessions/<session_id>/role.json` —
│                         # lets the inbox PostToolUse hook diff cheaply without
│                         # re-hitting the DB on every wrightward bus-read.
├── agents-roster.js      # resolveTargetToSessionId: handle ↔ session_id mapping via
│                         # wrightward's on-disk roster.
├── handles.js            # deriveHandle(session_id): pure 1:1 mapping mirroring
│                         # wrightward/lib/handles.js for cross-plugin parity.
└── mirrors.js            # renderAll: rewrites recent.md / preferences.md /
                          # project.md / episodes.md / agents/<role>/heuristics.md
                          # and the dropped/<date>-<drain>.md archive from SQLite

mcp/
├── server.mjs            # MCP stdio server. Owns the writable SQLite handle, the model
│                         # singletons, the JSON-RPC pipe listener, and a 60s sweeper
│                         # that backfills NULL embeddings for rows written in degraded
│                         # mode while the daemon was booting. MCP stdio + pipe socket
│                         # are the liveness anchors; no separate heartbeat task.
├── tools.mjs             # MCP tool definitions + dispatcher (recall, retain, status,
│                         # drain_batch, retain_fact, mark_superseded, finalize_drain,
│                         # get_roles, assign_role, unassign_role, update_memory,
│                         # forget, restore, resolve_contradiction)
├── session-bind.mjs      # poll tickets to learn which Claude Code session this MCP
│                         # server belongs to
├── daemon-pipe.mjs       # JSON-RPC server (embed + rerank) over named-pipe/unix-socket
└── daemon-ticket.mjs     # ticket writer (per-session) read by session-bind

hooks/                    # SessionStart / UserPromptSubmit / PreToolUse /
                          # PostToolUse (narrow-matched to wrightward_list_inbox) /
                          # Stop / SessionEnd
scripts/                  # setup.js / status.js / reset.js / seed-from-repo.js
skills/                   # one SKILL.md per slash command
```

Hook scripts, `mcp/server.mjs`, and `scripts/seed-from-repo.js` guard their `main()` with
`import.meta.url === pathToFileURL(process.argv[1]).href` so unit tests can `import`
the modules without triggering side-effects (DB writes, pipe binds, model loads).

Hooks (Claude Code-native). Every hook that touches the transcript shares one mechanism: read from the per-session offset in `offsets` table to EOF, run the deterministic chunker over new content, write one short-term row per primary-content block, update the offset. Writes are unconditional; retrieval is gated separately.

- `SessionStart`: load role assignment for sessionId, init connection. **Does NOT dump memory contents** — only metadata. Retrieval happens on demand. Always injects the self-recall rule (the constant `SELF_RECALL_RULE` from `lib/constants.js`) and, for every role currently assigned to this session, the role-identity prompt fragment from `lib/role-prompts.js` — both delivered via `hookSpecificOutput.additionalContext`. Clears `meta:injected_fact_ids:<sessionId>` so the per-session dedup set starts fresh. Initializes the per-session offset marker to current EOF for fresh sessions, leaves resumed sessions' markers untouched. Caches the role-set in `.claude/mindwright/sessions/<session_id>/role.json` for the inbox PostToolUse hook to diff against. Hosts the transcript-bootstrap auto-trigger (`shouldAutoSeed` → fire-and-forget `scripts/seed-loop.js`) — see "Auto-trigger" below; SessionStart is the only hook that runs before the turn's first flush, so it is the only place the gate's empty-memory precondition can be observed.
- `UserPromptSubmit`: (1) write a short-term row for the incoming prompt (kind=`cli_prompt`); (2) advance offset over any new transcript content and chunk it (rare here but covers compaction-summary cases); (3) run turn-start retrieval with query = the prompt text; return top-K via `hookSpecificOutput.additionalContext`.
- `PreToolUse`: (1) read transcript from stored offset to EOF, run the chunker, write one short-term row per primary-content block found since last firing (thinking, text, outbound `wrightward_send_*`, inbox-event rows when present); update offset. (2) Identify the most recent thinking block from the chunk just processed — this is the query for gated mid-turn retrieval. Gate logic for retrieval injection (NOT for short-term writes, which always run): embed the thinking block; fire retrieval when `cosine(thinking_emb, meta:last_retrieval_query_emb:<sessionId>) < NOVELTY_THRESHOLD` (default `0.85`). The first PreToolUse of a session has no prior embedding and always fires. Top-K is bucketed by thinking length: `len ≤ 200 → K=3`, `len ≤ 1000 → K=5`, `len > 1000 → K=8`. Both PreToolUse and PostToolUse honor `hookSpecificOutput.additionalContext` per https://code.claude.com/docs/en/hooks (verified 2026-05-13) — mindwright uses PreToolUse for novelty-gated retrieval.
- `PostToolUse` (narrow-matched to `wrightward_list_inbox` only): a bus-read is the moment new external context lands (peer handoffs, findings, decisions, Discord user messages) — exactly when re-grounding the self-recall rule and any newly-assigned role prompts is useful. The hook reads the active role-set, diffs it against the sidecar cache at `.claude/mindwright/sessions/<session_id>/role.json`, injects the role-prompt fragment for each newly-added role (and a "no-longer-applies" note for each removed role), and re-injects `SELF_RECALL_RULE` so the rule stays sticky across compaction and long conversations. Matcher is narrow (only `wrightward_list_inbox`) because re-injecting on every tool call would spam context and re-injecting on outbound `wrightward_send_*` is redundant (sends are the agent's own action).
- `Stop`: (1) flush remaining transcript content (offset → EOF) as a tail capture — picks up the final assistant text and any thinking that followed the last tool call. (2) Check consolidation trigger (cap crossed via `countShortTermFor(sessionId) ≥ CAP_EXCHANGES` OR an existing short-term row older than `SAFETY_NET_DAYS` while project-wide row count meets `SAFETY_NET_MIN_ROWS`). On trigger, first attempt to spawn a dedicated `claude --bg` consolidator session via `spawnConsolidator` (see "Mindwright-owned consolidator spawner" below): the spawn is keyed by `(project_path_hash, requester_handle)` and persisted under `meta:consolidator_for:<requester_handle>`, so the same peer+project pair always resolves to the same consolidator session UUID. If spawning succeeds, the consolidator picks up `/mindwright:dream` autonomously and the calling session continues. If `claude` isn't on PATH, the spawn fails for any other reason, or `MINDWRIGHT_SPAWN_DISABLE=1` is set (test/opt-out escape hatch), fall back to staging a pending nudge string in `meta` via `store.setPendingNudge(sessionId, "...")`; the next `UserPromptSubmit` hook drains it via `store.takePendingNudge(sessionId)` and prepends it to `hookSpecificOutput.additionalContext`. (Stop-hook `additionalContext` is not surfaced to the next turn by Claude Code, so the pending-nudge two-step is the only way to land the nudge in the next session start.)
- `SessionEnd`: flush any pending writes (offset → EOF), check consolidation trigger one more time. No background scheduling — consolidation only runs when a session with the `consolidator` role is alive to do it.

Bus integration (wrightward):

Bus events touch two paths: short-term writes (via the receiving session's transcript chunker — covered in "Hooks") and retrieval-and-injection (described here).

- Subscribe to `user_message`, `agent_message`, `handoff`, `blocker`, `finding`, `decision` events. `ack` is explicitly excluded — it carries no new conversational content worth retrieving against and is filtered out by the chunker.
- `user_message` events (Discord-originated): the second ingress path — see "Discord ingress pathway" below. Retrieval-and-injection triggers: query the bus event `body`, return relevant memory via channel doorbell (SystemReminder) or a mindwright-owned parallel bus event the target session picks up on its next tool call. The event itself is written to short-term as a `discord_user` row by the receiving session's `PreToolUse` chunker once that session calls `wrightward_list_inbox`.
- `agent_message`, `handoff`, `blocker` events (peer-originated conversational): same retrieval-and-injection trigger as above. A peer handing off work or surfacing a blocker is signal worth priming the receiving session with relevant memory. Written to short-term by the receiving session's chunker (kind=`agent_message`/`handoff`/`blocker`).
- `finding`, `decision` events: same retrieval-and-injection. Written to short-term (kind=`finding`/`decision`) and then promoted to long-term at the next consolidation pass — usually as `category='fact', scope='project'` or `category='procedural', scope='role:<role>'`, depending on whether the row carries a project-wide claim or a role-specific how-to. They do NOT skip short-term, even though they are semantically more "facty" than chatter, because all promotion to long-term goes through the consolidator's distillation step (which is where category/scope routing and supersede detection happen).

Skills:
- `/mindwright:assign-role <session-or-handle> <role>` — adds a role to the target session's active set
- `/mindwright:unassign-role <session-or-handle> <role>` — removes a role from the active set
- `/mindwright:dream [--scope=session|project|all]` — manual consolidation trigger. Default (`--scope=session`, no flag): runs the rolling drain on this session's oldest `drain_pct` of short-term rows. `--scope=project`: runs a rolling drain across every session's short-term in this project. `--scope=all`: runs a *full* (non-rolling) drain — consolidates 100% of short-term for the chosen target, regardless of `drain_pct`. Use the full drain when you want to clear short-term before a long break, or when bootstrapping.
- `/mindwright:recall <query>` — explicit ad-hoc retrieval (debug + transparency)
- `/mindwright:retain <note>` — explicit save
- `/mindwright:forget <fact_id>` — soft-archive a single long-term fact (audit trail preserved via `active=0`)
- `/mindwright:update-memory <fact_id> <new_content>` — supersede a single fact with corrected content. Use when the agent has just discovered that a specific memory is wrong (e.g. retrieval returned a fact, the agent looked at the code, and the fact is stale). Creates a new fact and marks the old one superseded; supersede chain preserved for audit.
- `/mindwright:forget <fact_id>` — soft-archive a long-term fact (`active=0`). Row stays in the DB for audit but stops surfacing in retrieval and markdown mirrors. Reversible by flipping `active=1` in SQL.
- `/mindwright:resolve-contradiction <fact_id_a> <fact_id_b> <resolution>` — handle two facts that clash. `resolution` ∈ `{prefer_a, prefer_b, merge, scope_both}`. `scope_both` is the right choice when both are correct but apply to different conditions (common for `procedural`/`role:<role>` heuristics — "X works when Y, doesn't when Z"); produces two narrowed-scope facts in place of the originals. Category × scope determines downstream behavior: `(fact, user)` clashes adjust confidence rather than hard-archive; `(fact, project)` clashes archive the loser; `(procedural, role:<role>)` clashes often resolve via narrowing.
- `/mindwright:seed-from-repo` — opt-in initial seeding from CLAUDE.md + README + native per-project memory into short `seed` rows (idempotent; the next dream distills them)
- `/mindwright:status` — show what's been learned, store sizes, last consolidation

MCP tools (surface matches `mcp/tools.mjs`):
- `mindwright_recall(query, scope?, k?, roles?, exclude_ids?)` — TEMPR retrieval. The `scope` argument here is a TIER filter (`'short'|'long'|'all'`, default `'all'`); the memory-row scope filter is applied implicitly via the calling session's role-set, overridable with `roles`. Returns `{results: []}` when nothing crosses the rerank floor. Caller-supplied `exclude_ids` stack on top of the automatic per-session injected-ids dedup.
- `mindwright_retain(content, kind, tier, category?, scope?, confidence?)` — explicit save into short or long tier. `tier` selects the storage tier; `scope` selects the memory-row audience (`'user'|'project'|'role:<role>'`) for long-tier writes. `category` auto-falls-back to the deterministic `lib/categorize.js` heuristic for long-tier writes when omitted.
- `mindwright_status()` — diagnostic snapshot `{short_count, long_count, by_category, by_category_scope, last_consolidation, model_cached, daemon_alive, pending_embeds, oldest_user_fact_at, consolidator: { session_id, handle, first_seen, last_spawn } | null}`. `by_category_scope` keys are strings like `'fact/user'`, `'procedural/role:planner'`, `'episodic/project'`. `consolidator` is non-null when this requester has ever spawned a background consolidator session in this project.
- `mindwright_drain_batch(scope?)` — opens a /mindwright:dream cycle. `scope` ∈ `'session'|'project'|'all'` (default `'session'`). Returns `{drain_id, exchanges, existing_long_term_summary}`. The `drain_id` is an opaque cursor of the form `<scope>|<cutoff_ts>|<cutoff_id>` (cutoff_ts is the `created_at` of the last drained row; cutoff_id is the `entries.id` of that row, used for same-millisecond tie-break). Callers must pass it back verbatim to `mindwright_finalize_drain`.
- `mindwright_retain_fact(drain_id?, exchange_id?, content, category, scope?, role?, entities?, confidence?)` — deterministic helper inside the dream cycle. Embeds the fact, inserts a long-term row, runs supersede-candidate detection. Returns `{fact_id, supersede_candidates}`.
- `mindwright_mark_superseded(old_id, new_id)` — archive `old_id` and link the chain. Used by step 5 of the dream cycle.
- `mindwright_finalize_drain(drain_id, drainCutoff?, drainCutoffId?, sessionId?, confirm_all_sessions?)` — close the dream cycle: hard-delete the drained rows (cutoff re-derived from the opaque drain_id token), append a `consolidations` row, regenerate markdown mirrors. `confirm_all_sessions: true` is required when the drain was opened with `scope: 'all'` so a prompt-injected memory can't trick a session into wiping other sessions' rows.
- `mindwright_get_roles(target?)` — returns the active role-set. `target` accepts either a UUID session id OR a wrightward handle (e.g. `bob-42`); mindwright resolves handle → session_id via the on-disk wrightward roster. Omit to read the calling session's own roles.
- `mindwright_assign_role(target, role)` — additive (adds to the existing set). `target` accepts handle or session_id. Assigning `consolidator` to a peer auto-spawns a background `claude --bg` consolidator session keyed by `(project, requester_handle)`; the response carries `spawn_result` describing the outcome.
- `mindwright_unassign_role(target, role)` — removes a role from the active set.
- `mindwright_update_memory(fact_id, new_content)` — supersedes a single fact in place. Writes a new fact row, links the old via `supersedes` reference, marks the old one inactive. Response includes `old_content_preview` for the caller to echo back.
- `mindwright_forget(fact_id)` — soft-archive a long-term fact (`active=0`). Reversible via `mindwright_restore`; the auto path treats the fact as gone. Response includes `content_preview` for echo-back.
- `mindwright_restore(fact_id)` — inverse of forget; flips `active=1` and regenerates mirrors.
- `mindwright_resolve_contradiction(fact_id_a, fact_id_b, resolution, scope_a?, scope_b?, merged_content?)` — `resolution` ∈ `{prefer_a, prefer_b, merge, scope_both}`. `scope_both` requires `scope_a` and `scope_b` strings describing the conditions each fact applies to; produces two new scoped facts. `merge` requires `merged_content`. Always called by the agent that *discovered* the clash — whoever has current context, not a delegated authority. The dream cycle also invokes this internally during step 5 (supersede detection) when it spots conflicts across categories.

**MCP tools are the mechanism. Skills are thin wrappers.** Following wrightward's pattern (verified at `wrightward/skills/ack/SKILL.md` etc.): MCP tools carry the actual logic and are what the agent ultimately calls; skills are short SKILL.md files that document when/how to invoke the matching MCP tool. A few skills (e.g. `/mindwright:status`, `/mindwright:seed-from-repo`) have no MCP equivalent and run a utility script directly. Skills exist so that user-typed slash commands and LLM-discoverable command surfaces both route through the same explanations.

## Short-term and long-term memory tiers

Memory splits into two tiers in one unified `entries` table, distinguished by a `tier` column.

**Short-term** holds filtered exchange chunks written incrementally throughout a session — agent thinking blocks, peer bus events, CLI prompts, outbound agent messages, intermediate text. Embeddings are computed at write time (bge-m3, ~5-10ms per chunk). No LLM is invoked on the write path; it is mechanical and cheap. Short-term acts as the sliding-window working memory for the running session and is the substrate the consolidator distills.

**Long-term** holds distilled rows produced by the consolidator (a session with the `consolidator` role running `/mindwright:dream`). Each long-term row carries a `category` ∈ `{procedural, episodic, fact}` and a `scope` ∈ `{user, project, role:<role>}`; rows with `(category='fact', scope='user')` additionally carry a confidence score. Long-term persists across sessions and is what most retrievals end up serving.

Both tiers share `vec_index` and `fts` — retrieval scans them together, with `tier` available as a column filter. Short-term rows are drained by consolidation and turned into long-term rows; long-term rows persist indefinitely subject to size-threshold cleanup.

### Write path (multi-trigger, incremental)

Writing only at the `Stop` hook is too coarse: an agent in autonomous-loop mode can run a single turn for hours with hundreds of tool calls, and concentrating writes at turn end loses within-turn learning. The actual write path is per-tool-call granular, using the live transcript file as the source of truth and a stored offset per session to avoid re-reading content already chunked.

Three trigger surfaces (full details in "Hooks" section above):

| Hook | Role |
|---|---|
| `UserPromptSubmit` | Write `cli_prompt` row for incoming prompt; advance offset. |
| `PreToolUse` | Read transcript from offset to EOF; chunk into rows; write all new primary-content blocks since last firing; advance offset. Then run gated retrieval. |
| `Stop` | Tail flush (offset → EOF). Check consolidation trigger. |

The chunker is the same code path that consolidation uses to filter a full transcript — running in streaming mode against `[last_offset, EOF]` instead of `[0, EOF]`. Same kind-assignment rules, same wrightward allowlist, same exclusions (acks, autonomous-loop sentinels, channel doorbells, compaction summaries).

Per-hook overhead: offset-seek transcript read (~ms) + N embedding computations (~5-10ms each). Typical PreToolUse adds ~10-15ms for a single new thinking block. Inserts are WAL-safe; multiple peers writing concurrently to the same `entries` table is supported.

### Retrieval integration (tier-aware behavior)

The TEMPR pipeline (see "Retrieval pipeline" below) runs across both tiers in one pass — `tier` is a column filter, no UNION required. Tier shapes retrieval in two ways:

- **Recency boost on the dense (semantic) retriever only**: an additive bonus on cosine similarity for rows newer than `recency_boost_days`, decaying linearly to zero. Lets a 2-day-old short-term row beat a 200-day-old long-term row when their semantic scores are close. Other retrievers (BM25, graph, temporal) treat tiers equally — recency is a relevance signal, not a textual one. The temporal retriever already orders by recency by construction, so applying the boost there would double-count.
- **Cross-encoder rerank is tier-blind**: bge-reranker-v2-m3 scores each (query, candidate) pair regardless of tier. Reranking is purely about pair-level relevance.

Relevance-filtering and score-floor behavior: handled by the `retrieval.rerank_floor` gate at the end of the pipeline — see "Retrieval pipeline" below for the mechanism and the closed Open Question for the rejected Surprise alternative.

### Consolidation moves short-term → long-term (rolling drain)

When a consolidation pass fires, the oldest `drain_pct` of short-term rows *for that session* are passed to the consolidator LLM, which produces long-term facts. The drained short-term rows are deleted; the remaining `(1 - drain_pct)` rows stay as the sliding window. New writes accumulate on top until the next fire.

The consolidator also runs supersede detection against existing long-term: when a fresh fact contradicts an old one, the dream cycle invokes `mindwright_resolve_contradiction` internally with the appropriate resolution. See "Consolidation (dream) cycle" below for the full pipeline.

### Config knobs (edit `lib/constants.js`)

| Knob | Default | Purpose |
|---|---|---|
| `CAP_EXCHANGES` | 50 | Short-term row count that surfaces the "time to dream" hint. |
| `CAP_KB` | 500 | Short-term filtered-content size that surfaces the same hint. |
| `DRAIN_PCT` | 0.70 | Fraction of oldest rows consolidated per dream pass. |
| `SAFETY_NET_DAYS` | 3 | Forced-fire age — surfaces the hint when any short-term row is older than this. |
| `TOP_K_DEFAULT` | 8 | Final candidates returned by retrieval. |
| `PER_RETRIEVER_N` | 50 | Candidates pulled per retriever before RRF. |
| `RECENCY_BOOST_DAYS` | 14 | Recent rows get an additive boost on the semantic path (ordering only). |
| `RERANK_FLOOR` | 0.10 | Cross-encoder sigmoid score below which a retrieval candidate is dropped. Calibrated for short-term (StepDx spike, 7778 rows, 14 queries); long-term tier likely wants a higher floor — distilled facts are denser/more on-topic, so both relevance and noise scores shift. Calibrate per Cohere 30-50-query procedure once the consolidator produces real long-term entries to test against. |

Defaults calibrated to the StepDx autonomy profile (3 peers, 16 days, ~2 user prompts per peer per day, 9-34 exchanges/peer/day). Less-autonomous projects can raise `cap_exchanges` to delay dreams, or lower it to keep long-term hotter.

### Calibration evidence (StepDx, 3 peers × 16 days)

| peer | exch/day | drain cycle (days) | dreams in 16d | per-pass cost (Opus) |
|---|---|---|---|---|
| chatty (Luna, 67 CLI / 448 agent_msg / 12 handoff) | 34 | ~1.0 | ~15 | ~$1.05 |
| mid (Max, 28 CLI / 292 agent_msg / 4 handoff) | 21 | ~1.7 | ~9 | ~$1.05 |
| quiet (Emma, 7 CLI / 88 agent_msg / 32 handoff) | 9 | ~3.9 → safety-net at 3d | ~5 (partial) | ~$0.30 |

Per-pass tokens at `drain_pct=0.70`: ~35 rows × ~7 KB filtered avg ≈ ~245 KB ≈ ~70K input tokens at Opus. Output ~3-5K tokens of facts. Per-pass cost ~$1.05.

Team total over a 16-day run: ~$25-30 in consolidation cost. Embedding/insert at write time is negligible (local model, ~5-10ms per row, no API charges).

### Why bus messages count equally

In the StepDx data, the ratio is ~1 CLI prompt : ~10 peer agent messages. Peer chatter contains findings, decisions, handoffs, blockers — that's where the actual work happens. Weighting CLI higher would make the cap fire on how often the user talks to the agent, not how much work the team did. Equal weight is the right default for this autonomy profile. Per-project tuning of the equal-weight ratio is not currently exposed; if it ever turns out peer chatter is mostly noise in some project, we'll revisit.

## Retrieval pipeline

Three trigger surfaces, all running the same pipeline:

| Trigger | When | Query |
|---|---|---|
| `UserPromptSubmit` hook | Turn start (CLI) | The prompt text |
| Bus subscriber on conversational inbox events | Turn start (Discord/peer) | The event `body` |
| `PreToolUse` hook (gated) | Mid-turn | Most recent thinking block + pending `tool_input` |

PreToolUse gate logic: fire retrieval when `cosine(thinking_emb, meta:last_retrieval_query_emb:<sessionId>) < NOVELTY_THRESHOLD` (default `0.85`) — i.e. the thinking block is materially different from the topic of the previous retrieval. The first PreToolUse of a session has no prior embedding and always fires. After firing, the new query embedding is stored. Top-K is bucketed by thinking length (`len ≤ 200 → K=3`, `len ≤ 1000 → K=5`, `len > 1000 → K=8`) so short thinking gets a small bite and long thinking gets a broader sweep. Hook returns no additionalContext when gated and skips silently. A per-session `meta:injected_fact_ids:<sessionId>` dedup set (FIFO-trimmed at `INJECTED_FACT_IDS_CAP=200`) filters out facts already injected in this session — recall, PreToolUse retrieval, UserPromptSubmit retrieval, and self-recall all read+append through the same set.

Additionally, `mindwright_recall` is exposed as an MCP tool for agent-invoked recall at any point (escape hatch when the gated automatic path doesn't fire and the agent realizes it needs a specific lookup).

Pipeline (same for all triggers):

1. **Query analysis** (deterministic): extract query entities (file paths, function names, library names, peer handles) using same regex-based extractor used during fact extraction. Build query embedding via bge-m3. The 8192-token input window comfortably absorbs even the largest realistic query payload (a long thinking block from the PreToolUse-gated mid-turn trigger, an inbound Discord message, or a CLI prompt) — no truncation step is needed.
2. **4-way parallel retrieval** (each returns top-N candidates with rank, default `per_retriever_n=50`):
   - **Semantic**: cosine similarity over `vec_index` against query embedding.
   - **BM25**: FTS5 keyword match against fact text.
   - **Graph**: traverse `entities` table — find facts linked to any extracted query entity.
   - **Temporal**: facts ranked purely by recency, filtered to last-N days.
3. **Reciprocal Rank Fusion**: combine the four ranked lists. Each fact's RRF score = Σ 1/(k + rank_i) summed across the lists it appears in; k=60 (standard). Returns a single fused ranked list. No tuning required; well-studied; cheap.
4. **Cross-encoder reranking**: take top-20 fused candidates, score each (query, fact) pair through a local cross-encoder reranker (`BAAI/bge-reranker-v2-m3`, same 8192-token context as the embedder so neither side gets clipped). The reranker returns sigmoid-activated scores in `[0, 1]`. Cross-encoders produce much higher precision than bi-encoder cosine but are expensive at scale — affordable here because we only score 20 pairs, not the whole store.
5. **Absolute rerank floor + return top-K**: drop any candidate with rerank score below `retrieval.rerank_floor` (default `0.10`, short-term-calibrated). Return the top-`retrieval.top_k` (default 8) of what survives. **Can return `[]`** if every candidate was below the floor — the calling skill must handle empty results explicitly ("no relevant memory found") rather than fabricating.
   - CLI path: `additionalContext` in the UserPromptSubmit hook output (Claude Code-native).
   - Discord path: SystemReminder via wrightward channel doorbell, or a parallel mindwright-owned bus event the target session picks up next tool call.

**Abstention mechanism: a single absolute floor on the cross-encoder sigmoid score.** Surprise scoring (Bahri et al., arxiv:2010.09797) was the original choice but was tested-and-rejected via a real-data spike — see "Retrieval abstention" decision entry and the closed Open Question for evidence. The cross-encoder's sigmoid score IS the calibrated relevance signal we want; a flat floor at 0.10 means "drop anything the cross-encoder calls <10% likely relevant." For projects that want a tuned floor, the Cohere 30–50-query calibration procedure can pin it empirically — collect 30–50 representative queries, gather borderline-relevant candidates, run through the reranker, average their scores, use that as the floor.

**Tier-specific floors (open).** The current single floor is calibrated against short-term tier scores (raw exchange chunks). Long-term tier entries are LLM-distilled facts — more concise and more topic-focused per token — so the same query against a relevant long-term fact will likely rerank higher (better signal), and against an irrelevant long-term fact will likely rerank lower (less topical drift). The operating window for long-term will probably sit higher. Deferred until the consolidator produces real long-term entries to calibrate against; see Open Questions.

**Tier-aware behavior**: this pipeline scans both `tier='short'` and `tier='long'` entries in one pass. The dense (semantic) retriever applies a recency boost — additive bonus to cosine score for rows newer than `retrieval.recency_boost_days` (default 14), decaying linearly to zero at that boundary. Other retrievers (BM25, graph, temporal) are tier-blind because recency is a relevance signal, not a textual one; the temporal retriever already orders by recency by construction so applying the boost there would double-count. The cross-encoder reranker is fully tier-blind — bge-reranker-v2-m3 scores each (query, candidate) pair on its own semantic merits.

Hindsight reports 91% retrieval accuracy with this stack vs ~70% for vanilla single-method RAG.

## Consolidation (dream) cycle

Invoked by: a session with the `consolidator` role assigned (via `/mindwright:dream` or auto-triggered on the size/cadence/manual triggers described in "Short-term and long-term memory tiers"). Runs as a normal Skill inside that session's turn loop. Each session that hits its cap spawns its own consolidator-role drain — separate per session, not a shared global consolidator (see Decisions).

Inputs (rolling-drain pass — the default operating mode):
- The **oldest `drain_pct`** of short-term rows (`tier='short'`) for the calling session. Already filtered (short-term writes use the deterministic chunker at insert time), already embedded. Drain size at defaults: ~35 rows on a 50-cap.
- Existing long-term facts (`tier='long'`) for supersede detection. Read via the standard TEMPR retrieval over long-term only.

**Manual full-pass** (`/mindwright:dream --scope=all`): inputs become "all `tier='short'` rows for this session" (or for all sessions if `--scope=project`). Drain percentage is ignored; everything in short-term gets consolidated. Same pipeline downstream.

**Bootstrap case** (empty memory + transcripts available on disk, no short-term rows yet): the dedicated `lib/seed-loop.js` driver enumerates `~/.claude/projects/<encoded-cwd>/*.jsonl`, skipping any transcript whose session id already has an `offsets` row (live-captured or finished on a prior run — never re-seeded). For each genuinely pre-install transcript it chunks in bounded line slices (non-streaming) and writes `tier='short', kind:'seed'` rows carrying that JSONL record's real `timestamp` as `event_ts`; each transcript is one atomic transaction ending in an `offsets` advance, so a crash mid-corpus resumes exactly where it stopped with no duplication. Scope is limited to user/project (a raw transcript carries no reconstructable role, so the loop never produces `role:`-scoped rows; the consolidator assigns scope at distill). When accumulated un-consolidated bytes cross a tunable budget the loop invokes the **existing** dream cycle to drain/distill, then continues — short-term never holds the whole corpus. Same pipeline runs end-to-end; output is identical in shape to what organic consolidation would have produced if dream had run after each prior session.

Pipeline:
0. **Select input rows**: query `entries WHERE tier='short' AND session_id=:self ORDER BY created_at ASC LIMIT (drain_pct × current_count)`. Mark them as `consolidating` so concurrent writes don't include them in a parallel pass. Group adjacent rows into logical exchanges by time-proximity (gap < 10 min) and conversational structure (a primary-content opener — `cli_prompt`, `discord_user`, or an inbox-event row — opens a new exchange; subsequent thinking/text/outbound-send rows attach to it).
1. **Group rows into exchanges (chunker rules — reference)**: the rules below define both (a) how the live chunker at write time decides what to write to short-term and (b) how the consolidator groups the drained short-term rows back into logical exchanges. Same rules, same kind-assignment, used at two different points in the pipeline. An exchange opens on EITHER:
   - A `user` record with plain-string content that does NOT match the channel-doorbell pattern `^<channel source=` (i.e., real CLI user input), OR
   - A `tool_result` from `wrightward_list_inbox` carrying one or more events of type `user_message`, `agent_message`, `handoff`, `finding`, `decision`, or `blocker`. Each such event is conversational/work content — from the user (Discord) or from a peer agent — and opens its own exchange. If multiple events are batched in one inbox dump, combine them into a single exchange opener since the assistant processed them together. `ack` events do NOT open exchanges — they attach to the previous exchange as delivery confirmation.
   
   Delivery mechanics attach to the currently-open exchange (do NOT open a new one):
   - Channel doorbell notifications (`<channel source=...>` user records)
   - `wrightward_list_inbox` tool_use blocks
   - `file_freed`, `delivery_failed`, and `ack` events inside inbox tool_results (system/confirmation signals, not conversational)
   - Intermediate assistant `text`/`thinking` blocks
   - Outbound `wrightward_send_message`/`_send_note`/`_send_handoff`/`_ack` tool_use blocks (these are the assistant's reply in the open exchange)
   
   Exchange closes when the next primary content appears. Compaction summary records are excluded entirely (post-hoc synthesizes, not real conversation). This scheme keeps peer↔peer interactions as first-class exchanges rather than lumping them into adjacent user-exchanges.
2. **Extract narrative facts**: consolidator LLM produces self-contained facts for each exchange — count depends on signal density (zero for low-content turns, many for dense ones; see "Memory granularity" decision). Each fact carries: text, category, entity tags, confidence (for preferences), source exchange citation.
3. **Categorize**: each fact tagged with a `category ∈ {procedural, episodic, fact}` and a `scope ∈ {user, project, role:<role>}`. LLM makes both calls; uncertainty on category defaults to `episodic` (lowest stakes — a narrated observation rather than a how-to or a declarative); uncertainty on scope defaults to `role:<active-role>` (most conservative — stays local).
4. **Extract entities**: pull named entities (file paths, function names, library names, peer handles) and link them to facts in the `entities` table.
5. **Compare against existing heuristics/facts**: identify supersede candidates (new info contradicts old) within the same (category, scope) cell. The consolidator marks the old row superseded by the new row's id; the new row carries its own one-shot confidence tag from the distillation step. Running-confidence updates on reinforcement/contradiction (the Hindsight "opinion network" pattern) are deferred — see the user-scoped fact confidence decision.
6. **Route by (category, scope)**:
   - `(fact, user)` → user-scoped preferences (all roles retrieve from).
   - `(fact, project)` → project-scoped declaratives.
   - `(procedural, role:<role>)` → per-role heuristics for each role that was active when the source observations were recorded.
   - `(episodic, project|role:<role>)` → narrated outcomes scoped to the project or the active role; surfaced when a future query resonates with the same situation.
7. **Embed and index**: generate bge-m3 embeddings (1024-dim, int8-quantized) for new/changed facts; insert into `vec_index`; update FTS5 index.
8. **Prune**:
   - **Drained short-term rows → hard delete** (they're now reflected in long-term rows and the supersede chain). This is what makes consolidation "rolling": short-term contracts by `drain_pct` and the remaining `(1 - drain_pct)` rows stay as the sliding window.
   - Long-term project-scoped facts: if invalidated by code/spec change, archive (don't hard delete).
   - Size-threshold sweep on long-term: if store > cap (~50K rows / ~100MB default), archive low-recency/low-retrieval-frequency entries.
   - (Deferred: confidence-decay-based archival for user-scoped facts — see the confidence decision in §"Decisions". v1 archives user-scoped facts only via the supersede chain or explicit `/mindwright:forget`.)
9. **Record the pass**: insert one row into `consolidations` table (session_id, fired_at, drained_count, drained_bytes, produced_count). This is what the cadence safety net reads to decide if `safety_net_days` have elapsed.

Outputs:
- New heuristics file revision (markdown mirror updated)
- Dream log entry (when, what scope, counts: drained/merged/added/superseded)
- Short-term row count for the session drops by `drain_pct × prior_count`. Next consolidation fires when fresh writes refill the cap (default cycle: ~35 fresh exchanges, ~1-4 days depending on session activity).

**Per-pass cost at defaults**: ~35 rows × ~7 KB filtered avg ≈ ~245 KB ≈ ~70K input tokens at Opus. Output ~3-5K tokens. Per-pass ≈ $1.05. See "Calibration evidence" under "Short-term and long-term memory tiers" for per-peer cost totals on a StepDx-shaped 16-day run.

## Testing

Full suite: **240 tests** under `mindwright/test/`. With `MINDWRIGHT_SKIP_MODEL_TESTS=1`
the 5 tests that touch the real bge-m3 / bge-reranker-v2-m3 ONNX models are skipped
and the remaining **235 tests pass** (no model download required). The skipped 5 are
covered separately by `test/models.test.js` when the cache is warm.

Test scope mirrors the file map above: one `*.test.*` per lib module plus
`test/mcp/`, `test/hooks/`, `test/integration/end-to-end.test.js` (full
session-start → write → retrieve → dream → finalize loop), and
`test/concurrency/cross-process-wal.test.js` (multi-process WAL safety).

## Security: role and session identifier validation

`lib/constants.js` exports two regex whitelists:

- `ROLE_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/` — every MCP handler that accepts a `role`
  argument rejects values that fail this check before they flow into
  `agents/<role>/heuristics.md` paths.
- `SESSION_ID_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/` — `lib/paths.js#pipePath` and the
  ticket/socket helpers reject session_ids that fail this check before they would
  reach the filesystem. UUIDv4 (36 chars) fits comfortably; synthetic test ids
  (`sess-A`, `capfire`, `seed-from-repo`) also fit.

Defense-in-depth: even though both identifiers originate inside the Claude Code
trust boundary, the patterns block path-traversal payloads (`..`, separators, drive
prefixes, NUL bytes) at every disk-bound entry point.

## Open questions

- **Bus-message-vs-CLI weighting in the cap accounting**. Current default is equal-weight: every short-term row counts as 1 toward `cap_exchanges`, regardless of whether it came from a CLI prompt, a Discord message, agent thinking, or a peer bus event. Calibrated to StepDx where peer chatter contains real findings/decisions/handoffs. This is the right default given current evidence, but if a future project shows peer chatter is mostly noise, we'd want to add a per-`kind` weight multiplier. Not implemented yet; raise this question if observed.
- **Long-term tier `rerank_floor` calibration**. Default `0.10` is calibrated to short-term tier only (StepDx spike, 7,778 raw exchange chunks, 14 queries; operating window 0.003–0.545). Long-term tier is LLM-distilled facts (denser, more topic-focused per token), so both the relevance score for a hit and the noise score for a miss will shift — most likely BOTH up, with the gap WIDER. A higher floor than 0.10 is plausibly right for long-term but cannot be set without real long-term data. **Blocked on consolidator implementation**; calibrate via the Cohere 30–50-query procedure once a real long-term store exists. If the gap turns out to be wide, may also be worth splitting `rerank_floor` into `rerank_floor.short` / `rerank_floor.long` in config; if it turns out small, keep a single floor.
- **General `rerank_floor` recalibration on real workloads**. The 0.10 short-term default was calibrated on one StepDx transcript (focused single-project, technical medical-graph content). Different projects (looser prose, more conversational, multi-domain) may shift the operating window. Same Cohere 30–50-query procedure applies per-project for production tuning. Not a research gap — a calibration step.

**Closed**:
- **Storage shape** (single-table answer) — single `entries` table with `tier` and `category` columns; `observations`, `facts`, `heuristics`, `preferences`, `project_facts` are views. Closed in Decisions and "Architecture sketch".
- **Stop-hook observation extraction strategy** — resolved by the short-term tier model. Writes happen at `UserPromptSubmit` / `PreToolUse` / `Stop` granularity (per-tool-call effective), so learning accumulates continuously during multi-hour autonomous runs rather than only at turn end. Closed in "Short-term and long-term memory tiers".
- **Retrieval relevance threshold** — resolved by an absolute floor on the cross-encoder sigmoid score (`retrieval.rerank_floor`, default 0.10 short-term-calibrated; long-term TBD), project-tunable. Surprise scoring (Bahri et al., arxiv:2010.09797) was the original choice and was tested-and-rejected via a real-data ablation spike: at 325 rows Surprise was neutral; at 7,778 rows Surprise was actively harmful (false abstention on a clear-cut query, demonstrably worse top-1 swaps). Root cause: Surprise's noise-distribution assumption breaks on thematically focused single-project transcripts. Floor value of 0.10 was set by a sweep over (0.001, 0.005, 0.01, 0.02, 0.05, 0.10, 0.15, 0.20, 0.30, 0.40, 0.50) on the same 7,778-row StepDx corpus — operating window was (0.003, 0.545), 0.10 sits mid-window and trims long-tail borderline candidates while preserving all real top-1 hits. Closed in "Retrieval pipeline" and "Decisions made so far". Rejected alternatives: Hindsight's "no threshold at all" (returns top-K junk), two-stage Surprise (empirically harmful at scale), CRAG-style trained evaluator (requires labeled data), MemReranker swap (reranker upgrade, not an abstention mechanism — possible future drop-in).
- **Stage-2 Surprise empirical validation** — closed by negative result. The spike's 7,778-row ablation showed Stage-2 Surprise causes false abstention on a clear-cut query and adds no correctness benefit over the rerank floor. Stage-1 Surprise was inconsistent — helped once (kept an exact BM25 keyword match that the reranker slightly underweighted), hurt twice (dropped high-rerank candidates from the pool before reranking). Both stages removed from the design.

## Size threshold for cleanup

`~50K rows OR ~100MB per store, whichever first.` Config knob with that default.

Justification: sqlite-vec uses brute-force scan (no ANN), so latency scales linearly with N × D. Published benchmarks at 384-dim float32:
- 100K vectors → 67ms full-scan query
- 100K vectors + int8 quantization → 17ms
- 100K vectors + quantization + preloaded → 4ms

At bge-m3's 1024-dim, multiply by ~2.7× for the dimension increase: 100K vectors at 1024-dim float32 ≈ 180ms full-scan; 100K vectors at 1024-dim int8 ≈ 45ms; preloaded ≈ 11ms. **int8 quantization is therefore enabled by default with bge-m3**. The 50K row threshold keeps the int8 path under ~25ms. Past ~500K rows we'd need ANN — out of scope for v1.

## Cross-role learning bleed

Cross-role bleed is controlled by category-based routing at consolidation time, not at retrieval time (see "Heuristic categorization" decision + dream cycle pipeline). It's a write-time classification problem, not a read-time filtering problem.

A single session can hold multiple roles at once (planner + implementer on a small task), so role assignment is a *set*, not a single value. Observations record the active role-set at the time they were captured.

## Embedding model

`BAAI/bge-m3` — local SentenceTransformers, 1024-dim, 8192-token input context. Chosen over Hindsight's bge-small-en-v1.5 default (which truncates at 512 tokens) because thinking blocks observed in real Claude Code transcripts can exceed that window — the long-context model lets the retrieval pipeline embed any realistic query payload (CLI prompt, Discord message, or full mid-turn thinking block) in one pass with no truncation and no chunking. Paired with `BAAI/bge-reranker-v2-m3` (same 8192-token context). int8 quantization on by default to offset the dimension-scaling cost in sqlite-vec brute-force scans. API providers (OpenAI/Cohere/Gemini/Voyage) configurable for users who want higher recall.

## Bootstrap

Auto-seed by folding into consolidation, not by reimplementing distillation. On first run with empty memory, a dedicated bounded loop (`lib/seed-loop.js`) ingests local Claude Code transcripts at `~/.claude/projects/<encoded-cwd>/*.jsonl` (order of magnitude for an active project: ~100+ files / ~200+ MB — not a fixed value) into `tier='short', kind:'seed'` rows, then the **existing** `/mindwright:dream` cycle distills them. Same pipeline produces the same output shape as organic consolidation would have, given the same input.

Why a dedicated loop but not a dedicated distillation path: the loop only does the ingest + bounding + resumability that the cap-50 nudge cannot (the nudge is `MINDWRIGHT_NUDGE`-gated and only fires once short-term crosses the cap — a fresh zero-row install never trips it). Distillation itself is still the unchanged dream cycle: the loop produces short rows and invokes `drainBatch`/`retainFact`/`finalizeDrain` exactly as a normal dream would. Special-casing the *distillation* would be redundant; a separate *ingest driver* is necessary precisely because the organic trigger can't reach zero-row state.

**Event-time provenance.** Each seed row carries its originating JSONL record's real `timestamp` as `event_ts` (a nullable column distinct from `created_at`), and a durable `<transcript-basename>:<record-uuid>` source_ref. When the dream cycle distills a seeded exchange, the representative (max) `event_ts` of the originating rows is stamped onto the long-term fact. **Governing invariant**: `event_ts` feeds *relevance/recency ranking only* (`ORDER BY COALESCE(event_ts, created_at)` in temporal/graph retrieval and the recency boost). `created_at` remains the sole basis for *all lifecycle/operational logic* — drain ordering, the `(created_at,id)` drain cursor, `finalizeDrain` re-query, safety-net age. This is why seeded rows get `created_at = seed-run time` (keeps drain/safety-net correct) while `event_ts` carries true historical time (keeps recall honest about when a memory actually happened). Live-captured rows have `event_ts = NULL`, so `COALESCE` makes them behave exactly as before this change — zero regression.

**Resumability (no new primitive — reuses `offsets`).** A transcript whose session id has no `offsets` row was never live-captured (SessionStart sets the offset to EOF for live sessions) → genuinely pre-install → eligible to seed. One whose session id already has an `offsets` row is skipped. Each transcript is processed under one transaction that ends by advancing that session's `offsets` row to the file's byte length, so a crash mid-corpus rolls that transcript fully back and the next run redoes exactly it — no duplication, no stranded tail. A later live resume of the same session continues coherently from where seeding left off.

**Auto-trigger.** Hosted by **SessionStart** (`hooks/session-start.js#main` → `lib/seed-trigger.js#maybeAutoSeed`), NOT the Stop hook. The gate's empty-memory precondition is only observable *before* the turn's first transcript flush, and `UserPromptSubmit`/`PreToolUse`/`Stop` all flush short-term rows; by the first Stop, `countByTier().short` is non-zero, so a Stop-hosted gate could never fire on the documented fresh-install flow (this was behavior-1 — the marquee "learns from your project's history" feature was a silent no-op; a pre-flush snapshot at the top of Stop is also insufficient because UPS/PreToolUse already wrote rows earlier in the same turn). SessionStart runs before any hook in the turn touches the transcript, so it is the only point genuine install-time emptiness is visible. (This supersedes the originally-planned "Stop `main()` sibling check"; the relocation was made with explicit user sign-off after implementation surfaced the ordering defect — the plan flagged the auto-trigger host as an open question to confirm before deviating.) The pure gate `shouldAutoSeed` fires the loop fire-and-forget when: `MINDWRIGHT_AUTO_SEED !== 'false'`, the session is not itself a consolidator/seed session (the existing `isConsolidatorSession` self-spawn guard — no new lock primitive, shared with the cap-nudge path), memory is empty (zero short AND zero long rows — self-limiting: once seeded the trigger can't re-fire), and at least one `*.jsonl` transcript exists. Gated only by `MINDWRIGHT_AUTO_SEED`, independent of `MINDWRIGHT_NUDGE`; never blocks session start.

Transcript pre-filter is deterministic and structural — no LLM, no regex heuristics. Verified against actual JSONL. Includes a wrightward tool allowlist so Discord conversation is preserved end-to-end:
- Keep `user` plain-string content (CLI input + doorbell notifications)
- Keep `user` `tool_result` blocks whose `tool_use_id` maps to a wrightward inbox tool (`wrightward_list_inbox`) — inbound Discord
- Keep `assistant` `text` and `thinking` blocks
- Keep `assistant` `tool_use` blocks for wrightward communication tools (`wrightward_send_message`, `wrightward_send_note`, `wrightward_send_handoff`, `wrightward_ack`) — outbound Discord
- Drop everything else

Expected reduction: ~90-95% of raw tokens dropped; ~100% of signal preserved including Discord exchanges in both directions.

The repo/native-memory scan (`/mindwright:seed-from-repo`) is a separate, manually-triggered path covering README + CLAUDE.md + Claude Code's native per-project memory (`~/.claude/projects/<encoded-cwd>/memory/*.md`). It is an always-included scan (not a fallback gated on transcript absence) and is idempotent — a source already represented by an un-drained short `seed` row is skipped wholesale (matched on the source_ref file-path prefix), so re-running never piles duplicates. Native-memory rows are LLM-written notes re-distilled through consolidation like any other seed input (not direct-mapped to long-term) and carry an `event_ts` (frontmatter date or file mtime). No git-log scan — removed; commit subject-lines were low-signal next to transcripts and native memory.

## Discord ingress pathway

Wrightward cannot be modified to make Discord messages fire UserPromptSubmit. Verified:

- Anthropic hooks docs (https://code.claude.com/docs/en/hooks) are explicit: "All hook events are triggered exclusively by Claude Code itself in response to user actions and internal events." There is no external prompt-injection API.
- Wrightward's existing channel doorbell (SystemReminder injection via `additionalContext`) IS Anthropic's documented integration path — see https://code.claude.com/docs/en/channels ("Push events from a chat app like Telegram or Discord, or your own server"). This is the canonical pattern, not a workaround.
- GitHub issue #24947 ("Send prompts to running sessions programmatically") was marked COMPLETED 2026-04-07, but `claude inject` is not a real CLI command (tested). It was resolved via **Remote Control** (`claude --remote-control`) which connects claude.ai/code web UI to a local session — different model than wrightward's broker pattern, not applicable.

**Decision: dual ingress, single processor.**
- CLI prompts → UserPromptSubmit hook → `mindwright.onPrompt(text, sessionId)`
- Discord prompts → bus subscriber on `user_message` events → same `mindwright.onPrompt(text, sessionId)`

Both paths converge before retrieval ranking. Retrieved context delivery routes back through the origin channel:
- For CLI: returned via hook's `additionalContext` (UserPromptSubmit supports this).
- For Discord: written as a SystemReminder via the same channel doorbell wrightward already owns, OR injected as a parallel mindwright-owned bus event the target session picks up next tool call.

No wrightward changes needed for ingress. Mindwright owns the bus subscription on its side.

## Verified facts (citations for the record)

- Wrightward handle deterministic from sessionId: `wrightward/lib/handles.js:24-33` (`sha256(sessionId)` → name+number).
- Discord ingest path: `wrightward/broker/inbound-poll.mjs` polls Discord every 3s, writes `user_message` events to `bus.jsonl` under `withAgentsLock`.
- Discord prompts do NOT fire UserPromptSubmit: `wrightward/hooks/hooks.json` registers `mark-prompt-cli.js` on UserPromptSubmit; that hook writes a `last-prompt` marker with channel='cli'. The Discord broker writes channel='discord' separately via `lib/last-prompt.js:writeMarker`.
- Hooks cannot be triggered externally: https://code.claude.com/docs/en/hooks — "All hook events are triggered exclusively by Claude Code itself in response to user actions and internal events."
- Channel doorbell is Anthropic's documented Discord/Telegram path: https://code.claude.com/docs/en/channels.
- Remote Control (`claude --remote-control`): https://code.claude.com/docs/en/remote-control — connects claude.ai/code web UI to a local session, not an external-broker prompt-injection mechanism.
- Hindsight has no pruning: confirmed at https://hindsight.vectorize.io/sdks/integrations/claude-code and configuration docs (only audit-log retention knob exists).
- Anthropic Dreams API: https://platform.claude.com/docs/en/managed-agents/dreams — research preview, beta header `dreaming-2026-04-21`, takes memory_store + up to 100 sessions, outputs new memory_store.
- Claude Code memory load: https://code.claude.com/docs/en/memory — first 200 lines / 25 KB of MEMORY.md loaded at session start; topic files on demand.
- Claude Code hook output capabilities (verified at https://code.claude.com/docs/en/hooks, re-verified 2026-05-13): UserPromptSubmit, SessionStart, PreToolUse, AND PostToolUse all return `hookSpecificOutput.additionalContext`. Mindwright uses PostToolUse narrow-matched to `wrightward_list_inbox` to re-inject the self-recall rule and any newly-assigned role prompts on each bus-read. PreToolUse input includes `transcript_path`, so a PreToolUse hook can read the transcript file to access the most recent thinking block (the input itself only carries `tool_name`, `tool_input`, `tool_use_id` plus standard fields).
- sqlite-vec performance at 384-dim float32: 100K vectors → 67ms full-scan, 17ms with int8 quantization, 4ms preloaded. https://alexgarcia.xyz/blog/2024/sqlite-vec-stable-release/index.html and https://github.com/asg017/sqlite-vec/issues/186. Brute-force scan is O(N×D); for bge-m3's 1024-dim, multiply by ~2.7× to get the equivalent budget.
- Hindsight default embedding model: `BAAI/bge-small-en-v1.5` (384-dim, 512-token context, local SentenceTransformers). Configurable to OpenAI/Cohere/Gemini/etc via `HINDSIGHT_API_EMBEDDINGS_PROVIDER`. https://github.com/vectorize-io/hindsight/blob/main/hindsight-docs/docs/developer/configuration.md
- bge-m3 specs: 1024-dim embeddings, 8192-token max input length, ~570M params, multilingual, supports dense + sparse + multi-vector retrieval (mindwright uses dense). https://huggingface.co/BAAI/bge-m3. Paired reranker `BAAI/bge-reranker-v2-m3` (https://huggingface.co/BAAI/bge-reranker-v2-m3) shares the 8192-token context.
- Empirical thinking-block sizing: scanned 40 transcripts (`~/.claude/projects/c--Users-yiann-Documents-Stonk/*.jsonl`, ~24 MB total) containing 7,784 assistant thinking blocks. Largest single block = 16,242 chars (~4,060 tokens at the standard 4-chars/token estimate). 0 of 7,784 exceeded 8192 tokens; only 18 (0.23%) exceeded 2048. bge-m3's 8192-token input window therefore has comfortable headroom against real-world thinking-block sizes in long sessions.
- Hindsight TEMPR algorithm (Temporal Entity Memory Priming Retrieval): 4-way parallel retrieval (semantic + BM25 + entity graph + temporal) → Reciprocal Rank Fusion → cross-encoder reranking. Retain pipeline extracts 2-5 narrative facts per exchange empirically; mindwright drops the numeric cap and lets the consolidator judge by signal density. Reports 91% retrieval accuracy vs ~70% for vanilla RAG. Paper: arxiv:2512.12818 (https://arxiv.org/html/2512.12818v1). Coverage: https://venturebeat.com/data/with-91-accuracy-open-source-hindsight-agentic-memory-provides-20-20-vision
- Hindsight has no automatic seeding: docs state "memories need at least one retain cycle before they're available." Manual `/hindsight-memory:create-agent <name> from <path>` exists for ingesting text files into a new subagent bank, but no auto-scan of CLAUDE.md/README/native-memory and no automatic transcript bootstrap (mindwright has both).
- Claude Code transcript JSONL structure (verified against `~/.claude/projects/C--Users-yiann-Documents-AI-engineering/16971ff3-0143-4488-9962-94d333bfffe8.jsonl`, 421 lines): top-level types include `user`, `assistant`, `attachment`, `last-prompt`, `permission-mode`, `ai-title`, `system`, `queue-operation`, `file-history-snapshot`. Inside `assistant` records the content array has block types `text`, `thinking`, `tool_use`. Inside `user` records content is either a plain string (real user message or channel-doorbell `<channel source="...">` notification) or an array containing `tool_result` blocks. This is the basis for the deterministic transcript filter.
- Discord traffic in transcripts (verified same file): inbound Discord user messages arrive as `tool_result` blocks from `wrightward_list_inbox` calls — the JSON content contains an `events` array, each event's `body` field carries the user's Discord text. Outbound agent→Discord messages are `tool_use` blocks where the tool name starts with `mcp__plugin_wrightward_wrightward-bus__wrightward_send_*`; the `input.body` field holds the agent's text and `input.audience` indicates the route (`user`, `all`, or peer handle). The session-under-test has 20 outbound send-* calls.
- **Hindsight has no relevance threshold / score-cutoff**: verified at https://github.com/vectorize-io/hindsight/blob/main/hindsight-docs/docs/developer/configuration.md. All retrieval filtering is budget-based: `RECALL_BUDGET_FIXED_LOW=100`, `RECALL_BUDGET_FIXED_MID=300`, `RECALL_BUDGET_FIXED_HIGH=1000` items per retrieval method per fact type; `RERANKER_MAX_CANDIDATES=300`; output trimmed to `RECALL_MAX_TOKENS=2048`. No minimum-score, no relevance-cutoff option exists. Hindsight returns top-K unconditionally.
- **StepDx autonomy empirics** (3 most recent transcripts at `~/.claude/projects/c--Users-yiann-Documents-StepDx/*.jsonl`, all 16-day spans): real CLI-typed user prompts per peer = 7 / 28 / 67 (Emma / Max / Luna). Filter applied to skip `<<autonomous-loop-dynamic>>` sentinels, system reminders, compaction summaries, command stdout. Filtered-content size per peer: 1.45 MB / 6.86 MB / 4.77 MB. True exchange counts including peer↔peer bus traffic: 141 / 335 / 541 (peer agent_messages dominate: 88 / 292 / 448). Total real user prompts across 3-peer team over 16 days: 102 (~2 per peer per day). Peer-chatter share of exchanges: 90-99%. This is the empirical anchor for the `cap_exchanges=50`, `drain_pct=0.70`, `safety_net_days=3` defaults under "Short-term and long-term memory tiers".
- **Surprise scoring (Bahri et al., Google Research, 2020 — https://arxiv.org/abs/2010.09797)**: published method for result-list truncation in IR using Extreme Value Theory. Fits a Generalized Pareto Distribution to the ranked-score tail under the null hypothesis "these are non-relevant," computes per-candidate p-values, truncates at a chosen α. Verified directly from the paper. Originally adopted as mindwright's abstention mechanism, then **rejected via a real-data ablation spike**: at 325 rows the rerank floor did all the work and Surprise was a no-op; at 7,778 rows Surprise became actively harmful — false-abstained on "What is Emma's role?" (top-1 rerank=0.99 thrown away) and swapped a 0.73 candidate for a 0.29 candidate on "schema corrections in earlier cycles". The paper's noise-distribution assumption ("most candidates in the ranked list are non-relevant") breaks for thematically focused single-project transcripts where the lower half of top-50 is still on-topic content. The GPD-fit-on-noise then over-prunes truly relevant items. Bahri's validation was on heterogeneous web/image corpora where the assumption holds; mindwright's corpus shape is different by construction. Kept as a reference for why per-query EVT methods can fail on focused corpora, not as live machinery.
- **Cohere reranker threshold-setting procedure** (https://docs.cohere.com/docs/reranking-best-practices): Cohere explicitly states their rerank scores are "query dependent, and could be higher or lower depending on the query and passages sent in" and that a 0.91 score is not "twice as relevant" as 0.04. Their recommended threshold procedure: "Select a set of 30-50 representative queries", gather borderline-relevant documents, run through rerank, average the relevance scores → that average becomes the threshold. Verified by direct fetch. This is mindwright's recommended calibration path for `retrieval.rerank_floor` — the default `0.10` is calibrated on one corpus (StepDx short-term spike) and a real workload should run the 30–50-query procedure once to pin the floor for its own data shape.
- **bge-reranker-v2-m3 has no published threshold**: model card at https://huggingface.co/BAAI/bge-reranker-v2-m3 shows raw logit scores spanning −8.1875 (sigmoid 0.000278) to 5.26171875 (sigmoid 0.994840) across BAAI's own examples. No recommended cutoff. FlagEmbedding docs (https://bge-model.com/tutorial/5_Reranking/5.2.html) provide example scores but no threshold guidance. Per FlagEmbedding cross-confirmation, scores "vary with text length, domain, and language pair, and a score of 5.0 does not mean the same relevance across different datasets." Mindwright's empirical floor at 0.10 (sigmoid) was established on its own data via the spike sweep; it is not a property of the model and should be re-calibrated per project per the Cohere procedure.
- **MemReranker (Li et al., MemTensor Shanghai, May 2026 — https://arxiv.org/abs/2605.06132)**: agent-memory-specific reranker (0.6B/4B params on Qwen3-Reranker base) trained with multi-teacher BCE distillation explicitly to fix bge-reranker's miscalibration ("relevance scores are miscalibrated, making threshold-based filtering difficult"). Available at https://huggingface.co/IAAR-Shanghai/MemReranker-4B (verified to exist). Achieves 0.737 MAP on memory retrieval benchmark at 10-20% inference latency of larger models. Not adopted as primary choice because (a) it's a reranker upgrade not an abstention mechanism — `rerank_floor` already handles abstention against bge-reranker scores, (b) MemReranker's calibration is to the authors' training distribution not the user's, so the rerank_floor would still need re-tuning per project. Listed as a possible future drop-in for bge-reranker-v2-m3 if its higher precision on memory-shaped queries pays off.

## Next steps

Spike is done (fork b was taken). The retrieval pipeline was validated end-to-end on 7,778 real StepDx exchange rows: 4-way retrieval + RRF + cross-encoder rerank + `rerank_floor=0.10` correctly served all 6 real queries, abstained on all 4 control queries, and survived sweep + ablation analysis. Surprise scoring was empirically rejected in the process.

Remaining design work blocking implementation:
- Long-term tier `rerank_floor` calibration — blocked on consolidator producing real long-term entries (see Open Questions).
- Bus-message-vs-CLI cap weighting — equal-weight default is fine for StepDx-shape; revisit if a future project shows peer chatter is mostly noise (see Open Questions).

Next action: `agentwright:feature-planning` to lock the implementation plan, then build.

## Future thoughts (post-v1)

- **Opinion network for user-scoped facts (Hindsight-style running confidence).** v1 treats `confidence` on `(category='fact', scope='user')` rows as a one-shot signal-strength tag set by the consolidator at distillation time. A full opinion network would update confidence on each reinforcement (semantically-close newer fact) and contradiction (supersede candidate), with archival when confidence decays below threshold. Design questions to resolve before building: (a) delta values for reinforce vs. contradict and whether they should be config-tunable, (b) decay-vs-supersede semantics — does a contradicting fact always supersede, or does it just decay the prior until the prior crosses an archival threshold, (c) archive threshold default and whether `/mindwright:status` should surface near-threshold rows so the user can intervene, (d) reinforcement detection: what cosine/rerank score on the new fact qualifies as "the same fact, just restated" vs. "a different but related fact". DESIGN.md previously implied this was in v1 — corrected during behavior-audit #2; the supersede chain is the v1 archival mechanism for user-scoped facts, same as for project-scoped facts.
- **Fuzzy dedup against context-arrived-via-other-paths.** Decision 4 below pulls forward the id-keyed dedup mechanism (per-session set of injected fact ids, drop on subsequent retrieval). That handles the dominant case — mindwright re-injecting facts it already injected. The leftover case is facts that arrived in context via OTHER paths (user paste, plan body, prior agent turn, an `additionalContext` from a different plugin). Detecting these requires a content-hash or embedding-similarity check against the live conversation tail. Cheap-ish, but adds complexity to every retrieval call. Defer until the id-keyed dedup ships and we see whether the fuzzy case actually shows up as noise in practice.

## Design decisions (implemented 2026-05-13)

These four decisions were locked in conversation on 2026-05-13 after the first audit cycle and implemented the same day. They were NOT framed as "v1 → v2 migrations" — the plugin had never shipped to any other user, had never been used in production, and there was no backward compatibility to preserve. The existing code was treated as draft and edited directly. Each item was its own planning unit; the four are entangled by design (categorization shapes consolidator output, consolidator behavior shapes auto-spawn triggers, roles drive what the consolidator categorizes as procedural, proactive recall depends on category-aware retrieval).

### 1 — Memory categorization: procedural / episodic / fact

Replace the current `category` enum (`user-preference`, `project-fact`, `role-procedural`) with the cognitive-science taxonomy. The current enum conflates AUDIENCE (user / project / role) with TYPE; the corrected schema makes them orthogonal — `category` carries the type, `scope` carries the audience.

- **procedural** — *how to do X*. Concrete instructions and workflows that the agent (or user) repeatedly applies. Examples: "this is how I run tests in this repo: `MINDWRIGHT_SKIP_MODEL_TESTS=1 npm test`"; "when refactoring SQL migrations, always check 0001_init.sql for fresh-install drift too." Retrieval surfaces these when the agent is about to perform a similar action.
- **episodic** — *something that happened, with context, that's worth remembering as a precedent.* Examples: "I claimed a false time without actually checking, and the user got upset — verify before claiming time/date/external-state facts"; "in the 2026-05-09 dream cycle the consolidator skipped the supersede check on user-preference rows and produced duplicates — finalize_drain now hard-deletes drained rows so this can't happen silently again." These are the most powerful for proactive recall (see decision 4) because they carry the LESSON LEARNED, not just the fact.
- **fact** — *what is true (semantic).* Atomic, durable, non-procedural assertions. Examples: "Unicode characters crash scripts on Windows shells"; "the project uses better-sqlite3 with sqlite-vec for retrieval"; "the user's email is ydemetri@umich.edu."

`scope` is a separate column: `user` (about the user's preferences / patterns), `project` (about this codebase), `role:<role>` (procedural know-how tied to a role assignment). A fact can be scope=user (the user prefers tabs to spaces — TYPE=fact, AUDIENCE=user) or scope=project (the repo uses CommonJS — TYPE=fact, AUDIENCE=project). A procedural can be scope=role:planner ("when planning a refactor, list affected modules first") or scope=project ("how to run the test suite in this repo"). The current schema lost this orthogonality by collapsing them.

Implementation: **edit `db/migrations/0001_init.sql` directly.** Replace the existing `category` CHECK with `CHECK(category IS NULL OR category IN ('procedural', 'episodic', 'fact'))`. Add `scope TEXT` column with `CHECK(scope IS NULL OR scope='user' OR scope='project' OR scope LIKE 'role:%')`. Update the tier⇄category CASE: tier='long' requires `category IN ('procedural','episodic','fact') AND scope IS NOT NULL`. Update views (`preferences`, `project_facts`, `heuristics`) to filter on (category, scope) — `preferences` becomes `WHERE category='fact' AND scope='user'`, `project_facts` becomes `WHERE category='fact' AND scope='project'`, `heuristics` becomes `WHERE category='procedural' AND scope LIKE 'role:%'`, plus a new `episodes` view (`WHERE category='episodic'`). Drop the `role` column on `entries` — it's redundant with `scope='role:<role>'` and the dual-source-of-truth would diverge. Consolidator skill prompt rewrites the categorization step to emit the new taxonomy. Retrievers update their category/scope gates. Mirrors map: `preferences.md` (scope=user), `project.md` (scope=project), `agents/<role>.md` (scope=role:<role>), `episodes.md` (category=episodic).

### 2 — Mindwright-owned consolidator spawner with deterministic per-(project, agent) identity

The current model assumes the user manually runs `/mindwright:dream` when the Stop hook nudges them. The corrected model auto-spawns a dedicated consolidator peer. Decision: the spawner lives in **mindwright**, not in agentwright or forgewright, because mindwright is the memory manager and is the only one that knows when the spawn needs to fire (cap crossed / safety net elapsed / dream completed / role assignment).

Determinism: the consolidator handle is keyed by `(project_path_hash, requesting_agent_handle)` so the SAME peer agent always gets the SAME consolidator handle across sessions. Mindwright persists the mapping in `meta` under key `consolidator_for:<requester_handle>` and writes a wrightward-style handle stub (e.g. `consolidator-<hash6>`) on first spawn. Subsequent triggers reuse the handle: if it's idle, send a handoff; if it's already busy, queue the request via wrightward's standard inbox.

Spawn mechanism: mindwright shells out to `claude --headless` (or the documented spawn API once stable) with the consolidator's prompt baked in as a SessionStart skill injection. The spawned process binds to wrightward, picks up its handle from the stable id, listens for handoffs, executes `/mindwright:dream` when one arrives, acks. Daemon-side; the requesting session keeps working.

Open questions to resolve in the planning phase:
- Process supervision: does mindwright keep the consolidator alive between handoffs, or spawn-on-demand-die-on-idle? Long-lived is faster (model cache stays warm in the consolidator's own daemon) but doubles RAM. Spawn-on-demand pays ~3s of cold-start but is leaner.
- Failure semantics: if the spawn fails (no Claude binary in PATH, subscription out of credit, etc.), do we degrade gracefully back to the existing "nudge the user" path? Probably yes — the nudge is the safe fallback.
- Cost visibility: the consolidator burns user subscription tokens silently. Should `/mindwright:status` track the consolidator's recent activity (drains performed, tokens spent if discoverable) so the user can see what their consolidator did overnight?

### 3 — Role assignment via forgewright leader calling mindwright directly

Roles are currently free-form strings in mindwright with no canonical taxonomy and no injection mechanism. Decision: **the forgewright leader invokes `mindwright_assign_role(session_id, role)` immediately before `wrightward_send_handoff`**. No wrightward schema change. No new role field on the handoff event. Two MCP calls, clean separation:

```
mindwright_assign_role(session_id="<receiver-session-uuid>", role="implementer")
wrightward_send_handoff(to="<receiver-handle>", task_ref=..., next_action=..., files_unlocked=...)
```

Storage keying: `session_id` is the stable identity (Claude Code session UUID; persists across PreCompact / PostCompact / SessionStart-on-resume within a single Claude process). The handle is `deriveHandle(session_id)` — pure function, 1:1 derived (`wrightward/lib/handles.js:24-33`), so storing under `roles:<session_id>` or `roles:<handle>` is equivalent. The existing mindwright implementation uses `meta:roles:<session_id>` — leave it that way, no schema change to that part. The leader knows the receiver's handle from `wrightward_bus_status` and can resolve handle → session_id via a roster-lookup helper (already in wrightward), or `mindwright_assign_role` accepts handle and resolves internally. Pick one in planning.

Two hooks own the injection:

**SessionStart hook** (already exists in mindwright; extend it):
1. Read own `session_id` from the hook input JSON.
2. Look up `meta:roles:<session_id>` → JSON array of roles (or empty).
3. For each role, look up the prompt fragment in `lib/role-prompts.js`.
4. Concatenate fragments and emit via `hookSpecificOutput.additionalContext`.
5. Cache the role-set in a per-session sidecar file (e.g. `.claude/mindwright/sessions/<session_id>/role.json`) so the PostToolUse hook below can diff cheaply without re-hitting the DB on every wrightward call.

**PostToolUse hook on `wrightward_list_inbox`** (new — needed because role assignment can happen mid-session, AFTER SessionStart already fired):
1. Matcher restricted to `mcp__plugin_wrightward_wrightward-bus__wrightward_list_inbox` ONLY. A bus-read is the natural sync point: the leader's `mindwright_assign_role` call lands as a side-effect of the upcoming handoff, and the receiver's first awareness of that handoff (and thus the role change) is the next `wrightward_list_inbox` reading the channel-push event. Reinjecting after `wrightward_send_*` would be spam — sends are the agent's own action, no new role context arrives via them.
2. Read `meta:roles:<own-session_id>` from the DB.
3. Compare against the cached role-set in `.claude/mindwright/sessions/<session_id>/role.json`.
4. If different: emit the NEW role's prompt fragment via `additionalContext` (the diff — only what's been added since last check). Update the sidecar cache.
5. Unassignment: if a role was removed, emit a short "role X has been unassigned; the prompt for that role no longer applies" note. We can't retract the already-injected prompt from live context, but we can mark it stale.

This handles three cases cleanly:
- **Fresh session, role pre-assigned by leader**: SessionStart sees it, injects on boot.
- **Mid-session reassignment**: leader writes `meta:roles:<id>`; the receiver's next `wrightward_list_inbox` (after the channel push for the new handoff) triggers PostToolUse, which detects the diff and injects.
- **Post-compaction resume**: SessionStart fires on resume, re-reads `meta:roles:<id>`, re-injects from scratch (the compaction wiped the prior injection from working memory; the cache sidecar is in the filesystem and unaffected).

Canonical role registry (initial set; extensible by user):
- **planner** — designs implementation plans. Prompt: "you decompose work into independent tasks, design before code, surface risks before they bite."
- **implementer** — writes the code. Prompt: "you implement the plan as written, deviate only with leader approval, surface ambiguity rather than improvising."
- **reviewer / validator** — catches mistakes. Prompt: "you are an adversarial reviewer; your job is to catch other agents' fabrications, missed scope, weak tests, and hand-waved correctness claims. Be specific and evidence-based."
- **consolidator** — the spawned peer from decision 2. Prompt: the existing `/mindwright:dream` skill body.
- **tester** — writes / runs tests. Prompt: "you write tests for behavior, not implementation; you cover the named contracts and edge cases the plan calls out; failing tests block; you do not skip or weaken assertions to make CI green."

Each role prompt lives in `mindwright/lib/role-prompts.js` (one constant per role, no runtime templating). Multi-role per session is supported by the storage shape (JSON array under `meta:roles:<session_id>`) — open question is whether concatenated prompts compose cleanly; check empirically during the planning phase.

### 4 — Proactive recall: novelty as the primary gate, length modulates top-k

The user-facing question: "if the agent has a thinking block claiming the time is 11am, would it recall the episodic memory ('I claimed false time, user got upset') BEFORE telling the user without checking?"

Current gate is `thinking_len >= 500 AND (cooldown_elapsed OR thinking_len >= 2000)`. The length floor was noise-suppression but it also misses high-stakes short thinking blocks ("OK the time is 11am, I'll just tell them"). User explicitly prefers false-positives that occasionally cost a retrieval over false-negatives that miss a critical memory at the right moment.

Rejected: regex-based "salience detection." Regex on "the time is" / "I claim X" / commitment language has too many false positives (incidental phrasing, paraphrases, idioms) AND impossible coverage of every important pattern. Wrong tool for semantic classification.

**Adopted: novelty as the primary gate; length modulates the top-K budget instead of being a fire/skip decision.**

Mechanism:
- Every PreToolUse computes the thinking block's query embedding and compares against `meta:last_retrieval_query_emb:<sessionId>`.
- **Fire retrieval iff `cosine < 0.85`** (genuinely new topic). On the first PreToolUse of a session, no prior embedding exists → always fire. After firing, store the new query embedding. No length floor — trivial thinking ("ok", "done") will produce a low-information embedding, but the existing `rerank_floor=0.10` filter at the back of the TEMPR pipeline already drops candidates with no real relevance signal; adding a separate char-count gate is redundant suppression.
- **Top-K is a function of thinking length**: ≤200 chars → K=3, 200–1000 chars → K=5, >1000 chars → K=8. Short thinking = small bite; long thinking = broader sweep. The retrieval cost differs in the rerank pass (cross-encoder runs over fewer candidates).
- **Cooldown is dropped** — novelty subsumes it. Cooldown was a coarse proxy for "we just retrieved on similar content"; novelty is the principled version.
- **Dedup: skip facts already in context.** Maintain a per-session set `meta:injected_fact_ids:<sessionId>` (JSON array of ids, append-only within a session, cleared on SessionStart). Every retrieval path — PreToolUse novelty-gated, UserPromptSubmit, self-recall on draft replies — filters its top-K candidates through this set BEFORE emitting `additionalContext`: any candidate whose id is already in the set is dropped. After emission, the set is extended with the newly-injected ids. This handles the dominant case (we just injected fact F two turns ago, it's still in working memory) at near-zero cost. The fuzzy case (a fact arrived via user paste, plan body, or another route — not via mindwright injection) is not handled; designing that out requires content-hash lookup against the active long-term tier, deferred until it shows up as a real problem in practice.

Cost: every PreToolUse pays one embed pass on the thinking block (≤50ms warm). The dedup set lookup is O(K) per retrieval — negligible.

The gate becomes: `cosine(thinking_emb, last_query_emb) < NOVELTY_THRESHOLD` where `NOVELTY_THRESHOLD=0.85`. Single path to retrieval. Top-K varies with length. Output is filtered through the per-session injected-fact set.

**Hook gap for think → text-only flows (verified, not waiting on upstream)**: there is NO Claude Code hook between thinking and assistant text emission. Verified against the official Claude Code hooks documentation (https://code.claude.com/docs/en/hooks — 29 events total: SessionStart, Setup, UserPromptSubmit, UserPromptExpansion, PreToolUse, PermissionRequest, PermissionDenied, PostToolUse, PostToolUseFailure, PostToolBatch, Notification, SubagentStart, SubagentStop, TaskCreated, TaskCompleted, Stop, StopFailure, TeammateIdle, InstructionsLoaded, ConfigChange, CwdChanged, FileChanged, WorktreeCreate, WorktreeRemove, PreCompact, PostCompact, Elicitation, ElicitationResult, SessionEnd — none fire between thinking and text). `Stop` fires "when Claude finishes responding" — AFTER the text has already streamed. So the mechanical PreToolUse-gated retrieval only catches thinking blocks whose IMMEDIATE NEXT action is a tool call. The think → text-only flow is mechanically uncatchable; we work around it in design rather than wait on Anthropic to add a hook.

**Behavioral counterpart: self-recall rule.** A base SessionStart `additionalContext` injection (always-on, role-independent) instructs every mindwright-enabled agent:

> Before composing any text reply to the user, call `mindwright_recall(<draft of your response>)` once. Read the top results. If any of them is a relevant episodic memory or a contradicting fact, incorporate the correction (or hold the reply and verify) before sending. This rule applies to every text emission, including short answers; it costs ~50ms and a few hundred tokens, and it is the only mechanism that catches think → text-only mistakes since Claude Code has no hook between thinking and assistant text.

This is voluntary compliance, not hook-enforced. Persistence relies on:
- **SessionStart injection** at every boot and at every post-compaction resume (SessionStart re-fires on resume). Claude Code re-attaches SessionStart `additionalContext` on the post-compaction continuation, so the rule survives compaction by virtue of the hook re-firing, not by being re-piped through wrightward tools.
- **Targeted reinjection on bus-read only**: PostToolUse hook fires on `wrightward_list_inbox` specifically (matcher restricted to that tool, NOT broad wrightward-`*`). A bus-read is the moment the agent receives new external context (peer messages, handoffs, decisions) — exactly when re-grounding the self-recall rule is useful before the agent decides what to do with that new content. Reinjection on `wrightward_send_*` tools is omitted; sends are the agent's own action and adding a rule reminder right after them is spam.

Cost: every assistant text emission pays one recall call (one embed + one rerank + one DB read). Hot path is ~50ms. The agent reads top-K results in its own context, so token cost is ~K × ~200 tokens. K is the same length-modulated value from the novelty path (≤200 chars draft → K=3, etc.).

**Together**, the two mechanisms cover the full think→action surface:
- **think → tool**: novelty-gated PreToolUse hook fires retrieval automatically; the next tool turn reads the injected `additionalContext` and adjusts.
- **think → text-only**: the agent self-invokes `mindwright_recall` before emitting the text. Behavioral; the rule is always-on (SessionStart) and re-grounded after bus-reads.

## Future ideas

- **Memory linking / spreading activation for retrieval.** The `entities` + `entry_entities` substrate already exists but `graphSearch` (lib/retrievers.js:34) is one-hop: query → entity → entries. A two-hop extension would, after the RRF fusion in `retrieve()` (lib/retriever.js:107), take each top-N seed entry, pull other entries sharing any of its entities, weight them by inverse entity-degree (IDF-style — common entities like high-degree function names contribute little, rare entities like a specific file path contribute more), mix the expanded set back into the fused ranking, and let the cross-encoder + `rerank_floor=0.10` clip the noise. Two design considerations: (a) IDF must be entity-kind aware — a `function` entity (e.g. `extractEntities`) can fan across most of long-term, while `peer_handle` entities rarely have high degree; raw IDF probably suffices but worth a sanity-check on real data; (b) the semantic-path recency boost (retriever.js:152) is already lifting fresh rows, so the spreading-activation weight needs to compose with it rather than overshadow. A cleaner-but-pricier variant replaces the entity-overlap proxy with an LLM-curated `entry_links(from_id, to_id, relation, weight)` table populated by the consolidator at fact-extraction time — `supersedes` is one structured relation today; generalize to "explains", "depends-on", "contradicts", "elaborates". Walks an authored graph instead of inferring one from token overlap: more expensive per consolidation pass, higher signal per hop. Defer until we have data on whether the cheap entity-overlap version's drift control is good enough; if drift dominates, jump directly to the curated edge table rather than band-aiding entity weights.
