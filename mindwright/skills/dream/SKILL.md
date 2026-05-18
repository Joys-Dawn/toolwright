---
name: dream
description: Consolidate the oldest ~70% of short-term observations into long-term facts. Reads the active long-term summary, drains a batch of exchanges, distills facts in your own context, and writes them back via deterministic CLI helpers.
---

# /mindwright:dream

You — the calling Claude session — are the consolidator. The CLI tools below are deterministic helpers. The LLM work (reading exchanges, distilling facts, deciding what to keep and what to supersede) happens in **your** context.

## What you're doing

The user has accumulated short-term observations from one or more sessions in this project. Some of that material is signal — durable preferences (`fact/user`), project facts (`fact/project`), role-scoped know-how (`procedural/role:<role>`), or lessons learned (`episodic/project`) — and some is noise (transient state, mechanical tool output), things that were only needed temporarily. Your job is to turn the signal into long-term facts and discard the rest, atomically.

## The cycle

Run these steps in order. Do **not** skip ahead. Do **not** call the `finalize_drain` CLI tool before retaining the facts you wanted.

### Step 1 — orient

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/mindwright.mjs" status --session-id '${CLAUDE_SESSION_ID}' --plugin-data "${CLAUDE_PLUGIN_DATA}"
```

Note the current `short_count`, `long_count`, `by_category` breakdown, and `by_category_scope` breakdown (keys like `fact/user`, `procedural/role:planner`, `episodic/project`) so you can sanity-check the result at the end.

### Step 2 — pick a scope, then pull a batch

First check what role this session is assigned to. Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/mindwright.mjs" get_roles --session-id '${CLAUDE_SESSION_ID}' --plugin-data "${CLAUDE_PLUGIN_DATA}"
```

It returns `{ "roles": [...] }`. If `roles` includes `"consolidator"`, you are a peer dedicated to consolidating the team — use `{ scope: "all" }` (and you will need `confirm_all_sessions: true` in step 6). An auto-spawned consolidator session is assigned this role before launch, so this is the normal automatic path. Otherwise default to `{ scope: "session" }` — a single-session consolidation of your own short-term. Widen a non-consolidator session to `{ scope: "all" }` only when the user asks for a project-wide dream OR the step-2 `hint` reports cross-session rows waiting.

