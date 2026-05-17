// Shared constants for mindwright.

// Reciprocal Rank Fusion constant. Standard k=60.
export const RRF_K = 60;

export const PER_RETRIEVER_N = 50;

// Floor on the cross-encoder sigmoid score; candidates below it are dropped.
export const RERANK_FLOOR = 0.10;

// Window over which the semantic recency boost decays linearly to zero.
export const RECENCY_BOOST_DAYS = 14;

// Max additive recency boost; small vs typical bge-m3 cosine magnitudes
// (0.4–0.8) so it only tie-breaks near-identical scores, never overcomes a
// real semantic gap.
export const RECENCY_BOOST_MAX = 0.05;

// Candidates passed into the cross-encoder rerank pass; the pass scales
// linearly in count and dominates retrieval wall time, so this caps PreToolUse
// hook latency.
export const RRF_TOP_FOR_RERANK = 20;

// Subset of wrightward URGENT_TYPES (source of truth:
// wrightward/lib/bus-schema.js) that opens a new exchange in the chunker.
// Excludes ack/file_freed/delivery_failed: delivery mechanics, not
// conversational content. Keep in sync if wrightward adds an urgent type.
export const INBOX_PRIMARY_EVENT_TYPES = [
  'user_message',
  'agent_message',
  'handoff',
  'blocker',
  'finding',
  'decision',
];

// Stored-kind view of INBOX_PRIMARY_EVENT_TYPES after the chunker's
// kindForEventType remap, plus 'cli_prompt'. Keep in lockstep with
// kindForEventType (both chunker and consolidator derive from this list).
export const STORED_EXCHANGE_OPENERS = new Set([
  'cli_prompt',
  'discord_user', // remapped from user_message
  'agent_message',
  'handoff',
  'blocker',
  'finding',
  'decision',
]);

// Allowlist of wrightward outbound tool names the chunker keeps (all other
// tool_use blocks are dropped). Matched against the BARE name (suffix after
// the last '__'), so MCP-namespaced wire names also match.
export const WRIGHTWARD_OUTBOUND_TOOLS = [
  'wrightward_send_message',
  'wrightward_send_note',
  'wrightward_send_handoff',
  'wrightward_ack',
];

// Bare name of the inbox-listing tool (same bare-suffix matching as above).
export const WRIGHTWARD_INBOX_TOOL = 'wrightward_list_inbox';

// PreToolUse retrieval fires when cosine(thinking_emb, prior_query_emb) is
// below this; lower = fewer re-fires on similar thoughts.
export const NOVELTY_THRESHOLD = 0.85;

// Length-bucketed top-K for proactive recall: longer thinking blocks get more
// hits. length ≤ SMALL → small, ≤ MID → mid, else large.
export const TOP_K_BY_LENGTH = Object.freeze({ small: 3, mid: 5, large: 8 });
export const LENGTH_BUCKET_SMALL = 200;
export const LENGTH_BUCKET_MID = 1000;

// Per-session injected-fact-id dedup cap. ~one session's worth; older ids
// have rolled out of the agent's context so re-injecting them is fine.
export const INJECTED_FACT_IDS_CAP = 200;

// Self-recall instruction injected by SessionStart. Relies on voluntary
// compliance: no hook fires between thinking and assistant text in Claude
// Code, so an enforced surface doesn't exist.
export const SELF_RECALL_RULE =
  'Memory recall: before emitting any assistant text or making a decision ' +
  'based on what you "know" about this project or user, call mindwright_recall ' +
  'with a 1-2 sentence summary of your draft response. The returned facts ' +
  '(if any) carry weight equal to your reasoning — incorporate them. When ' +
  'recall returns an empty result set, proceed normally.';

// Once-per-session warning when the model daemon is unreachable, so degraded
// recall isn't silently indistinguishable from "no relevant facts existed".
export const DAEMON_DOWN_WARNING =
  '[mindwright] retrieval daemon is unreachable this turn — memory recall ' +
  'is disabled for the rest of this session. Run `/mindwright:status` to ' +
  'diagnose, or restart your Claude session to recover.';

// Short-term row count that triggers the Stop hook's dream nudge.
export const CAP_EXCHANGES = 50;

// Age-based dream trigger, independent of CAP_EXCHANGES: a quiet session that
// never crosses the cap still drains aging content.
export const SAFETY_NET_DAYS = 3;

// Min project-wide short-term rows before the age safety-net may fire;
// without it a quiet project re-nudges every ~3 days over the 1-2 rows that
// survive each drain.
export const SAFETY_NET_MIN_ROWS = 5;

// Lease for the spawned background consolidator: a later Stop re-surfaces the
// manual nudge only after this elapses with no `consolidations` row since the
// spawn. Generous on purpose — a rate-limited dream can run long, and nagging
// during a still-running consolidation is the worse failure.
export const CONSOLIDATOR_COMPLETION_GRACE_MS = 15 * 60 * 1000;

// Byte budget for the transcript-bootstrap loop (lib/seed-loop.js): once
// unconsolidated short rows exceed this it forces a drain cycle, so short-term
// never holds the whole corpus and a long bootstrap stays resumable. Raising
// it = fewer, heavier dream passes; lowering = tighter peak, more cycles.
export const SEED_BATCH_BUDGET_BYTES = 2 * 1024 * 1024;

