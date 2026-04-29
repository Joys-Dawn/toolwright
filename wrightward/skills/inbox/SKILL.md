---
name: inbox
description: Check your bus inbox for pending urgent events from other agents (handoffs, file_freed, user_message, blocker, ack, finding, decision, agent_message, delivery_failed). Urgent events auto-inject on the next tool call; use this skill to query explicitly when you suspect something is waiting.
---

# Inbox

Check your bus inbox for pending urgent events from other agents.

Use the `wrightward_list_inbox` MCP tool. Options:
- `limit`: max events to return
- `types`: filter by event type (e.g., `["handoff", "file_freed"]`)
- `mark_delivered`: whether to advance the bookmark (default: true)

Example: `wrightward_list_inbox({})` — returns all pending urgent events.

Events are automatically injected on each tool call, but this skill lets you explicitly query when needed.
