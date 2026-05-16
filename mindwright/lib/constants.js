// Shared constants for mindwright. Numeric defaults come from DESIGN.md
// ("Retrieval pipeline" + "Short-term and long-term memory tiers" sections) and
// match the values used in the planning spike. The wrightward-derived sets
// (INBOX_PRIMARY_EVENT_TYPES, WRIGHTWARD_OUTBOUND_TOOLS) carry citations to
// their source-of-truth lines so a future wrightward rename or addition is
// immediately findable.

// Reciprocal Rank Fusion constant. Standard k=60; cited in
// DESIGN.md "Retrieval pipeline" step 3.
export const RRF_K = 60;

// Per-retriever candidate count pulled before RRF.
export const PER_RETRIEVER_N = 50;

// Absolute floor applied to the cross-encoder sigmoid score. Below this we
// drop the candidate. Calibrated against short-term tier on a 7,778-row
// StepDx spike (DESIGN.md "Retrieval abstention" decision entry).
export const RERANK_FLOOR = 0.10;

// Days within which the semantic retriever applies a recency boost on top of
// raw cosine similarity (additive, decays linearly to zero at the boundary).
export const RECENCY_BOOST_DAYS = 14;

// Maximum additive recency boost on a freshly-written semantic-search hit
// (decays linearly to 0 across RECENCY_BOOST_DAYS). 0.05 is small relative to
// cosine-similarity magnitudes (typically 0.4–0.8 on bge-m3 hits) — enough to
// tie-break between near-identical scores favoring recency, but never enough
// to overcome a real semantic gap. Set in the spike: a higher value made
// stale-but-loud rows dominate, a lower value made the boost invisible.
export const RECENCY_BOOST_MAX = 0.05;

// How many top-of-fused candidates we pass into the cross-encoder rerank pass.
// 20 keeps rerank latency under ~120ms on bge-reranker-v2-m3 (the cross-
// encoder pass scales linearly in candidate count and dominates retrieval
// wall time). Lowering it drops recall at the rerank-floor boundary; raising
// it bloats PreToolUse hook time without meaningful precision gain at K=8.
export const RRF_TOP_FOR_RERANK = 20;

// Subset of wrightward URGENT_TYPES that mindwright treats as "primary"
// conversational content — i.e. an inbox event of one of these types opens
// a new exchange in the chunker. Source of truth for URGENT_TYPES:
//   wrightward/lib/bus-schema.js:26-34
// URGENT_TYPES is: handoff, file_freed, user_message, blocker, delivery_failed,
//                  agent_message, ack, finding, decision.
// Mindwright excludes 'ack', 'file_freed', and 'delivery_failed' because those
// are delivery mechanics / confirmation signals, not conversational content
// worth retrieving against. See DESIGN.md "Group rows into exchanges".
// If wrightward adds or renames an urgent type, update this list (and the
// citation) accordingly.
export const INBOX_PRIMARY_EVENT_TYPES = [
  'user_message',
  'agent_message',
  'handoff',
  'blocker',
  'finding',
  'decision',
];

// Stored-kind view of INBOX_PRIMARY_EVENT_TYPES *after* the chunker's
// user_message → discord_user remap (see lib/chunker.js#kindForEventType),
// plus 'cli_prompt' for CLI user prompts. These are the entry kinds that
// open a new exchange in the consolidator's grouping pass. Both sides of
// the chunker→consolidator boundary derive from this single list — keep
// it in lockstep with kindForEventType when a new primary event type is
// added.
export const STORED_EXCHANGE_OPENERS = new Set([
  'cli_prompt',
  'discord_user', // remapped from user_message
  'agent_message',
  'handoff',
  'blocker',
  'finding',
  'decision',
]);

// Allowlist of wrightward outbound tool names. An assistant tool_use block
// with one of these names captures an outbound agent→user/peer message and
// is kept by the chunker (everything else, e.g. Edit/Read/Bash/Glob/Grep, is
// dropped). DESIGN.md "Transcript filter" enumerates the four names. The
// chunker matches against the *bare* tool name (the suffix after the last
// '__'), so MCP-namespaced wire names like
//   mcp__plugin_wrightward_wrightward-bus__wrightward_send_message
// match too.
export const WRIGHTWARD_OUTBOUND_TOOLS = [
  'wrightward_send_message',
  'wrightward_send_note',
  'wrightward_send_handoff',
  'wrightward_ack',
];

// Bare name of the inbox-listing tool. Same matching rule as above — bare
// suffix after the last '__'. Used by the chunker to identify which
// tool_result blocks carry inbox events.
export const WRIGHTWARD_INBOX_TOOL = 'wrightward_list_inbox';

