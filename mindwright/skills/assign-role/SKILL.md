---
name: assign-role
description: Attach a role tag to a session (yours or a peer's). Role-scoped procedural memories are filtered by role at retrieval time, so this controls which heuristics get injected. Assigning `consolidator` to a peer auto-spawns the dream cycle.
---

# /mindwright:assign-role

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/mindwright.mjs" assign_role --session-id '${CLAUDE_SESSION_ID}' --plugin-data "${CLAUDE_PLUGIN_DATA}" <<'MINDWRIGHT_ARGS'
{"target": "bob-42", "role": "planner", "confirm_cross_session": true}
MINDWRIGHT_ARGS
```

JSON args (stdin):
- `target`: either a UUID session id (run `wrightward_whoami` if you need yours) OR a wrightward handle (e.g. `bob-42`). Handles resolve via the on-disk wrightward roster. When `target` resolves to a session OTHER than the caller's (assigning a role to a peer), you MUST also pass `confirm_cross_session: true` — the handler rejects cross-session mutation without it (a BOLA guard against a prompt-injected forged session id).
- `role`: one of the built-in roles — `planner`, `implementer`, `reviewer` (alias: `validator`), `consolidator`, `tester` — or any custom path-safe identifier (must match `/^[a-zA-Z0-9_-]{1,64}$/` — no spaces, slashes, or colons). Built-in roles inject a role-identity prompt fragment on the next turn; custom roles still scope procedural retrieval but inject no extra context.

A session may hold multiple roles; new ones are added without removing existing ones. Returns `{ roles: string[], spawn_result }`. `spawn_result` is non-null when `role === 'consolidator'` and `target` is a peer (NOT the caller) — in that case mindwright auto-spawns a background `claude --bg` consolidator session keyed by `(project, requesting_handle)`. See `/mindwright:status` → `consolidator` for the spawn record.
