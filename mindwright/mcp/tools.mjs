// Tool definitions + dispatcher, invoked by scripts/mindwright.mjs.
// `ctx` = { store, sessionId, embed, rerank }.

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

const PREVIEW_MAX_CHARS = 200;

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

// True iff scope is "user" | "project" | "role:<role>" (role matching ROLE_PATTERN).
function validateScope(scope) {
  if (typeof scope !== 'string') return false;
  if (scope === 'user' || scope === 'project') return true;
  if (scope.startsWith('role:')) {
    return ROLE_PATTERN.test(scope.slice(5));
  }
  return false;
}

// JSON.stringify throws on the BigInt rowids better-sqlite3 returns past 2^32,
// so every wire-bound payload runs through this replacer (single coercion path
// — callers must NOT pre-coerce ids by hand).
function bigintReplacer(_key, value) {
  if (typeof value === 'bigint') return value.toString();
  return value;
}

// Strip a trailing `(applies when: ...)` so repeated scope_both resolutions
// REPLACE the qualifier instead of stacking it. Paren-depth walk, not a naive
// `[^)]*` regex, because the scope text itself may contain parens (e.g. "(CI)").
function stripScopeQualifier(text) {
  if (typeof text !== 'string') return '';
  const t = text.trimEnd();
  if (!t.endsWith(')')) return t;
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

// Tools that need a bound session id to write under; without it they would hit
// a NOT NULL constraint deep in insertEntry. Read-only diagnostics and
// arg-driven role writes are exempt.
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
  // Handlers set ctx.mutatedLong=true at their final long-tier mutation; the
  // dispatcher renders mirrors once afterward.
  ctx.mutatedLong = false;
  try {
    const result = await handler(args || {}, ctx);
    if (ctx.mutatedLong && !result.isError) {
      renderAll(ctx.store);
    }
    return result;
  } catch (err) {
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
  // Default role scoping mirrors what hook-based retrieval surfaces; explicit
  // `roles` overrides.
  let roles = null;
  if (Array.isArray(args.roles)) {
    roles = args.roles;
  } else if (ctx.sessionId) {
    try { roles = ctx.store.getRoles(ctx.sessionId); } catch { roles = []; }
  }
  // excludeIds = caller ids + per-session injected-ids dedup set, extended
  // post-emit so later recalls don't re-inject the same fact.
  // bypass_session_dedup skips both read and append (repeatable debug recall).
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

// Long-term rows need category AND scope; fall back to the heuristic for
// whichever is missing. Warns when no cue matched, since the silent
// default-to-fact/project can mis-file a terse preference.
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

  // Long-term retain needs the embedder for supersede-candidate detection;
  // without it the user silently keeps two contradictory active facts.
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
    // Short-tier DB CHECK requires scope NULL and category in (NULL,'raw');
    // coerce rather than reject (caller's tier=short is authoritative).
    scope = null;
    if (category && category !== 'raw') category = 'raw';
  }

  let emb = null;
  if (embedderCached()) {
    try {
      const out = await ctx.embed([content]);
      emb = out && out[0] ? out[0] : null;
    } catch {
      emb = null; // sweeper backfills NULL-embedded rows later
    }
  }
  const id = ctx.store.insertEntry({
    tier, category, scope, kind, content,
    sessionId: ctx.sessionId, confidence, embedding: emb,
  });
  ctx.mutatedLong = true;

  // Mirror the dream-cycle supersede detection so explicit retain also warns
  // about contradictions. Swallow errors — a retrieval failure must not break
  // the retain.
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

  // Rows under the synthetic 'mindwright-unbound' session_id (CLI invoked
  // without --session-id) are invisible to every session-scoped operation, so
  // surface them explicitly.
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
  // When the model daemon is down, pending_embeds stays stuck until the next
  // session opens with mindwright bound; warn so the count isn't a mystery.
  if (!daemon_alive && pending_embeds > 0) {
    warnings.push(
      `${pluralize(pending_embeds, 'embedding')} ${agree(pending_embeds, 'is', 'are')} pending but no mindwright daemon is running — ` +
      `they will be back-filled the next time a Claude Code session opens with mindwright bound in this project.`,
    );
  }

  // Preferences don't auto-decay — a 6-month-old one looks identical to a
  // 2-day-old one in retrieval — so surface the oldest's age as a prune hint.
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

  // Handle is recomputed from the persisted UUID via deriveHandle so no
  // separate handle field is stored.
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
  // Surface a cross-session hint whenever real work waits elsewhere even if
  // this session's drain was non-empty: suppressing it would let a user
  // "succeed" on 1 row while 49 sit unconsolidated in past sessions.
  if (requested === 'session') {
    const reasons = [];

    // Rows under other bound sessions. Consolidator gets role-specific
    // phrasing; everyone else the generic one. Only one is emitted (no
    // double-count).
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
  // Opaque pass-through of the exchange's event_ts; non-string/empty → NULL
  // (treated via COALESCE in retrieval).
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
  // Inside a drain, skip the per-fact mirror render (30+ calls × 4 writes was
  // the dominant dream-cycle I/O cost) — finalizeDrain re-renders once at the
  // end.
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
  // No per-call renderAll: dream-cycle-only, and finalize_drain renders once
  // after the whole batch.
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
    // wiping every active short-term row in scope.
    return errResponse(`drain_id cutoff_ts is missing or not a parseable timestamp: ${JSON.stringify(drainCutoff)}`);
  }
  // Keep the cutoff id as BigInt end-to-end — coercing 64-bit rowids to Number
  // silently loses precision above 2^53.
  let drainCutoffId;
  if (!/^-?\d+$/.test(idStr)) {
    return errResponse(`drain_id cutoff id is not an integer: ${idStr}`);
  }
  try {
    drainCutoffId = BigInt(idStr);
  } catch {
    return errResponse(`drain_id cutoff id is not an integer: ${idStr}`);
  }

  // Scope authorization (BOLA, OWASP API1:2023 / CWE-639): a prompt-injected
  // memory could forge another session's id or "all". scope must equal
  // ctx.sessionId, OR be 'all' with confirm_all_sessions:true. The unbound
  // orphan-consolidation hint takes the scope='all' path — no special-case.
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

// Validate the session id at the wire boundary (uniform with `role`) so a
// future code path can't use an unvalidated sessionId in a filesystem context.
function requireValidSessionId(sid) {
  if (typeof sid !== 'string' || !sid) return 'session_id required';
  if (!SESSION_ID_PATTERN.test(sid)) {
    return 'session_id must match /^[a-zA-Z0-9_-]{1,128}$/ (path-safe identifier)';
  }
  return null;
}

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
  // Cross-session read is BOLA recon (which session to graft against) — same
  // authz boundary as assign/unassign.
  if (args.target !== undefined) {
    const authzErr = authzCrossSession(sid, args, ctx, 'read');
    if (authzErr) return errResponse(authzErr);
  }
  return okResponse({ roles: ctx.store.getRoles(sid) });
}