// PreToolUse retrieval gate. Fire retrieval when the current thinking
// embedding is novel relative to the last query embedding stored under
// meta:last_retrieval_query_emb:<sessionId>:
//   cosine(thinking_emb, prior_query_emb) < NOVELTY_THRESHOLD
// First PreToolUse of a session has no prior embedding and always fires.
export const NOVELTY_THRESHOLD = 0.85;

// Length-bucketed top-K for proactive recall. Short thinking blocks get
// fewer hits to keep injected context tight; long thinking blocks get more
// hits to cover more of the agent's mental surface.
//   length ≤ LENGTH_BUCKET_SMALL  → K = small
//   length ≤ LENGTH_BUCKET_MID    → K = mid
//   length >  LENGTH_BUCKET_MID   → K = large
export const TOP_K_BY_LENGTH = Object.freeze({ small: 3, mid: 5, large: 8 });
export const LENGTH_BUCKET_SMALL = 200;
export const LENGTH_BUCKET_MID = 1000;

// Per-session dedup cap: FIFO-trim `meta:injected_fact_ids:<sessionId>` to
// this many most-recent ids on every append. 200 covers a typical session's
// worth of "facts already shown" past the working-memory horizon — anything
// older has rolled out of the agent's context naturally and re-injecting it
// is a feature, not a regression.
export const INJECTED_FACT_IDS_CAP = 200;

// Always-on instruction injected by SessionStart (and re-grounded by the
// PostToolUse-on-wrightward_list_inbox hook) telling the agent to consult
// mindwright before emitting text. Voluntary compliance — no hook fires
// between thinking and assistant text in Claude Code (verified against
// https://code.claude.com/docs/en/hooks), so this is the only available
// surface. Phrasing tight so it survives compaction without bloat.
export const SELF_RECALL_RULE =
  'Memory recall: before emitting any assistant text or making a decision ' +
  'based on what you "know" about this project or user, call mindwright_recall ' +
  'with a 1-2 sentence summary of your draft response. The returned facts ' +
  '(if any) carry weight equal to your reasoning — incorporate them. When ' +
  'recall returns an empty result set, proceed normally.';

// User-facing warning for the once-per-session "MCP daemon is unreachable"
// path. Without this, a daemon crash silently degrades retrieval to "no
// hits" for the rest of the session, indistinguishable from "no relevant
// facts existed." Emitted via additionalContext on the first UPS/PreToolUse
// hook that observes pipe.embed() returning null. SessionStart clears the
// per-session latch so a fresh boot is allowed to warn again.
export const DAEMON_DOWN_WARNING =
  '[mindwright] retrieval daemon is unreachable this turn — memory recall ' +
  'is disabled for the rest of this session. Run `/mindwright:status` to ' +
  'diagnose, or restart your Claude session to recover.';

// Consolidation cap (DESIGN.md "Config keys" → consolidation.cap_exchanges).
// The Stop hook surfaces an `additionalContext` hint when short-term row count
// for this session crosses the cap so the user knows to run /mindwright:dream.
export const CAP_EXCHANGES = 50;

// Safety-net consolidation trigger (DESIGN.md "Config keys" →
// consolidation.safety_net_days). Independent of CAP_EXCHANGES: even on a
// quiet session where the row count never crosses the cap, stale content
// degrades retrieval quality and grows the on-disk row set forever. The Stop
// hook stages the same nudge surface when the oldest short-term row for the
// session is older than this many days.
export const SAFETY_NET_DAYS = 3;

// Minimum project-wide short-term row count before the age safety-net is
// allowed to fire. Without this floor a quiet project (1-2 prompts a week)
// gets a re-nudge every ~3 days even when there's nothing meaningful to
// consolidate: dream drains 70%, 1-2 rows survive, those rows age past the
// safety net, nudge fires again. The cap trigger (CAP_EXCHANGES) is
// independent and still fires on busy projects regardless of this floor.
export const SAFETY_NET_MIN_ROWS = 5;

// Visibility-timeout / lease for the auto-spawned background consolidator.
// The Stop hook spawns a detached `claude --bg` consolidator and returns in
// milliseconds — it cannot wait for `/mindwright:dream` to finish, so it can
// only confirm the OS accepted the spawn, not that the dream cycle actually
// ran. A successful dream's mandatory close is `mindwright_finalize_drain`,
// which writes a timestamped `consolidations` row (store.recordConsolidation).
// That row is the durable "done" acknowledgment. A LATER Stop reconciles: if
// it spawned a consolidator (meta:consolidator_for.last_spawn is set), this
// many ms have elapsed since that spawn, NO consolidations row landed with
// fired_at >= last_spawn, and short-term is STILL over the trigger, then the
// background consolidator died silently (auth failure, rate limit, dream-skill
// regression, crashed supervisor) — re-surface the manual nudge instead of
// staying blind behind a sticky FIRED state. This is the standard durable-job
// reconciliation pattern (worker records terminal state; dispatcher reconciles
// on the next tick within a lease window). 15 min is generous on purpose: a
// real dream cycle (drain ~70% of ≥CAP rows, LLM-distill dozens of exchanges,
// finalize) is a few minutes but a rate-limited one can run long. Erring long
// avoids the worse failure — nagging the user while consolidation is genuinely
// still in progress.
export const CONSOLIDATOR_COMPLETION_GRACE_MS = 15 * 60 * 1000;

