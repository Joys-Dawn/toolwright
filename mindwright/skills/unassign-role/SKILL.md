---
name: unassign-role
description: Remove a role tag from a session.
---

# /mindwright:unassign-role

Call `mindwright_unassign_role(target, role)`. `target` accepts either a UUID session id or a wrightward handle (e.g. `bob-42`); `role` must match `/^[a-zA-Z0-9_-]{1,64}$/`. When `target` resolves to a session OTHER than the caller's, you MUST also pass `confirm_cross_session: true` — the handler rejects cross-session mutation without it (same BOLA guard as `mindwright_assign_role`). Returns the new role set.