Run `drain_batch` with the chosen scope:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/mindwright.mjs" drain_batch --session-id '${CLAUDE_SESSION_ID}' --plugin-data "${CLAUDE_PLUGIN_DATA}" <<'MINDWRIGHT_ARGS'
{"scope": "session"}
MINDWRIGHT_ARGS
```

The response shape:

```json
{
  "drain_id": "<opaque cursor — pass it back to finalize_drain verbatim>",
  "exchanges": [
    {
      "exchange_id": "<id>",
      "event_ts": "<ISO time the underlying exchange ACTUALLY happened, or null>",
      "rows": [
        { "id": <int>, "kind": "<cli_prompt|thinking|text|...>", "content": "...", "ts": "...", "event_ts": "<ISO or null>" },
        ...
      ],
      "token_estimate": <int>
    },
    ...
  ],
  "existing_long_term_summary": { "fact/user": 12, "fact/project": 30, "episodic/project": 5, "procedural/role:planner": 3 },
  "hint": "<optional — only present when drain_batch wants to tell you something>"
}
```

`event_ts` is **provenance time** — when the underlying exchange actually
happened. It is non-null only for rows seeded/distilled from historical
transcripts (the bootstrap loop); for live consolidation it is `null` and
you simply omit it in step 4. The exchange-level `event_ts` is the
representative (the max of its rows', computed deterministically for you).
**Treat it as opaque, exactly like `drain_id`: copy it through to
`retain_fact` verbatim. Never compute, compare, or synthesize a timestamp
yourself.** It governs retrieval recency only — a fact distilled from a
2024 exchange should rank by 2024, not by today's seed-run time.

`existing_long_term_summary` is a **`<category>/<scope>` → count map** (e.g. `{ "fact/user": 12 }`) — a density snapshot of what long-term already holds, NOT a list of individual facts (no ids, no content). Use it for orientation only: which buckets are already well-covered. Per-fact deduplication is structural and happens later — `retain_fact` (step 4) returns the semantically-close `supersede_candidates`; you do not look up individual facts here.

Always inspect `hint` if present — it appears whenever cross-session rows exist (other bound sessions, the consolidator role's team backlog, or unbound rows from a missed session-bind), even when the current session's drain DID return exchanges. A solo user manually running `/mindwright:dream` may have a tiny current-session pile and a much larger pile across past sessions; the hint tells you to re-run with `scope: "all"` so those rows don't sit forever. Surface the hint to the user when present (see Step 7) and decide whether to widen the scope.

If `exchanges` is empty AND there is no hint: short-term is empty for this scope. Tell the user "nothing to consolidate" and stop. Do NOT call `finalize_drain` on an empty drain.

### Step 3 — distill, exchange by exchange

For each exchange in the batch:

1. **Read** every row in the exchange. Group them mentally into the underlying conversation thread.
2. **Decide what — if anything — is durable signal.** Ask yourself, for each candidate fact:
   - Will this matter in a month, in another session, in a different role? (durability)
   - Is it specific enough to be useful when retrieved out of context? (concreteness)
   - Is this `<category>/<scope>` bucket already dense in `existing_long_term_summary`? (coverage check — don't pile near-duplicates into a saturated bucket. This is the only thing the count map tells you; you can NOT and need NOT check individual facts for dedup here — `retain_fact` returns `supersede_candidates` in step 4.)
3. **Categorize + scope** each fact you decide to retain. Pick a `category` (the TYPE of memory) and a `scope` (the AUDIENCE) independently:

   **Category** — exactly one of:
   - `fact` — a declarative truth. About the user (preference, identity, environment) or about the project (architecture, conventions, gotchas).
   - `procedural` — how to operate. A way of doing something a role or the whole project should follow.
   - `episodic` — something that happened with context, worth remembering as precedent. Lessons learned, post-mortems, "I claimed X without checking and was wrong, verify before claiming"-type rules. These are the most powerful for proactive recall — they carry the lesson, not just the data point.

   **Scope** — exactly one of:
   - `user` — applies to the user (preferences, environment, identity). Confidence-tag user-scoped facts (0.0..1.0) based on how many times you saw the same signal, how recently, and how explicitly. Single one-off mention → ~0.4. Repeated and explicit → ~0.9.
   - `project` — applies to this codebase / project / system.
   - `role:<role>` — applies only when a session has the `<role>` role assigned. Use for know-how that's role-specific (e.g. `role:planner`, `role:reviewer`).

   Common combinations: `fact/user` (a preference), `fact/project` (a codebase truth), `procedural/role:consolidator` (consolidator know-how), `episodic/project` (a lesson learned in this project).
4. **Extract entities** (optional — leave empty for auto-extract). Entity values are bare strings: peer handles like `kira-424`, file paths like `mindwright/lib/store.js`, function names, library names.
5. **Anticipate superseding.** You can't pre-select ids — `existing_long_term_summary` is a count map with none. If you suspect a fact replaces older long-term knowledge, just hold that intent; `retain_fact` (step 4) returns the actual `supersede_candidates` by semantic match, and you decide which to wire up in step 5.
6. **Shape the `content` to its category.** Follow the per-category template below so retrieved memory is consistently scannable. This is a *soft* convention — there is no validator; the structural gates (`category`/`scope` required, tier⇄category DB constraint) are the only hard checks. Match the shape; don't pad to fill a field.

   - **`fact`** — just the claim, one or two sentences, no headers. First-person if it's about the user (`I prefer …`), third-person for project facts (`The store uses WAL …`). No preamble ("The user said that…") — state the fact.
   - **`procedural`** — a reusable way of operating:
     ```
     **What:** <the rule, imperatively — "Verify X before claiming Y">
     **How:** <the concrete steps or check that enacts it>
     **Why:** <only if the rationale is non-obvious; omit otherwise>
     ```
   - **`episodic`** — a precedent worth recalling, with its time/version anchor *inline in the prose* (not a separate field):
     ```
     **What happened:** <the event, with an inline date or version anchor — "On 2026-05, the v3 migration …">
     **Why it matters:** <the transferable lesson — what to do differently next time>
     ```

### Step 4 — retain each fact

For each fact, run `retain_fact` with these JSON args on stdin:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/mindwright.mjs" retain_fact --session-id '${CLAUDE_SESSION_ID}' --plugin-data "${CLAUDE_PLUGIN_DATA}" <<'MINDWRIGHT_ARGS'
{
  "drain_id": "<from step 2>",
  "exchange_id": "<exchange this fact came from>",
  "event_ts": "<copy this exchange's `event_ts` from step 2 VERBATIM; omit the key entirely if it was null>",
  "content": "<the distilled fact text, shaped to its category per step 3.6>",
  "category": "procedural | episodic | fact",
  "scope": "user | project | role:<role>",
  "entities": ["kira-424", "mindwright/lib/store.js"],
  "confidence": 0.85
}
MINDWRIGHT_ARGS
```

(`entities` is optional; `confidence` is `scope='user'` only.)

The response is:

```json
{ "fact_id": <int>, "supersede_candidates": [<int>, ...] }
```

`supersede_candidates` are existing long-term row ids that the retrieval pipeline flagged as semantically close. They are **candidates** — you decide whether each one is genuinely contradicted by your new fact (in which case supersede) or whether it's complementary (leave it alone).

