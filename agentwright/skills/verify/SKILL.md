---
name: verify
description: Verify that completed work matches what was requested. Dispatches the verifier agent to independently check implementations against claims.
argument-hint: [optional focus area]
---

Dispatch the verifier agent to independently check the work just completed in this conversation.

Launch the Agent tool with `subagent_type` set to exactly `agentwright:verifier`. In the `prompt`, include:

1. **What the user originally requested** — summarize from this conversation. Use the user's own framing, not an optimistic paraphrase.
2. **What you claimed to have done** — the specific files, functions, and behaviors you reported as complete. Use the exact language you used when reporting completion.
3. **Relevant file paths** — absolute paths to every file you touched.
4. **Snapshot path if available** — if agentwright provided a snapshot directory for this task, include it so the verifier can diff against pre-task state instead of `git diff`.
5. **Focus area** — if the user passed `$ARGUMENTS`, include it to focus the verification.

6. **Session ID** — include `${CLAUDE_SESSION_ID}` so the verifier can optionally read the full transcript if it needs more context.

Do not filter your claims to only the ones you are confident about. The verifier's job is to catch gaps.

After the verifier returns, report its findings to the user verbatim — do not soften or filter the output.