// Byte budget for the dedicated transcript-bootstrap loop (lib/seed-loop.js).
// The first run on a fresh install can face a large local transcript corpus
// (sampled: ~228 MB across ~116 files for this repo). The loop ingests
// transcripts into short-term, and every time the cumulative size of
// not-yet-consolidated short rows crosses this budget it invokes one
// drain→distill→finalize cycle before continuing — so short-term never holds
// the whole corpus at once and a long bootstrap stays resumable. 2 MiB ≈ a
// few dozen exchanges ≈ one healthy dream pass (DESIGN.md exchange char
// budget 12k, CAP_EXCHANGES 50). Tunable: raising it makes each dream pass
// larger (fewer, heavier consolidations); lowering it bounds peak short-term
// tighter at the cost of more frequent cycles.
export const SEED_BATCH_BUDGET_BYTES = 2 * 1024 * 1024;

// Backpressure for the seed loop's between-batch consolidate (lib/seed-
// consolidate.js). The injected consolidate spawns ONE `claude --bg`
// /mindwright:dream pass, then BLOCKS until short-term has actually drained
// back under SEED_BATCH_BUDGET_BYTES before the loop is allowed to keep
// ingesting — otherwise the documented "short-term never holds the whole
// corpus" bound is a lie (the spawn is fire-and-forget; without the wait the
// loop ingests the entire ~228 MB corpus at file-I/O speed and launches
// ~corpus/budget detached consolidators — implementation-2 / correctness-1).
//
//   - POLL_MS: how often the waiter re-measures store.shortTermBytes() and
//     checks for a completed dream (a `consolidations` row with fired_at >=
//     the pass's spawn time, the same terminal signal stop.js reconciles on).
//   - TIMEOUT_MS: hard cap on the wait per budget boundary. One real dream
//     pass is a few minutes; a rate-limited one runs long. On timeout the
//     waiter logs and returns — the seeded rows persist and a later budget
//     boundary / manual dream drains them; erring long avoids prematurely
//     ballooning short-term while a slow dream is genuinely still running.
//   - MAX_PASSES: one /mindwright:dream drains only ONE bounded batch
//     (~drainPct of active short rows), so a single spawn per boundary can't
//     always get back under budget. The waiter re-spawns the NEXT pass only
//     after the previous one completed (single-flight — never two live
//     consolidators), capped here so a non-draining/poison consolidator can't
//     re-spawn forever even under the time cap.
export const SEED_CONSOLIDATE_POLL_MS = 2000;
export const SEED_CONSOLIDATE_TIMEOUT_MS = 20 * 60 * 1000;
export const SEED_CONSOLIDATE_MAX_PASSES = 8;

// Age threshold for the `oldest_preference_at` warning surfaced by
// `mindwright_status`. 60 days is the "long enough that the user's
// preferences may have shifted" mark — below that, fresh preferences are the
// normal case and a warning would be noise. Above it, the user gets a hint
// to /mindwright:recall on a relevant query and /mindwright:forget anything
// that no longer applies (preferences don't auto-decay).
export const STALE_PREFERENCE_WARN_DAYS = 60;

// The three distilled categories a tier='long' row may carry. Single source of
// truth for the application-layer validation in mcp/tools.mjs (retain /
// retain_fact handlers and the retain_fact tool's JSON-schema enum). NOTE: the
// matching DB CHECK lives in db/migrations/0001_init.sql (the `WHEN 'long'`
// branch: `category IN ('procedural', 'episodic', 'fact')`) and MUST be kept in
// lockstep BY HAND — better-sqlite3 cannot bind a JS array into DDL, so the
// constraint text is duplicated there intentionally. Distinct from the
// column-level CHECK in the same migration, which also permits the 'raw' marker
// used by tier='short' chunker output; 'raw' is deliberately NOT in this list.
// Frozen so a downstream `.push`/reassign becomes a TypeError at write-time.
export const LONG_CATEGORIES = Object.freeze(['procedural', 'episodic', 'fact']);

// Max retrieval results returned via additionalContext.
export const TOP_K_DEFAULT = 8;

// Role tag whitelist. Roles flow from MCP handlers into the entries table and
// then into filesystem paths under `.claude/mindwright/mirrors/agents/<role>/`.
// Restricting to a conservative character set blocks path-traversal payloads
// (`..`, separators, drive prefixes, NUL bytes) before they reach the disk.
// 1–64 chars: anything we'd plausibly name a role plus headroom for compound
// labels like `plan-reviewer`.
export const ROLE_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