// Backpressure for the seed loop's between-batch consolidate
// (lib/seed-consolidate.js): the spawn is fire-and-forget, so the loop must
// BLOCK until short-term drains back under SEED_BATCH_BUDGET_BYTES or it would
// ingest the whole corpus and launch corpus/budget detached consolidators.
//   - POLL_MS: re-measure / dream-completion poll interval.
//   - TIMEOUT_MS: per-boundary wait cap; erring long avoids ballooning
//     short-term while a slow dream is still running.
//   - MAX_PASSES: one dream drains only one bounded batch; re-spawn is
//     single-flight (never two live consolidators) and capped here so a
//     non-draining consolidator can't re-spawn forever.
export const SEED_CONSOLIDATE_POLL_MS = 2000;
export const SEED_CONSOLIDATE_TIMEOUT_MS = 20 * 60 * 1000;
export const SEED_CONSOLIDATE_MAX_PASSES = 8;

// Age past which mindwright_status warns about a stale preference; below this,
// fresh preferences are normal and a warning would be noise.
export const STALE_PREFERENCE_WARN_DAYS = 60;

// Distilled categories a tier='long' row may carry. The matching DB CHECK in
// db/migrations/0001_init.sql duplicates this list and MUST be kept in
// lockstep BY HAND (better-sqlite3 can't bind a JS array into DDL). 'raw'
// (tier='short' chunker output) is deliberately excluded. Frozen so a
// downstream mutation is a write-time TypeError.
export const LONG_CATEGORIES = Object.freeze(['procedural', 'episodic', 'fact']);

// Max retrieval results returned via additionalContext.
export const TOP_K_DEFAULT = 8;

// Role tag whitelist. Roles flow into filesystem paths under
// mirrors/agents/<role>/, so the conservative charset blocks path-traversal
// payloads (.., separators, drive prefixes, NUL) before they reach disk.
export const ROLE_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

// ABI-locked native packages that gate readiness. lib/ready.js (node_modules
// dir check) and lib/health-marker.js (ABI marker check) MUST agree on this
// list or depsInstalled() is silently wrong; it lives here (dep-free) so
// neither readiness module imports the other. Frozen against mutation.
export const NATIVE_DEPS = Object.freeze(['better-sqlite3', 'sqlite-vec']);

// session_id whitelist (defense-in-depth): session_id flows into filesystem
// paths and pipe-namespace strings, so a traversal payload would land the
// socket outside the data dir. 128 chars leaves room for synthetic test ids.
export const SESSION_ID_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;

// Ticket liveness window: a ticket newer than this means a live session,
// older is a crashed-session straggler. The cleanup pass (daemon-ticket.mjs)
// and the alive probe (daemon-status.js) MUST agree on this value or cleanup
// could remove a ticket the probe still considers live (or vice-versa).
export const DAEMON_TICKET_MAX_AGE_MS = 10 * 60 * 1000;

// ONE machine-wide model daemon owns the embedder + reranker over a fixed
// global socket, so the ~1-2 GB of ONNX weights load once per box.
// MODEL_DAEMON_PROTOCOL is baked into the socket/lock filename so a wire-format
// change rotates to a fresh daemon instead of talking to a stale one. Bump on
// any wire change.
export const MODEL_DAEMON_PROTOCOL = 1;

// bge-m3 embedding width. Here, not in lib/models.js, so non-model code can
// read it without dragging in the top-level-awaited ONNX runtime.
export const EMBEDDING_DIM = 1024;

// Daemon idle self-exit (frees ~1-2 GB); long enough to outlive normal
// think/tool gaps within an active session.
export const MODEL_DAEMON_IDLE_EXIT_MS = 15 * 60 * 1000;

// Pipe-client RPC timeout. embed/rerank round-trips settle in <100ms; 5s
// catches a wedged daemon without a hook hang the user would notice.
export const PIPE_DEFAULT_TIMEOUT_MS = 5000;

// Worst-case budget for a hook's retrieval block; PIPE_DEFAULT_TIMEOUT_MS
// caps each RPC individually, this caps their sum so a slow embed + slow
// rerank can't stack into ~10s of turn-start latency.
export const RETRIEVAL_OVERALL_TIMEOUT_MS = 8000;

// Entry kind for a long-tier distilled fact; single source of truth for
// production callers.
export const KIND_FACT = 'fact';

// Time-conversion constants, centralized so the same value isn't written
// three different literal ways across callers.
export const MS_PER_HOUR = 60 * 60 * 1000;
export const MS_PER_DAY = 24 * MS_PER_HOUR;

// Synthetic session_id author for rows written when scripts/mindwright.mjs
// runs with no --session-id (rows can't have a NULL author). Single source of
// truth: a typo would silently divorce the count readers from the writer.
export const UNBOUND_SESSION_ID = 'mindwright-unbound';

// `kind` validation. Brackets/newlines/angle-brackets are frame-breakers that
// could let a prompt-injected memory subvert recall-format's metaPrefix, so
// they're rejected here; formatRecall ALSO defangs the rendered kind for rows
// arriving via non-retain paths (chunker, seed-from-repo, consolidator).
export const KIND_PATTERN = /^[a-zA-Z0-9_-]{1,32}$/;

// Stop-hook anti-spam states: ARMED = next cap crossing fires the nudge;
// FIRED = already nudged, wait for count to drop below cap before re-arming.
// Frozen so a typo is a write-time TypeError, not a silently disabled guard.
export const NUDGE_STATES = Object.freeze({
  ARMED: 'armed',
  FIRED: 'fired',
});
