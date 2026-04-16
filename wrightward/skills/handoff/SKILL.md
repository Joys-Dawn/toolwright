# Handoff

Hand off work to another agent, releasing specified files.

Use the `wrightward_send_handoff` MCP tool with:
- `to`: the target agent's handle (e.g. `"bob-42"`). Peers appear by handle in `/wrightward:inbox` hints; use `wrightward_whoami` to see your own.
- `task_ref`: what you were working on
- `files_unlocked`: files to release as part of the handoff
- `next_action`: what the recipient should do next

Example: `wrightward_send_handoff({ to: "bob-42", task_ref: "auth refactor", files_unlocked: ["src/auth.ts", "src/jwt.ts"], next_action: "run the migration test suite" })`
