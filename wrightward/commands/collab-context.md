---
description: Declare or update what you're currently working on for multi-agent awareness
allowed-tools: Bash(node:*)
---

Determine the current work for this session using the schema below. Then use the Bash tool to run the bundled ColLab script and send the JSON payload on stdin. Do not use Edit or Write for this command.

Use this command shape:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/context.js" <<'EOF'
{
  "task": "...",
  "files": ["..."],
  "functions": ["..."],
  "status": "in-progress"
}
EOF
```

The script will resolve the active session automatically and write the correct context file.

Use this schema for the payload:

```json
{
  "task": "One-line description of current work",
  "files": ["+src/new.ts", "~src/existing.ts", "-src/old.ts"],
  "functions": ["+newFunc", "~modifiedFunc", "-removedFunc"],
  "status": "in-progress"
}
```

**Field definitions:**

- **task**: A concise one-line description of what you are currently doing.
- **files**: Paths you are touching. Prefix with `+` for files you're creating, `~` for files you're modifying, `-` for files you're deleting.
- **functions**: Functions you are touching. Same prefix convention: `+` for new, `~` for modified, `-` for removed.
- **status**: Set to `"in-progress"` while working. Set to `"done"` when finished (the guard will clean up done entries).

**Example:**

```json
{
  "task": "Adding user authentication middleware",
  "files": ["+src/middleware/auth.ts", "~src/server.ts"],
  "functions": ["+validateToken", "+authMiddleware", "~startServer"],
  "status": "in-progress"
}
```

**Instructions:**

1. Assess what you're currently working on
2. Build a JSON payload that matches the schema
3. Run the Bash command above with the payload on stdin
4. If the script fails, explain the error plainly
5. Update your context whenever your focus shifts significantly (new task, different files, etc.)
