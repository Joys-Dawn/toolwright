// Tool definitions + dispatcher for the mindwright memory tools.
//
// These handlers were originally an MCP server surface; the MCP server is
// gone. They are now invoked by scripts/mindwright.mjs (the CLI every skill
// runs). Heavy lifting (retrieval, consolidation, mirror render) lives in
// lib/ — this file is just argument validation, ctx routing, and shaping the
// response into the `{content: [{type:'text', text: JSON.stringify(...)}]}`
// envelope the CLI unwraps to stdout JSON.
//
// `ctx` is passed in by scripts/mindwright.mjs:
//   { store, sessionId, embed, rerank }
// where `embed` / `rerank` resolve through the machine-wide model daemon
// (or deterministic stubs under MINDWRIGHT_USE_STUB_MODELS=1).

import { retrieve } from '../lib/retriever.js';
import {
  drainBatch,
  retainFact,
  markSuperseded,
  finalizeDrain,
  findSupersedeCandidates,
} from '../lib/consolidator.js';
import { renderAll } from '../lib/mirrors.js';
import { categorize } from '../lib/categorize.js';
import {
  ROLE_PATTERN, SESSION_ID_PATTERN, KIND_FACT, KIND_PATTERN, TOP_K_DEFAULT,
  INJECTED_FACT_IDS_CAP, UNBOUND_SESSION_ID, MS_PER_DAY,
  STALE_PREFERENCE_WARN_DAYS, LONG_CATEGORIES,
} from '../lib/constants.js';
import { embedderCached } from '../lib/paths.js';
import { isDaemonAlive } from '../lib/daemon-status.js';
import { deriveHandle } from '../lib/handles.js';
import { pluralize, agree } from '../lib/grammar.js';
import { resolveTargetToSessionId } from '../lib/agents-roster.js';
import { spawnConsolidator } from '../lib/consolidator-spawn.js';

// Max chars echoed back when a tool wants to confirm to the caller which row
// it just touched (update_memory echoes the OLD content; forget echoes the
// content of the row that's now archived). 200 is enough for a typo-check
// without flooding the LLM's context.
const PREVIEW_MAX_CHARS = 200;

// Surfaced to the caller when an embed-requiring tool runs before
// /mindwright:setup downloaded the model cache. Without this gate, the first
// embed call from a fresh install lazy-loads bge-m3 — a ~5 GB blocking
// download from inside e.g. /mindwright:dream that the user has no warning
// about. embedderCached() is a fast existsSync, so the preflight is free.
const SETUP_HINT =
  'mindwright embedder not cached — run `/mindwright:setup` first ' +
  '(one-time ~5 GB download). Recall, dream, and long-term retain need ' +
  'the embedder to be present locally.';