// Block cross-session role ops driven by a prompt-injected forged session_id
// (BOLA, OWASP API1:2023/CWE-639; for reads, CWE-200 recon). Cross-session
// requires explicit confirm_cross_session:true.
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

  // Assigning 'consolidator' to a peer (a session OTHER than the caller's)
  // spawns the consolidator subprocess. Same-session self-assignment does NOT
  // spawn — that path is an agent identifying its own role, not requesting work.
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
  // Snapshot content BEFORE soft-archive so the response can echo what was
  // forgotten (immediate signal if the id was typo'd).
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

// Record the supersede edge AND archive in one step. softArchive alone would
// break the audit chain ("what happened to fact X?"); merge/scope_both record
// the edge too, so prefer_a/prefer_b must preserve the same invariant.
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
  // One transaction: a mid-resolution failure rolls back the merged row
  // instead of leaving an orphan with only one original archived.
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
  // One transaction: a partial failure can't leave scoped-A inserted and A
  // archived while B is still un-scoped.
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
  // Reject same-id before any resolution branch: every branch misbehaves
  // (scope_both double-stamps, prefer_* self-supersedes, merge confuses the
  // audit trail) — all caller error, so surface a clear message.
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

// Internal helpers exposed for tests only.
export const __internal = {
  stripScopeQualifier,
  validateScope,
  bigintReplacer,
  requireValidSessionId,
  authzCrossSession,
  okResponse,
  errResponse,
};
