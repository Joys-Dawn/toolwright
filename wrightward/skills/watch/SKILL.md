---
name: watch
description: Register interest in a file another agent currently owns so you are notified (via `file_freed`) when it becomes available. Use when your Edit/Write was blocked by another agent's claim and you need to wait rather than work around it.
---

# Watch File

Register interest in a file that another agent currently owns. You will be notified when the file becomes available (via `file_freed` event on your next tool call).

Use the `wrightward_watch_file` MCP tool with:
- `file`: the relative file path to watch

Example: `wrightward_watch_file({ file: "src/auth.ts" })`

This is also done automatically when your Write/Edit is blocked by another agent's claim.
