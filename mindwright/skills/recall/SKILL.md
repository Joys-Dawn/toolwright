---
name: recall
description: Explicit retrieval against the memory store. Useful when the automatic turn-start / mid-turn retrieval missed something, or for debugging what would be injected.
---

# /mindwright:recall

Usage: `/mindwright:recall <query>` (the argument becomes the retrieval query).

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/mindwright.mjs" recall --session-id '${CLAUDE_SESSION_ID}' <<'MINDWRIGHT_ARGS'
{"query": "...", "scope": "all", "k": 8, "bypass_session_dedup": true}
MINDWRIGHT_ARGS
```

JSON args (stdin):
- `query`: the text to retrieve against.
- `scope`: optional TIER filter — `short` / `long` / `all` (default `all`). The memory-row scope (`user` / `project` / `role:<role>`) is filtered implicitly via the calling session's role-set.
- `k`: optional top-K (default 8).
- `roles`: optional array overriding the role-scope filter. Pass `[]` to suppress all role-scoped rows, or `["planner","consolidator"]` to see those roles' heuristics regardless of the calling session's own assignment.
- `exclude_ids`: optional array of fact ids to drop from the result set.
- `bypass_session_dedup: true` — pass this on every explicit `/mindwright:recall` invocation. It tells mindwright to ignore the automatic per-session dedup set so a second call shows the same hits as the first. Without it the second call shows fewer results (the first call's hits get filtered out), which is hostile to the debugging use case.

Returns `{ results: [{id, content, kind, tier, category, scope, rerank_score, rrf_score}] }`. Empty array means nothing crossed the rerank floor (0.10).

Why the bypass flag exists: the automatic PreToolUse / PostToolUse retrieval keeps `meta:injected_fact_ids:<sessionId>` (FIFO-trimmed at 200) so it doesn't re-inject the same fact twice in one session. Explicit debugging calls don't want that filter — they want the truth of what matches the query right now. `bypass_session_dedup: true` skips both the read and the post-emit append for the debug path only.
