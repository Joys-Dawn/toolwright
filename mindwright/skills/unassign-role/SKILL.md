---
name: unassign-role
description: Remove a role tag from a session.
---

# /mindwright:unassign-role

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/mindwright.mjs" unassign_role --session-id '${CLAUDE_SESSION_ID}' <<'MINDWRIGHT_ARGS'
{"target": "bob-42", "role": "planner", "confirm_cross_session": true}
MINDWRIGHT_ARGS
```

JSON args (stdin): `target` accepts either a UUID session id or a wrightward handle (e.g. `bob-42`); `role` must match `/^[a-zA-Z0-9_-]{1,64}$/`. When `target` resolves to a session OTHER than the caller's, you MUST also pass `confirm_cross_session: true` — the handler rejects cross-session mutation without it (same BOLA guard as the `assign_role` CLI tool). Returns the new role set.