### Step 5 — wire up supersedes

For each candidate you decide IS truly contradicted by the new fact, run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/mindwright.mjs" mark_superseded --session-id '${CLAUDE_SESSION_ID}' --plugin-data "${CLAUDE_PLUGIN_DATA}" <<'MINDWRIGHT_ARGS'
{"old_id": <candidate>, "new_id": <fact_id from step 4>}
MINDWRIGHT_ARGS
```

Don't supersede candidates that merely overlap topically — only the ones the new fact replaces. If unsure, leave it and surface the pair to the user; `/mindwright:resolve-contradiction` is the explicit cleanup path for clashes that need arbitration.

### Step 6 — finalize

When every exchange has been processed, run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/mindwright.mjs" finalize_drain --session-id '${CLAUDE_SESSION_ID}' --plugin-data "${CLAUDE_PLUGIN_DATA}" <<'MINDWRIGHT_ARGS'
{"drain_id": "<from step 2>"}
MINDWRIGHT_ARGS
```

If you opened the drain with `scope: "all"` in step 2 (project-wide consolidation), you MUST also pass `confirm_all_sessions: true`:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/mindwright.mjs" finalize_drain --session-id '${CLAUDE_SESSION_ID}' --plugin-data "${CLAUDE_PLUGIN_DATA}" <<'MINDWRIGHT_ARGS'
{"drain_id": "<from step 2>", "confirm_all_sessions": true}
MINDWRIGHT_ARGS
```

The explicit confirmation guards against a prompt-injected memory tricking your session into hard-deleting other sessions' rows.

This is the only step that **actually deletes** the short-term rows. Until you call it, the drain is reversible — short-term is intact. After it, the rows are gone and a `consolidations` row is written. The drained rows are also archived as markdown under `.claude/mindwright/mirrors/dropped/<date>-<drain_id>.md` before deletion so you can audit what was discarded. Markdown mirrors regenerate automatically.

### Step 7 — report

Show the user: drained N short-term rows, produced M facts (W `fact/user` / X `fact/project` / Y `procedural/role:*` / Z `episodic/project`), superseded K old facts. Surface anything surprising you noticed in the batch (peer mentioned an unstated convention, recurring blocker, etc.) — that's the kind of signal long-term retrieval should be carrying.

ALSO surface the `archive_path` from the `finalize_drain` response so the user can inspect what was discarded — every drain hard-deletes rows and the consolidator writes a full audit copy to that path before deletion. Two phrasings depending on the ratio:
- `produced_count == 0`: "I judged nothing durable; the discarded short-term is archived at `<archive_path>` if you want to spot-check."
- `produced_count > 0` (the common case): "Kept M facts from N observations; the full discarded set is archived at `<archive_path>` if you want to spot-check the 27 I dropped."

Without this line, the user sees "produced 3 facts from 30 observations" and has no idea where the other 27 went or that they're recoverable. Silent data loss in their mental model even though the audit copy exists on disk.

If the step-2 `drain_batch` response carried a cross-session `hint`, surface it to the user too — e.g. "I drained this session's N rows, but M more sit under past sessions; re-run with `scope: "all"` if you want me to consolidate those too." Without this, a default session-scoped dream looks like full success while the larger pile silently waits.

## Hard rules

- **One drain at a time.** Don't open a second drain in the same call; the cutoff timestamps will overlap and `finalize_drain` won't be able to delete cleanly.
- **No partial finalize.** Either you retain everything you intended and call `finalize_drain`, or you abort the cycle and call nothing — leaving short-term intact.
- **Don't fabricate.** If an exchange contains nothing durable, retain nothing. Empty consolidation cycles are normal and valid.
- **Don't paraphrase the user into your own voice.** A user preference is what they said, not your interpretation of it. Quote when it's load-bearing.
- **No `@anthropic-ai/sdk`. No `ANTHROPIC_API_KEY` lookup.** Your context is the LLM; the CLI tools are deterministic helpers.

## When to run

- Automatically — when short-term crosses `cap_exchanges` (or the age safety-net trips), the Stop hook spawns a background `claude --bg` consolidator session that dispatches this skill. The spawned session is identified by a deterministic UUID per `(project, requesting_handle)`, persists across sessions, and is **auto-assigned the `consolidator` role before launch** — so its step-2 role check resolves to a project-wide `scope: "all"` drain (it must also pass `confirm_all_sessions: true` on finalize). See the `status` CLI tool's `consolidator` field (or `/mindwright:status`) for its handle and last-spawn timestamp. If the spawn fails (e.g. `claude` not on PATH), Stop falls back to the additionalContext-nudge path.
- When the leader explicitly assigns the `consolidator` role to a peer via the `assign_role` CLI tool (`/mindwright:assign-role`). Auto-spawn fires for the assignment.
- Manually when the user asks (`/mindwright:dream`).