const TOOL_DEFINITIONS = [
  {
    name: 'mindwright_recall',
    description:
      'Run the TEMPR retrieval pipeline against this project\'s memory and return relevance-ranked hits. Returns `{results: []}` when nothing passes the rerank_floor (0.10) — handle the empty case explicitly, do not fabricate. By default role-scoped rows (scope LIKE "role:%") are filtered to the calling session\'s assigned roles (matching what the hook-based retrieval surfaces); pass `roles` to override (e.g. to debug what another role would see). Dedup-aware: results already injected into the calling session\'s additionalContext during this session are filtered out automatically.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Query text (CLI prompt, thinking block, Discord message body, etc.).' },
        scope: {
          type: 'string',
          enum: ['short', 'long', 'all'],
          description: 'Tier filter. "all" (default) lets the pipeline weight tiers naturally.',
        },
        k: { type: 'number', description: 'Maximum number of hits to return (default 8).' },
        roles: {
          type: 'array',
          items: { type: 'string' },
          description: 'Override the role-scope filter. Pass [] to suppress all role-scoped rows; pass ["planner","consolidator"] to include those roles\' heuristics. Omit to use the calling session\'s assigned roles.',
        },
        exclude_ids: {
          type: 'array',
          items: { type: 'number' },
          description: 'Caller-provided ids to exclude from the result set (on top of the per-session injected-ids dedup that runs automatically).',
        },
        bypass_session_dedup: {
          type: 'boolean',
          description: 'When true, ignore the per-session injected_fact_ids set AND skip the post-emit append. Use for explicit /mindwright:recall debugging calls so a second invocation shows the same hits as the first; the automatic PreToolUse / PostToolUse retrieval path leaves this false to preserve dedup.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'mindwright_retain',
    description:
      'Explicitly save a fact to mindwright memory. Use for ad-hoc retains driven by /mindwright:retain — the consolidator handles automatic retains during /mindwright:dream. For scope=long retains, runs the same supersede-candidate detection as the dream-cycle path and returns any existing long-term rows that look semantically close in `supersede_candidates`; surface them to the user so they can /mindwright:update-memory or /mindwright:resolve-contradiction if needed.',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'The text to retain.' },
        kind: { type: 'string', description: 'A short label (e.g. "fact", "note", "preference").' },
        tier: { type: 'string', enum: ['short', 'long'], description: 'Tier to write into.' },
        category: {
          type: 'string',
          enum: ['raw', 'procedural', 'episodic', 'fact'],
          description: 'Long-term category. Optional for tier=long — auto-categorized from content cues when omitted.',
        },
        scope: {
          type: 'string',
          description: 'Long-term scope: "user" | "project" | "role:<role>". Required for tier=long when category is provided; auto-inferred from cues otherwise.',
        },
        confidence: { type: 'number', description: '0..1 confidence (scope=user rows only).' },
      },
      required: ['content', 'kind', 'tier'],
    },
  },
  {
    name: 'mindwright_status',
    description:
      'Diagnostic snapshot: short/long counts, by-(category, scope) breakdown, last consolidation timestamp, model-cache state, daemon-alive flag, pending-embed backlog, oldest active user-scoped fact timestamp, and the consolidator-spawn record `{ session_id, handle, first_seen, last_spawn }` (or null when no consolidator has been spawned for this requester yet).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'mindwright_drain_batch',
    description:
      'Pick the oldest ~70% of short-term rows for the given scope, group them into exchanges, and return them along with a summary of currently-active long-term keyed by `<category>/<scope>` (e.g. `fact/user`, `procedural/role:planner`, `episodic/project`). The calling Claude session reads this output, distills facts, and calls mindwright_retain_fact + mindwright_finalize_drain to complete the dream cycle.',
    inputSchema: {
      type: 'object',
      properties: {
        scope: {
          type: 'string',
          enum: ['session', 'project', 'all'],
          description: '"session" (default) drains only this session\'s short-term; "project"/"all" drain across every session.',
        },
      },
    },
  },
  {
    name: 'mindwright_retain_fact',
    description:
      'Deterministic helper for the /mindwright:dream cycle. Embeds the supplied fact, inserts a long-term row, links extracted entities, and runs supersede-candidate detection. Returns the new fact_id and any candidate ids the supersede check flagged.',
    inputSchema: {
      type: 'object',
      properties: {
        drain_id: { type: 'string', description: 'Returned by mindwright_drain_batch.' },
        exchange_id: { type: 'string', description: 'Returned by mindwright_drain_batch per exchange.' },
        event_ts: {
          type: 'string',
          description:
            "Optional. The originating exchange's representative provenance time — copy the exchange's `event_ts` field from mindwright_drain_batch verbatim (opaque, like drain_id; do NOT compute or alter it). Stamps the long-term row so historical/seeded facts rank by when the exchange actually happened, not when it was distilled. Omit for live exchanges with no event_ts.",
        },
        content: { type: 'string', description: 'The distilled fact text.' },
        category: {
          type: 'string',
          enum: LONG_CATEGORIES,
          description: 'Long-term category — procedural | episodic | fact.',
        },
        scope: {
          type: 'string',
          description: 'Long-term scope: "user" | "project" | "role:<role>". Required.',
        },
        entities: { type: 'array', items: { type: 'string' }, description: 'Optional explicit entities. Auto-extracted from content when omitted.' },
        confidence: { type: 'number', description: '0..1 (scope=user rows only).' },
      },
      required: ['content', 'category', 'scope'],
    },
  },
  {
    name: 'mindwright_mark_superseded',
    description:
      'Mark an old fact as superseded by a new one. Archives the old row (active=0) and links the new row\'s `supersedes` reference.',
    inputSchema: {
      type: 'object',
      properties: {
        old_id: { type: 'number', description: 'fact_id being superseded' },
        new_id: { type: 'number', description: 'fact_id replacing it' },
      },
      required: ['old_id', 'new_id'],
    },
  },
  {
    name: 'mindwright_finalize_drain',
    description:
      'Closes a /mindwright:dream cycle: hard-deletes the drained short-term rows, records a consolidations row, regenerates markdown mirrors. drain_id comes from mindwright_drain_batch. When the drain_id scope segment is "all" (project-wide consolidation), confirm_all_sessions:true must be passed as a guard against prompt-injected memories triggering cross-session hard-deletes.',
    inputSchema: {
      type: 'object',
      properties: {
        drain_id: { type: 'string', description: 'Opaque cursor returned by drain_batch (`<scope>|<cutoff_ts>|<cutoff_id>`).' },
        confirm_all_sessions: { type: 'boolean', description: 'Required (must be boolean true) when drain_id scope is "all". Confirms the destructive cross-session hard-delete.' },
      },
      required: ['drain_id'],
    },
  },
  {
    name: 'mindwright_get_roles',
    description: 'Return the role-set assigned to a session (defaults to this session). `target` accepts either a UUID session_id or a wrightward handle (e.g. "bob-42").',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'UUID session_id OR wrightward handle. Defaults to the calling session (--session-id).' },
      },
    },
  },
  {
    name: 'mindwright_assign_role',
    description: 'Additively assign a role to a target session. `target` accepts either a UUID session_id or a wrightward handle (e.g. "bob-42"); handles are resolved via `.claude/collab/agents.json`.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'UUID session_id OR wrightward handle.' },
        role: { type: 'string', description: 'Role name (e.g. "consolidator", "planner", "implementer", "reviewer", "tester").' },
      },
      required: ['target', 'role'],
    },
  },
  {
    name: 'mindwright_unassign_role',
    description: 'Remove a role from a target session\'s role-set. `target` accepts either a UUID session_id or a wrightward handle.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'UUID session_id OR wrightward handle.' },
        role: { type: 'string' },
      },
      required: ['target', 'role'],
    },
  },
  {
    name: 'mindwright_update_memory',
    description:
      'Supersede a single fact in place with corrected content. Writes a new long-term row, links the old via `supersedes`, marks the old inactive. Use when an agent just discovered a specific memory is wrong. Returns `{ new_id, old_content_preview }` so callers can echo what was replaced and catch typo\'d ids before they drift unnoticed.',
    inputSchema: {
      type: 'object',
      properties: {
        fact_id: { type: 'number', description: 'The old (wrong) fact\'s id.' },
        new_content: { type: 'string', description: 'Corrected text.' },
      },
      required: ['fact_id', 'new_content'],
    },
  },
  {
    name: 'mindwright_forget',
    description:
      'Soft-archive a long-term fact so it stops surfacing in retrieval and mirrors. Reversible via `mindwright_restore` (or by flipping `active=1` in SQL); the auto path treats the fact as gone. Returns `{ ok, fact_id, content_preview }` so callers can echo what was just forgotten and catch a typo\'d fact_id before the user moves on.',
    inputSchema: {
      type: 'object',
      properties: {
        fact_id: { type: 'number', description: 'The id of the long-term row to forget.' },
      },
      required: ['fact_id'],
    },
  },
  {
    name: 'mindwright_restore',
    description:
      'Restore a previously soft-archived long-term fact by flipping `active` back to 1. Inverse of `mindwright_forget` — meant to recover from a typo\'d fact_id without requiring the user to open SQLite. Returns `{ ok, fact_id, content_preview }`. No-op (still ok) when the fact is already active.',
    inputSchema: {
      type: 'object',
      properties: {
        fact_id: { type: 'number', description: 'The id of the long-term row to restore.' },
      },
      required: ['fact_id'],
    },
  },
  {
    name: 'mindwright_resolve_contradiction',
    description:
      'Resolve a clash between two existing facts. Four resolutions: prefer_a (archive b), prefer_b (archive a), merge (insert merged_content + archive both originals), scope_both (insert two new scope-qualified rows + supersede both originals).',
    inputSchema: {
      type: 'object',
      properties: {
        fact_id_a: { type: 'number' },
        fact_id_b: { type: 'number' },
        resolution: { type: 'string', enum: ['prefer_a', 'prefer_b', 'merge', 'scope_both'] },
        scope_a: { type: 'string', description: 'Required for scope_both: the condition under which fact_a applies.' },
        scope_b: { type: 'string', description: 'Required for scope_both: the condition under which fact_b applies.' },
        merged_content: { type: 'string', description: 'Required for merge: the unified replacement text.' },
      },
      required: ['fact_id_a', 'fact_id_b', 'resolution'],
    },
  },
];

export function getToolDefinitions() {
  return TOOL_DEFINITIONS;
}

// Scope validator: returns true iff scope is one of "user" | "project" |
// "role:<role-name>" where <role-name> matches ROLE_PATTERN (path-safe
// identifier). Used by every long-tier write path that takes a scope arg.
function validateScope(scope) {
  if (typeof scope !== 'string') return false;
  if (scope === 'user' || scope === 'project') return true;
  if (scope.startsWith('role:')) {
    return ROLE_PATTERN.test(scope.slice(5));
  }
  return false;
}

