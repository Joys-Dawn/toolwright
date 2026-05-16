---
name: status
description: Snapshot of mindwright's state — short/long-term counts, last consolidation, model cache presence, daemon liveness.
---

# /mindwright:status

Two paths:

1. Call the MCP tool `mindwright_status` for the structured payload: `{short_count, long_count, by_category, by_category_scope, last_consolidation, model_cached, daemon_alive, pending_embeds, poison_embeds, unbound_count, oldest_preference_at, consolidator, warnings}`. `by_category_scope` keys are strings like `'fact/user'`, `'procedural/role:planner'`, `'episodic/project'`. `consolidator` is `{ session_id, handle, first_seen, last_spawn }` when this requester has ever spawned a background consolidator session for this project, otherwise `null`.

2. Or run the diagnostic script directly for a human-readable dump:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/status.js"
```

The script prints the MCP-tool fields plus mirror paths and the resolved data directory. One field differs: the script has no caller context, so instead of the per-caller `consolidator` it emits `consolidators` (plural) — every `consolidator_for:*` record so you can see the full project-level set when debugging dream-cycle issues.
