---
name: research
description: Deep research and literature review on a topic. Dispatches the deep-research agent to search the web, consult reputable sources, and synthesize an answer.
argument-hint: <topic>
---

Dispatch the deep-research agent to thoroughly investigate a topic.

Launch the Agent tool with `subagent_type` set to exactly `agentwright:deep-research`. In the `prompt`, include:

1. **The research question** — if the user passed `$ARGUMENTS`, use that as the topic. Otherwise, identify the most recent question or topic from this conversation that needs research.
2. **Relevant context** — any constraints, preferences, or specific angles the user mentioned that should guide the research.
3. **What the user needs** — whether they want a comparison, a recommendation, a literature review, or just facts.

The deep-research agent does NOT have access to this conversation. You must provide all necessary context in the prompt. Also include the session ID `${CLAUDE_SESSION_ID}` so the agent can optionally read the full transcript if it needs more context.

After the agent returns, report its findings to the user — preserve the structure and citations.