// SQLite rowids returned by better-sqlite3 are BigInt past 2^32. JSON.stringify
// throws on raw bigints, so every wire-bound payload runs through this
// replacer. It walks the payload recursively (JSON.stringify behavior),
// so nested BigInts in arrays or sub-objects also get coerced — callers
// should NOT pre-coerce ids by hand. Keeping a manual per-id wrapper at call
// sites would mean two valid encoding paths coexist for the same problem; if
// someone later removes this replacer the manual sites keep working but the
// auto sites break, and the failure surface is non-uniform.
function bigintReplacer(_key, value) {
  if (typeof value === 'bigint') return value.toString();
  return value;
}

// scope_both contradiction resolution appends "(applies when: <scope>)" to a
// fact's content. Without this strip, a second scope_both pass on the same
// fact would STACK the qualifier and the body would grow into nonsense:
//     "original. \n\n(applies when: A)\n\n(applies when: B)"
// We strip any pre-existing trailing `(applies when: ...)` so repeated
// scope_both calls REPLACE the qualifier instead of appending.
//
// A naive regex `\(applies when:[^)]*\)` stops at the FIRST `)` and breaks
// when the scope description itself contains parens — e.g.
//   "(applies when: running tests (CI))"
// would leave a `(CI))` fragment behind, defeating the helper. Instead we
// walk back from the trailing `)` counting paren depth, then verify the
// matching `(` opens with the literal `(applies when:` prefix. Anything
// that isn't a clean trailing scope qualifier is left untouched.
function stripScopeQualifier(text) {
  if (typeof text !== 'string') return '';
  const t = text.trimEnd();
  if (!t.endsWith(')')) return t;
  // Walk backwards counting paren depth to find the opening `(` that the
  // trailing `)` closes.
  let depth = 1;
  let i = t.length - 2;
  while (i >= 0 && depth > 0) {
    const c = t[i];
    if (c === ')') depth++;
    else if (c === '(') depth--;
    if (depth === 0) break;
    i--;
  }
  if (i < 0) return t; // unbalanced; leave content alone
  const PREFIX = '(applies when:';
  if (t.slice(i, i + PREFIX.length).toLowerCase() !== PREFIX) return t;
  return t.slice(0, i).trimEnd();
}

function okResponse(payload) {
  return { content: [{ type: 'text', text: JSON.stringify(payload, bigintReplacer) }] };
}

function errResponse(message, extra = {}) {
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: message, ...extra }) }],
    isError: true,
  };
}

// Tools that need a bound session id to write under (either as author of
// an insert or as the implicit scope of a session-bound query). When
// ctx.sessionId hasn't resolved yet (brief window between MCP handshake
// and bindOwnSession completion) these would otherwise hit a SQLITE
// NOT NULL constraint deep inside insertEntry; we surface a clear error
// instead. Read-only diagnostic tools (status, recall, get_roles) and
// arg-driven write tools (assign_role / unassign_role) are exempt.
const TOOLS_REQUIRING_SESSION = new Set([
  'mindwright_retain',
  'mindwright_retain_fact',
  'mindwright_update_memory',
  'mindwright_resolve_contradiction',
  'mindwright_drain_batch',
]);

export async function handleToolCall(name, args, ctx) {
  if (!ctx || !ctx.store) {
    return errResponse('mindwright: store not initialized');
  }
  if (TOOLS_REQUIRING_SESSION.has(name) && !ctx.sessionId) {
    return errResponse(
      'mindwright: this command needs a session id; re-run with --session-id (skills pass ${CLAUDE_SESSION_ID} automatically)'
    );
  }
  const handler = HANDLERS[name];
  if (!handler) return errResponse(`unknown tool: ${name}`);
  // Reset the long-tier mutation flag. Handlers that change long-tier state
  // (insertEntry under long, markSuperseded, softArchive, restore) set
  // `ctx.mutatedLong = true` at their final-mutation point; the dispatcher
  // renders mirrors once after the handler returns. This collapses what used
  // to be 8 scattered `renderAll(ctx.store)` calls — and the comments
  // explaining when NOT to call them — into one place.
  ctx.mutatedLong = false;
  try {
    const result = await handler(args || {}, ctx);
    if (ctx.mutatedLong && !result.isError) {
      renderAll(ctx.store);
    }
    return result;
  } catch (err) {
    // Log the full stack so operators can diagnose failures from server
    // stderr (the wire-side error envelope below intentionally stays terse —
    // it returns to the calling LLM, which doesn't benefit from stacks).
    process.stderr.write(
      `[mindwright/mcp] tool ${name} threw: ${err && err.stack ? err.stack : err}\n`
    );
    const message = err && err.message ? err.message : String(err);
    const extra = {};
    if (err && typeof err.name === 'string' && err.name !== 'Error') {
      extra.error_type = err.name;
    }
    if (err && typeof err.code === 'string') {
      extra.error_code = err.code;
    }
    return errResponse(message, extra);
  }
}

// --------------------------------------------------------------------------
// Handlers
// --------------------------------------------------------------------------

async function recallHandler(args, ctx) {
  const { query } = args;
  if (args.k !== undefined && (!Number.isInteger(args.k) || args.k <= 0)) {
    return errResponse('k must be a positive integer');
  }
  const k = typeof args.k === 'number' ? args.k : TOP_K_DEFAULT;
  const scope = args.scope || 'all';
  if (typeof query !== 'string' || !query.trim()) {
    return errResponse('query must be a non-empty string');
  }
  if (scope !== 'all' && scope !== 'short' && scope !== 'long') {
    return errResponse('scope must be "short" | "long" | "all"');
  }
  if (!embedderCached()) return errResponse(SETUP_HINT);
  // Push the tier filter into the retrieval pipeline (each retriever's SQL)
  // so a scope='long' caller can't get back zero results when 2k+ short-term
  // rows happen to dominate the unfiltered top.
  // Scope role-tagged procedural rows to the caller's assigned roles so
  // /mindwright:recall reflects what the hook-based retrieval surfaces.
  // Callers can pass `roles` explicitly to override (e.g. to debug what
  // another role would see); otherwise we resolve the session's set.
  let roles = null;
  if (Array.isArray(args.roles)) {
    roles = args.roles;
  } else if (ctx.sessionId) {
    try { roles = ctx.store.getRoles(ctx.sessionId); } catch { roles = []; }
  }
  // Build excludeIds: caller-provided ids (for the self-recall path) plus
  // the per-session injected-ids dedup set. We extend the set after
  // emission so subsequent recall calls in the same session don't re-inject
  // the same fact. The agent has no way to read its own injected set, so
  // the handler does the read+append transparently.
  //
  // bypass_session_dedup=true is the /mindwright:recall debug path —
  // the user wants to see what would match, not a delta against prior
  // injections. Skip both the read and the post-emit append in that case
  // so a second debug call shows the same hits as the first.
  const bypassDedup = args.bypass_session_dedup === true;
  const callerExclude = Array.isArray(args.exclude_ids)
    ? args.exclude_ids.map((n) => Number(n)).filter(Number.isFinite)
    : [];
  let sessionInjected = [];
  if (ctx.sessionId && !bypassDedup) {
    try { sessionInjected = ctx.store.getInjectedFactIds(ctx.sessionId); } catch { sessionInjected = []; }
  }
  const excludeIds = [...callerExclude, ...sessionInjected];
  const hits = await retrieve({
    store: ctx.store,
    queryText: query,
    embed: ctx.embed,
    rerank: ctx.rerank,
    tier: scope === 'all' ? null : scope,
    roles,
    excludeIds,
    options: { k },
  });
  // Extend the dedup set with the emitted ids. Best-effort; a failure to
  // append is logged via the throw → handleToolCall path and the caller
  // still gets a useful response.
  if (ctx.sessionId && !bypassDedup && Array.isArray(hits) && hits.length > 0) {
    const emittedIds = hits.map((h) => Number(h.id)).filter(Number.isFinite);
    if (emittedIds.length > 0) {
      try {
        ctx.store.appendInjectedFactIds(ctx.sessionId, emittedIds, INJECTED_FACT_IDS_CAP);
      } catch {
        /* best-effort */
      }
    }
  }
  return okResponse({ results: hits });
}

