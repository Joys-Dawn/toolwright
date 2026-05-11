---
name: watch
description: Register interest in a file another agent currently owns so you are notified (via `file_freed`) when it becomes available. The guard hook already auto-registers a watch AND auto-emits a `blocker` event to the holder whenever your Write is blocked, so this skill is only needed for explicit interest on a file you haven't tried to write yet (e.g., you plan to edit it next and want a head start on the wake-up).
---

# Watch File

Register interest in a file that another agent currently owns. You will be notified when the file becomes available — `file_freed` arrives via the channel doorbell when channels are enabled (between turns) or on your next tool call otherwise.

Use the `wrightward_watch_file` MCP tool with:
- `file`: the relative file path to watch

Example: `wrightward_watch_file({ file: "src/auth.ts" })`

This is also done automatically when your Write/Edit is blocked by another agent's claim.
