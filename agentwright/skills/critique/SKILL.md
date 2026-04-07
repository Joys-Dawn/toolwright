---
name: critique
description: Adversarial critique of an idea, plan, claim, or proposal. Dispatches the party-pooper agent to stress-test it.
argument-hint: [optional focus area, e.g. "scaling risks"]
---

Dispatch the party-pooper agent to adversarially critique the most recent plan, proposal, claim, or decision in this conversation.

Launch the Agent tool with `subagent_type` set to exactly `agentwright:party-pooper`. In the `prompt`, include:

1. **The target** — summarize the plan, proposal, claim, or decision from this conversation that should be critiqued. Use the strongest version of the argument — steelman it before handing it off.
2. **Relevant context** — any constraints, goals, or tradeoffs discussed that the critic needs to understand.
3. **Relevant file paths** — if the target involves code or architecture, include the key file paths.
4. **Focus area** — if the user passed `$ARGUMENTS`, include it to focus the critique.

The party-pooper agent does NOT have access to this conversation. You must provide all necessary context in the prompt. Also include the session ID `${CLAUDE_SESSION_ID}` so the agent can optionally read the full transcript if it needs more context.

After the agent returns, report its findings to the user verbatim — do not soften or filter the critique.