// Validate raw retain args. Returns either {ok:false, err:errResponse}
// or {ok:true, content, kind, tier, category, scope, confidence}. Keeps
// retainHandler focused on orchestration instead of input-shape minutiae.
function validateRetainArgs(args) {
  const { content, kind, tier } = args;
  const category = args.category ?? null;
  const scope = args.scope ?? null;
  const confidence = args.confidence ?? null;
  if (typeof content !== 'string' || !content.trim()) {
    return { ok: false, err: errResponse('content must be a non-empty string') };
  }
  if (typeof kind !== 'string' || !kind.trim()) {
    return { ok: false, err: errResponse('kind must be a non-empty string') };
  }
  if (!KIND_PATTERN.test(kind)) {
    return { ok: false, err: errResponse('kind must match /^[a-zA-Z0-9_-]{1,32}$/ (no brackets, newlines, or angle brackets)') };
  }
  if (tier !== 'short' && tier !== 'long') {
    return { ok: false, err: errResponse('tier must be "short" or "long"') };
  }
  if (confidence != null && (!Number.isFinite(confidence) || confidence < 0 || confidence > 1)) {
    return { ok: false, err: errResponse('confidence must be a finite number in [0, 1]') };
  }
  return { ok: true, content, kind, tier, category, scope, confidence };
}

// Long-term rows must have a category AND scope; when the caller omitted
// either, fall back to the deterministic heuristic. Track the silent
// default-to-fact/project case — terse phrasings ("dark theme yes") can be
// user preferences that look like nothing to the cues and end up filed as
// project facts. Returns the resolved tags plus a warning string when the
// heuristic returned NULL so the caller can re-tag via update-memory.
function resolveLongTermTags({ content, category, scope }) {
  let warning = null;
  if (!category || !scope) {
    const heuristic = categorize(content);
    const guess = heuristic || { category: 'fact', scope: 'project' };
    if (!category) category = guess.category;
    if (!scope) scope = guess.scope;
    if (!heuristic) {
      warning =
        `no scope/category cue matched the content — defaulted to ${guess.category}/${guess.scope}. ` +
        `If this was a user preference (e.g. terse "I prefer X" / theme / editor setting) ` +
        `or a role-specific procedural note, re-tag the row via /mindwright:update-memory.`;
    }
  }
  return { category, scope, warning };
}

async function retainHandler(args, ctx) {
  const v = validateRetainArgs(args);
  if (!v.ok) return v.err;
  const { content, kind, tier, confidence } = v;
  let { category, scope } = v;

  // Long-term retain needs the embedder for supersede-candidate detection
  // to mean anything — without it the user silently ends up with two
  // contradictory active facts and no warning. Short-term retain can still
  // succeed with NULL embedding (sweeper backfills later); skip the embed
  // call entirely when the model isn't cached so we don't trigger a 5 GB
  // download on a simple /mindwright:retain note=... call.
  if (tier === 'long' && !embedderCached()) {
    return errResponse(SETUP_HINT);
  }

  let categorizationWarning = null;
  if (tier === 'long') {
    ({ category, scope, warning: categorizationWarning } =
      resolveLongTermTags({ content, category, scope }));
    if (!LONG_CATEGORIES.includes(category)) {
      return errResponse('category must be procedural | episodic | fact for tier=long');
    }
    if (typeof scope !== 'string' || !validateScope(scope)) {
      return errResponse('scope must be "user" | "project" | "role:<role>" for tier=long');
    }
  } else {
    // Short-tier: scope must be null (DB CHECK enforces) and category
    // in (NULL, 'raw'). Coerce a wrong-tier value rather than rejecting —
    // the caller's "tier=short" is the authoritative signal.
    scope = null;
    if (category && category !== 'raw') category = 'raw';
  }

  let emb = null;
  if (embedderCached()) {
    try {
      const out = await ctx.embed([content]);
      emb = out && out[0] ? out[0] : null;
    } catch {
      // degrade silently — sweeper backfills NULL-embedded rows later
      emb = null;
    }
  }
  const id = ctx.store.insertEntry({
    tier, category, scope, kind, content,
    sessionId: ctx.sessionId, confidence, embedding: emb,
  });
  ctx.mutatedLong = true;

  // Supersede-candidate detection. Mirrors the dream-cycle path
  // (lib/consolidator.js retainFact) so the explicit /mindwright:retain user
  // still gets a "two contradictory facts active" warning. Helper swallows
  // its own failures here — retrieval errors shouldn't break the retain.
  let supersede_candidates = [];
  if (tier === 'long' && emb) {
    try {
      supersede_candidates = await findSupersedeCandidates({
        store: ctx.store, embed: ctx.embed, rerank: ctx.rerank,
        content, insertedId: id,
      });
    } catch {
      supersede_candidates = [];
    }
  }

  const response = { id, supersede_candidates };
  if (categorizationWarning) response.warning = categorizationWarning;
  return okResponse(response);
}

