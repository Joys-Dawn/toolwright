---
name: update-docs
description: Update project documentation to match current code. Dispatches the update-docs agent to find and fix stale docs.
argument-hint: [scope — e.g. "README" or "the auth module"]
---

Dispatch the update-docs agent to update project documentation so it matches the current code.

Launch the Agent tool with `subagent_type` set to exactly `agentwright:update-docs`. In the `prompt`, include:

1. **Scope** — if the user passed `$ARGUMENTS`, use that to focus the update. Otherwise, tell the agent to infer scope from recent changes (`git diff`, `git log`) and update the minimum needed.
2. **What changed** — summarize any recent code changes from this conversation that the docs should reflect.
3. **Relevant file paths** — paths to both the code that changed and the docs that may need updating.

The update-docs agent does NOT have access to this conversation. You must provide all necessary context in the prompt. Also include the session ID `${CLAUDE_SESSION_ID}` so the agent can optionally read the full transcript if it needs more context.

After the agent returns, report what it changed to the user.