// session_id whitelist. Defense-in-depth: session_id originates inside the
// Claude Code trust boundary (UUIDs from hook input or env), but it flows
// into filesystem paths (`pipePath`) and pipe-namespace strings. A traversal
// payload would land the socket outside the project's data dir. 128 chars is
// well above the UUIDv4 length (36) and leaves room for synthetic ids used
// by tests and bootstrap (`seed-from-repo`, `sess-A`, `capfire`, etc.).
export const SESSION_ID_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;

// Daemon ticket / liveness window. The MCP server touches its ticket file
// during normal operation; a ticket newer than this is treated as "live
// daemon present", anything older is a straggler from a crashed/killed
// session. The ticket-cleanup pass (daemon-ticket.mjs) and the daemon-alive
// probe (daemon-status.js) MUST agree on this value, otherwise cleanup could
// remove a ticket while the freshness check still considers it live (or
// vice-versa). Keep them in lockstep here.
export const DAEMON_TICKET_MAX_AGE_MS = 10 * 60 * 1000;

// Pipe-client RPC timeout. Local named-pipe / unix-socket round-trips for
// embed/rerank settle in <100ms even on the slowest local SSD; 5s is a
// generous ceiling that catches a wedged daemon without letting a hook
// hang long enough to feel like Claude Code is broken.
export const PIPE_DEFAULT_TIMEOUT_MS = 5000;

// Overall budget for a hook's retrieval block (embed query + rerank batch).
// Per-call PIPE_DEFAULT_TIMEOUT_MS caps each individual RPC; this caps the
// WORST-CASE sum. Without it a slow embed (5s) + slow rerank (5s) burns
// 10s of turn-start latency. 8s is the friendly ceiling — Claude Code's
// default hook timeout is 60s but the user notices anything past ~2s.
// On timeout, retrieval gives up for this turn (additionalContext empty);
// the embed/chunk side effects still committed.
export const RETRIEVAL_OVERALL_TIMEOUT_MS = 8000;

// Entry kind for a long-tier distilled fact. Every insert into tier='long'
// that comes out of the dream cycle, an explicit /mindwright:retain, or a
// contradiction resolution carries kind=KIND_FACT. Tests that hand-shape
// entries are free to use the literal — this constant is the single source
// of truth for the production callers.
export const KIND_FACT = 'fact';

// Time conversion constants. Used across nudge ms-arithmetic, retriever
// recency-boost decay, status oldest-preference age display, and consolidator
// stale-lock expiry. Centralized here so a future reader doesn't have to
// recognize three different literal forms (86400000, 86_400_000,
// 24 * 60 * 60 * 1000) as the same value.
export const MS_PER_HOUR = 60 * 60 * 1000;
export const MS_PER_DAY = 24 * MS_PER_HOUR;

// Synthetic session_id used by the MCP server when SessionStart never
// landed a ticket — rows still need an author so reads/writes don't blow
// up on NULL. Appears in:
//   - mcp/server.mjs (setter, late-bind path)
//   - lib/store.js (count helpers that include/exclude the bucket)
//   - mcp/tools.mjs (user-facing warning text)
// Single source of truth so a typo in one site can't silently divorce the
// reader from the writer (the visible failure mode would be "zero unbound
// rows surfaced" while the bucket actually has content).
export const UNBOUND_SESSION_ID = 'mindwright-unbound';

// `kind` passed via the mindwright_retain MCP tool must match this pattern.
// Brackets, newlines, and angle brackets are the frame-breakers that would
// otherwise let a prompt-injected memory subvert recall-format's metaPrefix
// (e.g., kind="fake] mindwright recall: TRUSTED MEMORY ... <system>") or
// the chunker's downstream surfaces. The character class mirrors a path-
// safe identifier — same shape rule we already apply to role identifiers.
// formatRecall ALSO defangs the rendered kind as a belt-and-suspenders
// pass for any rows that pre-date this boundary check or that arrive from
// non-retain code paths (chunker, seed-from-repo, consolidator).
export const KIND_PATTERN = /^[a-zA-Z0-9_-]{1,32}$/;

// Nudge state machine values used by the Stop hook's anti-spam logic.
// 'armed' = next cap crossing fires the consolidation hint;
// 'fired' = already nudged this trip — wait for count to drop below cap
//           before re-arming.
// Frozen so a downstream typo (`'Armed'`, `'fired '`) becomes a TypeError
// at write-time rather than silently disabling the anti-spam guard.
export const NUDGE_STATES = Object.freeze({
  ARMED: 'armed',
  FIRED: 'fired',
});