function statusHandler(_args, ctx) {
  const byTier = ctx.store.countByTier();
  const byCategoryRows = ctx.store.countByCategory();
  const by_category = Object.fromEntries(byCategoryRows.map((r) => [r.category, r.n]));
  const byCategoryScopeRows = ctx.store.countByCategoryScope();
  const by_category_scope = Object.fromEntries(
    byCategoryScopeRows.map((r) => [`${r.category}/${r.scope}`, r.n])
  );
  const last = ctx.store.lastConsolidation();
  const model_cached = embedderCached();
  const daemon_alive = isDaemonAlive();
  const pending_embeds = ctx.store.countPendingEmbeds();
  const poison_embeds = ctx.store.countPoisonEmbeds();

  // Surface rows that landed under the synthetic 'mindwright-unbound'
  // session_id — happens when the CLI is invoked without --session-id (e.g.
  // run outside a Claude session). These rows are otherwise invisible to session-scoped operations
  // (countShortTermFor(realSessionId)=0, Stop's cap check never fires,
  // /mindwright:dream with default scope=session finds nothing).
  const unbound_count = ctx.store.countUnboundActive();
  const warnings = [];
  if (unbound_count > 0) {
    warnings.push(
      `${pluralize(unbound_count, 'row')} ${agree(unbound_count, 'is', 'are')} stored under session_id='${UNBOUND_SESSION_ID}' ` +
      `(written without a session id). Run /mindwright:dream with scope='all' to consolidate them.`,
    );
  }
  if (poison_embeds > 0) {
    warnings.push(
      `${pluralize(poison_embeds, 'row')} ${agree(poison_embeds, 'has', 'have')} exceeded the embed retry threshold and ` +
      `will not be back-filled. Inspect with: SELECT id, kind, length(content), embed_failures FROM entries ` +
      `WHERE embed_failures >= 5;`,
    );
  }
  // The sweeper only runs inside the MCP daemon (mcp/server.mjs spawns it
  // on boot). When the daemon is down, pending_embeds stays stuck until the
  // next session opens with mindwright bound. Without this warning the user
  // sees the pending count but no hint at the dependency.
  if (!daemon_alive && pending_embeds > 0) {
    warnings.push(
      `${pluralize(pending_embeds, 'embedding')} ${agree(pending_embeds, 'is', 'are')} pending but no mindwright daemon is running — ` +
      `they will be back-filled the next time a Claude Code session opens with mindwright bound in this project.`,
    );
  }

  // Surface the oldest active user-scoped fact's age so users know whether
  // they may want to audit and prune. Per DESIGN.md, time-based confidence
  // decay / auto-archive of stale preferences is a future feature ("opinion
  // network"); current behavior only supports manual /mindwright:forget or
  // supersede via the consolidator. Without this hint, a 6-month-old
  // preference looks identical to a 2-day-old one in retrieval, and the
  // user has no signal that something stale is still injecting.
  const oldest_preference_at = ctx.store.oldestUserPreference();
  if (oldest_preference_at) {
    const ageMs = Date.now() - Date.parse(oldest_preference_at);
    const ageDays = Math.floor(ageMs / MS_PER_DAY);
    if (ageDays >= STALE_PREFERENCE_WARN_DAYS) {
      warnings.push(
        `oldest active user-scoped fact is ~${ageDays} days old — preferences don't auto-decay; ` +
        `consider /mindwright:recall on a relevant query and /mindwright:forget any that no longer apply.`,
      );
    }
  }

  // Consolidator-spawn record for the calling session: surfaces who runs
  // consolidations on its behalf. Handle is recomputed from the persisted
  // UUID via deriveHandle so no separate handle field needs to be stored.
  // null when no consolidator has been spawned for this requester yet.
  let consolidator = null;
  if (ctx.sessionId) {
    try {
      const callerHandle = deriveHandle(ctx.sessionId);
      const record = ctx.store.getConsolidatorFor(callerHandle);
      if (record && record.session_id) {
        consolidator = {
          session_id: record.session_id,
          handle: deriveHandle(record.session_id),
          first_seen: record.first_seen || null,
          last_spawn: record.last_spawn || null,
        };
      }
    } catch {
      consolidator = null;
    }
  }

  return okResponse({
    short_count: byTier.short,
    long_count: byTier.long,
    by_category,
    by_category_scope,
    last_consolidation: last ? last.fired_at : null,
    model_cached,
    daemon_alive,
    pending_embeds,
    poison_embeds,
    unbound_count,
    oldest_preference_at,
    consolidator,
    warnings,
  });
}

function drainBatchHandler(args, ctx) {
  const requested = args.scope || 'session';
  const scopeSessionId =
    requested === 'session' ? ctx.sessionId : null;
  const result = drainBatch({ store: ctx.store, sessionId: scopeSessionId });
  // Surface a cross-session hint whenever real work waits elsewhere — even if
  // the current session's drain came back non-empty. A solo user manually
  // running /mindwright:dream typically has a tiny current-session pile and
  // a much larger pile across past sessions; suppressing the hint when the
  // current drain has any content would let the user "succeed" consolidating
  // 1 row while 49 rows sit in past sessions and they'd never know.
  //
  // Three signals, any of which fires the hint:
  //   (a) consolidator role — the session was assigned to drain on behalf of
  //       the team. README.md and DESIGN.md promise this role makes a peer
  //       "drain on cue", so a silent no-op here would break the contract.
  //   (b) other-session bound rows exist (the solo-user case above).
  //   (c) rows under the synthetic 'mindwright-unbound' session — a CLI
  //       invocation without --session-id parked rows there.
  if (requested === 'session') {
    const reasons = [];

    // (a)+(b): rows under other bound sessions. Consolidator gets a
    // role-specific phrasing; everyone else gets the generic one. Only one
    // of the two is emitted to avoid double-counting.
    let teamCount = 0;
    let isConsolidator = false;
    if (ctx.sessionId) {
      let assignedRoles = [];
      try { assignedRoles = ctx.store.getRoles(ctx.sessionId); } catch { /* none */ }
      isConsolidator = Array.isArray(assignedRoles) && assignedRoles.includes('consolidator');
      teamCount = ctx.store.countShortTermInOtherSessions(ctx.sessionId);
    }
    if (isConsolidator && teamCount > 0) {
      reasons.push(
        `This session has the 'consolidator' role and ${pluralize(teamCount, 'short-term row')} ` +
        `${agree(teamCount, 'exists', 'exist')} under other sessions waiting to be consolidated.`,
      );
    } else if (teamCount > 0) {
      reasons.push(
        `${pluralize(teamCount, 'short-term row')} ` +
        `${agree(teamCount, 'exists', 'exist')} under past sessions in this project ` +
        `(not consolidated by their own sessions).`,
      );
    }

    // (c) unbound rows
    const unbound = ctx.store.countUnboundShortTerm();
    if (unbound > 0) {
      reasons.push(
        `${pluralize(unbound, 'short-term row')} ` +
        `${agree(unbound, 'exists', 'exist')} under session_id='${UNBOUND_SESSION_ID}' ` +
        `(written without a session id).`,
      );
    }

    if (reasons.length) {
      const drainedCount = Array.isArray(result.exchanges) ? result.exchanges.length : 0;
      const prefix = drainedCount === 0
        ? 'Session-scoped drain found nothing'
        : `Session-scoped drain returned ${pluralize(drainedCount, 'exchange')} in the current session`;
      result.hint =
        `${prefix}, but: ${reasons.join(' ')} ` +
        `Re-run with scope='all' (and confirm_all_sessions=true on finalize_drain) to include them.`;
    }
  }
  return okResponse(result);
}

