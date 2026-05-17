---
name: retain
description: Explicitly save a fact to memory. Bypasses the consolidator — use when you know something is worth remembering and don't want to wait for the next dream cycle.
---

# /mindwright:retain

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/mindwright.mjs" retain --session-id '${CLAUDE_SESSION_ID}' <<'MINDWRIGHT_ARGS'
{"content": "...", "kind": "fact", "tier": "long"}
MINDWRIGHT_ARGS
```

JSON args (stdin):
- `content` (required): the fact text.
- `kind` (required): a short label like `fact`, `note`, `preference`. Avoid `decision`, `handoff`, `finding`, `blocker` — those are reserved for peer-broadcast bus events and would classify your retain as peer-origin instead of self.
- `tier` (required): `short` or `long`.
- `category` (optional, tier=long only): `procedural` | `episodic` | `fact`. Auto-categorized from content cues when omitted.
- `scope` (optional, tier=long only): `user` | `project` | `role:<role>`. Auto-inferred from cues when omitted.
- `confidence` (optional): 0.0–1.0 for `scope=user` rows.

Returns `{ id: number, supersede_candidates: number[], warning?: string }`.

For `tier: "long"`, the same supersede-candidate detection that runs during `/mindwright:dream` flags existing long-term rows that look semantically close to the new fact. When `supersede_candidates` is non-empty, surface the ids to the user — they may want to `/mindwright:update-memory <old_id>` to replace one of them, or `/mindwright:resolve-contradiction` if the conflict needs arbitration. Silent retain on top of contradictory memory leaves both facts active and pollutes future recalls.

If the response includes a `warning` field, the categorization heuristic could not match any cue (the content was too terse — "dark theme yes" — or used phrasing the cues don't recognize) and the row was filed under the default `fact/project`. Relay the warning verbatim to the user and the fact id. A user preference that ends up tagged `fact/project` will surface in retrieval as if it were a codebase convention, which can mislead the model into treating it as architectural truth. Recovery: `/mindwright:update-memory <id>` only rewrites content — it copies the old row's category and scope forward, so it canNOT fix a mis-tag. To correct the category/scope, `/mindwright:forget <id>` the wrong row and re-`/mindwright:retain` with explicit `category` and `scope`. Passing explicit `category` and `scope` on the retain call in the first place skips the heuristic entirely and avoids the problem.
