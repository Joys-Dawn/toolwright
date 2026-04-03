---
name: collab-context
description: Use when working in a multi-agent codebase and you need to declare or update what files and functions you are working on so other agents can see your claims and avoid conflicts.
allowed-tools: Bash(node *)
---

Declare or update what you're currently working on for multi-agent awareness.

Run the bundled collab script with a JSON payload on stdin. Do not use Edit or Write for this — use the Bash tool only.

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/context.js <<'EOF'
{
  "task": "...",
  "files": ["..."],
  "functions": ["..."],
  "status": "in-progress"
}
EOF
```

**Payload schema:**

```json
{
  "task": "One-line description of current work",
  "files": ["+src/new.ts", "~src/existing.ts", "-src/old.ts"],
  "functions": ["+newFunc", "~modifiedFunc", "-removedFunc"],
  "status": "in-progress"
}
```

**Fields:**

- **task**: Concise one-line description of what you are doing.
- **files**: Paths you are certain you will touch. Prefix: `+` creating, `~` modifying, `-` deleting. Only declare files you are 100% sure about — if you end up touching other files via Edit or Write, they will be automatically added to your context while other agents are active.
- **functions**: Functions you are touching. Same prefix convention.
- **status**: `"in-progress"` while working, `"done"` when finished.

**When to use:** Best used after a plan has been made (e.g., after using plan mode or agentwright's feature planning skill), since you'll have a clear picture of which files and functions you'll touch.

**Timeout behavior:**

- **Declared files** (listed here): Held for 15 minutes. If you're still actively editing a file near the end of that window, the claim extends automatically.
- **Auto-tracked files** (detected from your Edit/Write calls without being declared here): Held for only 2 minutes from your last touch. These are lightweight claims that expire quickly.
- **Idle reminders**: If you haven't touched a file in 5 minutes, you'll get a one-time reminder to consider releasing it.
- **Early release**: Use `/wrightward:collab-release` to release files immediately when you're done with them, instead of waiting for the timeout.

**Instructions:**

1. Assess what you're currently working on
2. Build a JSON payload matching the schema
3. Run the Bash command above with the payload on stdin
4. If the script fails, explain the error plainly
5. Update your context whenever your focus shifts significantly (new task, different files, etc.)
6. Release files you no longer need with `/wrightward:collab-release`