async function retainFactHandler(args, ctx) {
  const { drain_id = null, exchange_id = null, content, category, scope = null } = args;
  const entities = Array.isArray(args.entities) ? args.entities : null;
  const confidence = args.confidence ?? null;
  // Opaque pass-through of the exchange's representative event_ts (the dream
  // skill forwards drain_batch's exchange.event_ts verbatim). Only stamp a
  // real non-empty string; anything else → NULL (behaves as today via
  // COALESCE in retrieval).
  const eventTs =
    typeof args.event_ts === 'string' && args.event_ts.length > 0 ? args.event_ts : null;
  if (typeof content !== 'string' || !content.trim()) {
    return errResponse('content must be a non-empty string');
  }
  if (!LONG_CATEGORIES.includes(category)) {
    return errResponse('category must be procedural | episodic | fact');
  }
  if (typeof scope !== 'string' || !validateScope(scope)) {
    return errResponse('scope must be "user" | "project" | "role:<role>"');
  }
  if (confidence != null && (!Number.isFinite(confidence) || confidence < 0 || confidence > 1)) {
    return errResponse('confidence must be a finite number in [0, 1]');
  }
  if (!embedderCached()) return errResponse(SETUP_HINT);
  const result = await retainFact({
    store: ctx.store,
    sessionId: ctx.sessionId,
    drainId: drain_id,
    exchangeId: exchange_id,
    content,
    category,
    scope,
    entities,
    confidence,
    eventTs,
    embed: ctx.embed,
    rerank: ctx.rerank,
  });
  // Inside a drain (`drain_id` set) skip the per-fact mirror render —
  // finalizeDrain re-renders once at the end. With 30+ retain_fact calls per
  // drain and 4 queries + 4 file writes per render this was the dominant
  // I/O cost of a dream cycle. The dispatcher reads `ctx.mutatedLong` after
  // this handler returns and renders mirrors then.
  if (!drain_id) {
    ctx.mutatedLong = true;
  }
  return okResponse({
    fact_id: result.fact_id,
    supersede_candidates: result.supersede_candidates,
  });
}

function markSupersededHandler(args, ctx) {
  const { old_id, new_id } = args;
  if (typeof old_id !== 'number' || typeof new_id !== 'number') {
    return errResponse('old_id and new_id must be numbers');
  }
  markSuperseded(ctx.store, old_id, new_id);
  // No per-call renderAll: this tool is only used inside the /mindwright:dream
  // cycle (see skills/dream/SKILL.md step 5), and `mindwright_finalize_drain`
  // renders mirrors once after the whole batch. User-facing supersede paths
  // (update_memory, resolve_contradiction) call store.markSuperseded directly
  // and render themselves.
  return okResponse({ ok: true });
}

function finalizeDrainHandler(args, ctx) {
  const { drain_id } = args;
  if (typeof drain_id !== 'string') {
    return errResponse('drain_id must be a string');
  }
  const parts = drain_id.split('|');
  if (parts.length !== 3) {
    return errResponse('drain_id must look like "<scope>|<cutoff_ts>|<cutoff_id>"');
  }
  const [scope, drainCutoff, idStr] = parts;
  if (!scope) {
    return errResponse('drain_id scope segment is empty');
  }
  if (!drainCutoff || Number.isNaN(Date.parse(drainCutoff))) {
    // Empty/garbage cutoff would let the DELETE run with no temporal filter,
    // potentially wiping every active short-term row in scope. Reject.
    return errResponse(`drain_id cutoff_ts is missing or not a parseable timestamp: ${JSON.stringify(drainCutoff)}`);
  }
  // Keep the cutoff id as BigInt end-to-end. SQLite rowids are 64-bit; coercing
  // to Number silently loses precision above 2^53. finalizeDrain() in
  // lib/consolidator.js accepts BigInt/Number/string and binds via better-sqlite3's
  // native BigInt support so the DELETE matches the right row even past 2^53.
  let drainCutoffId;
  if (!/^-?\d+$/.test(idStr)) {
    return errResponse(`drain_id cutoff id is not an integer: ${idStr}`);
  }
  try {
    drainCutoffId = BigInt(idStr);
  } catch {
    return errResponse(`drain_id cutoff id is not an integer: ${idStr}`);
  }

  // Scope authorization. The LLM has access to the drain_id we returned from
  // drainBatch, but it could ALSO forge a different scope (e.g. another
  // session's id, or "all") if a prompt-injection lands. Without an authz
  // check, a malicious injected memory could trigger finalize_drain on rows
  // belonging to other sessions or to the entire project. OWASP API1:2023 /
  // CWE-639 BOLA. Defenses:
  //   - scope must equal ctx.sessionId, OR
  //   - scope === 'all' AND the caller passes confirm_all_sessions:true
  //     (so a stray scope='all' from prompt injection still fails).
  // The orphan-consolidation hint surfaced by status (rows under the synthetic
  // 'mindwright-unbound' session id) takes the scope='all' path, not a
  // dedicated unbound-only branch — there is no special-case here.
  if (scope !== 'all' && scope !== ctx.sessionId) {
    return errResponse(
      `drain_id scope='${scope}' does not match the caller's session ('${ctx.sessionId}'). ` +
      `Cross-session finalize is not allowed.`,
    );
  }
  if (scope === 'all' && args.confirm_all_sessions !== true) {
    return errResponse(
      `drain_id scope='all' requires confirm_all_sessions:true in the arguments. ` +
      `This is a destructive cross-session operation; the explicit confirmation guards ` +
      `against accidental project-wide hard-delete via prompt injection.`,
    );
  }
  const sessionId = scope === 'all' ? null : scope;
  const result = finalizeDrain({
    store: ctx.store,
    drainId: drain_id,
    drainCutoff,
    drainCutoffId,
    sessionId,
  });
  return okResponse(result);
}

// Session id arrives over the wire from the calling Claude — validate at the
// same boundary as `role`. Even though the only DB use is meta-table binding
// (parameterized, so SQL injection is moot), keeping the validation uniform
// here means future code paths can't accidentally use an unvalidated sessionId
// in a filesystem context (pipePath etc. already enforce SESSION_ID_PATTERN).
function requireValidSessionId(sid) {
  if (typeof sid !== 'string' || !sid) return 'session_id required';
  if (!SESSION_ID_PATTERN.test(sid)) {
    return 'session_id must match /^[a-zA-Z0-9_-]{1,128}$/ (path-safe identifier)';
  }
  return null;
}

// Resolve a `target` argument (UUID or wrightward handle) to a session_id,
// returning a structured error response or null on success.
function resolveTargetArg(target, ctx) {
  if (target === undefined) {
    if (!ctx.sessionId) {
      return { errResp: errResponse('target required when no session id was passed (--session-id)') };
    }
    return { sessionId: ctx.sessionId };
  }
  const result = resolveTargetToSessionId(target);
  if (!result.ok) {
    return {
      errResp: errResponse(result.error, { live_handles: result.liveHandles || [] }),
    };
  }
  return { sessionId: result.sessionId };
}

function getRolesHandler(args, ctx) {
  const resolved = resolveTargetArg(args.target, ctx);
  if (resolved.errResp) return resolved.errResp;
  const sid = resolved.sessionId;
  const sidErr = requireValidSessionId(sid);
  if (sidErr) return errResponse(sidErr);
  // Cross-session read is recon for BOLA targeting — enumerating which
  // sessions hold which roles tells an attacker which victim to graft
  // against. Same authz boundary as assign/unassign.
  if (args.target !== undefined) {
    const authzErr = authzCrossSession(sid, args, ctx, 'read');
    if (authzErr) return errResponse(authzErr);
  }
  return okResponse({ roles: ctx.store.getRoles(sid) });
}

// Authorize a cross-session role operation against the caller's session.
// Mirrors the finalizeDrainHandler defense: the LLM could carry a forged
// session_id from a prompt injection. For writes (assign/unassign), this
// blocks BOLA grafts (OWASP API1:2023 / CWE-639); for reads (get_roles),
// it blocks the information-disclosure recon step that pairs with BOLA
// (CWE-200 / OWASP API3:2023). Same-session ops are implicit; cross-
// session ops require an explicit confirm_cross_session:true.
function authzCrossSession(session_id, args, ctx, opLabel) {
  if (session_id === ctx.sessionId) return null;
  if (args.confirm_cross_session !== true) {
    return (
      `session_id='${session_id}' does not match the caller's session ` +
      `('${ctx.sessionId}'). Cross-session role ${opLabel} requires ` +
      `confirm_cross_session:true in the arguments.`
    );
  }
  return null;
}

function assignRoleHandler(args, ctx) {
  const { role } = args;
  const resolved = resolveTargetArg(args.target, ctx);
  if (resolved.errResp) return resolved.errResp;
  const sid = resolved.sessionId;
  const sidErr = requireValidSessionId(sid);
  if (sidErr) return errResponse(sidErr);
  if (typeof role !== 'string' || !role) return errResponse('role required');
  if (!ROLE_PATTERN.test(role)) {
    return errResponse('role must match /^[a-zA-Z0-9_-]{1,64}$/ (path-safe identifier)');
  }
  const authzErr = authzCrossSession(sid, args, ctx, 'mutation');
  if (authzErr) return errResponse(authzErr);
  const current = ctx.store.getRoles(sid);
  const next = [...new Set([...current, role])];
  ctx.store.setRoles(sid, next);

  // Auto-spawn-on-role-assignment branch (Phase 4, requirement 6 in plan).
  // When a leader assigns the 'consolidator' role to a peer (the role
  // applies to a session OTHER than the caller's), spawn the consolidator
  // subprocess so it can drain and distill autonomously. Same-session
  // self-assignment does NOT trigger a spawn — that path is for an agent
  // identifying its own role, not requesting work.
  let spawn_result = null;
  if (role === 'consolidator' && sid !== ctx.sessionId && ctx.sessionId) {
    try {
      const requesterHandle = deriveHandle(ctx.sessionId);
      const r = spawnConsolidator({
        requesterHandle,
        reason: 'role_assigned',
        store: ctx.store,
      });
      spawn_result = r;
    } catch (err) {
      spawn_result = { ok: false, error: (err && err.message) || String(err) };
    }
  }

  return okResponse({ roles: next, spawn_result });
}

function unassignRoleHandler(args, ctx) {
  const { role } = args;
  const resolved = resolveTargetArg(args.target, ctx);
  if (resolved.errResp) return resolved.errResp;
  const sid = resolved.sessionId;
  const sidErr = requireValidSessionId(sid);
  if (sidErr) return errResponse(sidErr);
  if (typeof role !== 'string' || !role) return errResponse('role required');
  if (!ROLE_PATTERN.test(role)) {
    return errResponse('role must match /^[a-zA-Z0-9_-]{1,64}$/ (path-safe identifier)');
  }
  const authzErr = authzCrossSession(sid, args, ctx, 'mutation');
  if (authzErr) return errResponse(authzErr);
  const current = ctx.store.getRoles(sid);
  const next = current.filter((r) => r !== role);
  ctx.store.setRoles(sid, next);
  return okResponse({ roles: next });
}

async function updateMemoryHandler(args, ctx) {
  const { fact_id, new_content } = args;
  if (typeof fact_id !== 'number') return errResponse('fact_id must be a number');
  if (typeof new_content !== 'string' || !new_content.trim()) {
    return errResponse('new_content must be a non-empty string');
  }
  const old = ctx.store.fetch(fact_id);
  if (!old) return errResponse(`fact_id ${fact_id} not found`);
  if (old.tier !== 'long') return errResponse('mindwright_update_memory only supersedes long-term facts');

  let emb = null;
  try {
    const out = await ctx.embed([new_content]);
    emb = out && out[0] ? out[0] : null;
  } catch {
    emb = null;
  }
  const newId = ctx.store.insertEntry({
    tier: 'long',
    category: old.category,
    scope: old.scope,
    kind: old.kind || KIND_FACT,
    content: new_content,
    sessionId: ctx.sessionId,
    confidence: old.confidence,
    embedding: emb,
  });
  ctx.store.markSuperseded(fact_id, newId);
  ctx.mutatedLong = true;
  // Echo the old content so the user can verify they updated the right row.
  // The new content is what they just typed — no echo needed for that side.
  const oldContentPreview = (old.content || '').slice(0, PREVIEW_MAX_CHARS);
  return okResponse({
    new_id: newId,
    old_content_preview: oldContentPreview,
  });
}

function forgetHandler(args, ctx) {
  const { fact_id } = args;
  if (typeof fact_id !== 'number') return errResponse('fact_id must be a number');
  const row = ctx.store.fetch(fact_id);
  if (!row) return errResponse(`fact_id ${fact_id} not found`);
  if (row.tier !== 'long') return errResponse('mindwright_forget only operates on long-term facts');
  // Snapshot the content BEFORE soft-archive so the response can echo what
  // was forgotten. A user who typo'd the id (e.g. from a stale recall result)
  // needs an immediate signal that the wrong row went down; without the
  // echo, recovery requires opening the SQLite DB to inspect a row by id.
  const contentPreview = (row.content || '').slice(0, PREVIEW_MAX_CHARS);
  ctx.store.softArchive(fact_id);
  ctx.mutatedLong = true;
  return okResponse({ ok: true, fact_id, content_preview: contentPreview });
}

function restoreHandler(args, ctx) {
  const { fact_id } = args;
  if (typeof fact_id !== 'number') return errResponse('fact_id must be a number');
  const row = ctx.store.fetch(fact_id);
  if (!row) return errResponse(`fact_id ${fact_id} not found`);
  if (row.tier !== 'long') return errResponse('mindwright_restore only operates on long-term facts');
  const contentPreview = (row.content || '').slice(0, PREVIEW_MAX_CHARS);
  ctx.store.restore(fact_id);
  ctx.mutatedLong = true;
  return okResponse({ ok: true, fact_id, content_preview: contentPreview });
}

// One side wins — record the supersede edge (loser superseded by winner) AND
// archive in one step. softArchive alone would leave the audit chain unable
// to answer "what happened to fact X?" — merge / scope_both both record the
// edge, so prefer_a/prefer_b must preserve the same invariant.
function resolvePrefer(ctx, archivedId, keptId, label) {
  ctx.store.markSuperseded(archivedId, keptId, label);
  ctx.mutatedLong = true;
  return okResponse({ resolution: label });
}

async function resolveMerge(ctx, fact_id_a, fact_id_b, a, args) {
  const { merged_content } = args;
  if (typeof merged_content !== 'string' || !merged_content.trim()) {
    return errResponse('merge resolution requires merged_content');
  }
  if (!embedderCached()) return errResponse(SETUP_HINT);
  let emb = null;
  try {
    const out = await ctx.embed([merged_content]);
    emb = out && out[0] ? out[0] : null;
  } catch {
    emb = null;
  }
  // Insert + both supersede links happen under one transaction so a mid-
  // resolution failure rolls back the merged row instead of leaving an
  // orphan with only one of the originals archived.
  const mergeTxn = ctx.store.db.transaction(() => {
    const newId = ctx.store.insertEntry({
      tier: 'long',
      category: a.category,
      scope: a.scope,
      kind: KIND_FACT,
      content: merged_content,
      sessionId: ctx.sessionId,
      confidence: a.confidence,
      embedding: emb,
    });
    ctx.store.markSuperseded(fact_id_a, newId, 'merge');
    ctx.store.markSuperseded(fact_id_b, newId, 'merge');
    return newId;
  });
  const mergedId = mergeTxn();
  ctx.mutatedLong = true;
  return okResponse({
    resolution: 'merge',
    merged_id: mergedId,
  });
}

async function resolveScopeBoth(ctx, fact_id_a, fact_id_b, a, b, args) {
  const { scope_a, scope_b } = args;
  if (typeof scope_a !== 'string' || !scope_a.trim()) {
    return errResponse('scope_both requires scope_a');
  }
  if (typeof scope_b !== 'string' || !scope_b.trim()) {
    return errResponse('scope_both requires scope_b');
  }
  // Insert two new scoped facts; archive the originals so retrieval surfaces
  // the scoped versions only. Supersede chain records the connection.
  const scopedA = `${stripScopeQualifier(a.content)}\n\n(applies when: ${scope_a})`;
  const scopedB = `${stripScopeQualifier(b.content)}\n\n(applies when: ${scope_b})`;
  let embA = null;
  let embB = null;
  try {
    const out = await ctx.embed([scopedA, scopedB]);
    embA = out[0] || null;
    embB = out[1] || null;
  } catch {
    // best-effort embed; sweeper backfills NULL embeddings
  }
  // Two inserts + two supersede links happen under one transaction so a
  // partial failure can't leave (e.g.) scoped-A inserted and A archived
  // while B is still in its un-scoped state.
  const scopeTxn = ctx.store.db.transaction(() => {
    const insertedA = ctx.store.insertEntry({
      tier: 'long',
      category: a.category,
      scope: a.scope,
      kind: KIND_FACT,
      content: scopedA,
      sessionId: ctx.sessionId,
      confidence: a.confidence,
      embedding: embA,
    });
    const insertedB = ctx.store.insertEntry({
      tier: 'long',
      category: b.category,
      scope: b.scope,
      kind: KIND_FACT,
      content: scopedB,
      sessionId: ctx.sessionId,
      confidence: b.confidence,
      embedding: embB,
    });
    ctx.store.markSuperseded(fact_id_a, insertedA);
    ctx.store.markSuperseded(fact_id_b, insertedB);
    return { newA: insertedA, newB: insertedB };
  });
  const { newA, newB } = scopeTxn();
  ctx.mutatedLong = true;
  return okResponse({
    resolution: 'scope_both',
    new_id_a: newA,
    new_id_b: newB,
  });
}

async function resolveContradictionHandler(args, ctx) {
  const { fact_id_a, fact_id_b, resolution } = args;
  if (typeof fact_id_a !== 'number' || typeof fact_id_b !== 'number') {
    return errResponse('fact_id_a and fact_id_b must be numbers');
  }
  // Reject the same-id case before reaching any resolution branch. With
  // duplicate ids, scope_both inserts two near-identical scoped rows and
  // double-stamps the supersedes pointer on the (single) archived original;
  // prefer_a/prefer_b would self-supersede the kept row (blocked by the
  // entries.supersedes CHECK with a non-obvious error); merge is benign but
  // still records a confusing audit trail. All paths are caller-error
  // scenarios — surface a clear message instead.
  if (fact_id_a === fact_id_b) {
    return errResponse('fact_id_a and fact_id_b must be different ids');
  }
  const a = ctx.store.fetch(fact_id_a);
  const b = ctx.store.fetch(fact_id_b);
  if (!a) return errResponse(`fact_id_a ${fact_id_a} not found`);
  if (!b) return errResponse(`fact_id_b ${fact_id_b} not found`);

  switch (resolution) {
    case 'prefer_a':
      return resolvePrefer(ctx, fact_id_b, fact_id_a, 'prefer_a');
    case 'prefer_b':
      return resolvePrefer(ctx, fact_id_a, fact_id_b, 'prefer_b');
    case 'merge':
      return resolveMerge(ctx, fact_id_a, fact_id_b, a, args);
    case 'scope_both':
      return resolveScopeBoth(ctx, fact_id_a, fact_id_b, a, b, args);
    default:
      return errResponse('resolution must be prefer_a | prefer_b | merge | scope_both');
  }
}

const HANDLERS = {
  mindwright_recall: recallHandler,
  mindwright_retain: retainHandler,
  mindwright_status: statusHandler,
  mindwright_drain_batch: drainBatchHandler,
  mindwright_retain_fact: retainFactHandler,
  mindwright_mark_superseded: markSupersededHandler,
  mindwright_finalize_drain: finalizeDrainHandler,
  mindwright_get_roles: getRolesHandler,
  mindwright_assign_role: assignRoleHandler,
  mindwright_unassign_role: unassignRoleHandler,
  mindwright_update_memory: updateMemoryHandler,
  mindwright_forget: forgetHandler,
  mindwright_restore: restoreHandler,
  mindwright_resolve_contradiction: resolveContradictionHandler,
};

// Internal helpers exposed for tests only. Not part of the public MCP API.
// Mirrors the lib/chunker.js __internal pattern — keeps the module's public
// surface to its tools and capability map while still letting white-box
// tests pin the parsing/formatting helpers directly.
export const __internal = {
  stripScopeQualifier,
  validateScope,
  bigintReplacer,
  requireValidSessionId,
  authzCrossSession,
  okResponse,
  errResponse,
};
