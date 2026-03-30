---
description: Clear the current session from ColLab coordination state
allowed-tools: Bash(node:*)
---

Clear the current session from ColLab coordination state by running the bundled ColLab script. Do not use Edit or Write for this command.

Use this command:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/context.js" --done
```

**Instructions:**

1. Run the Bash command above
2. If it reports that no current context exists, tell the user to run `/wrightward:collab-context` first
3. Otherwise, confirm that this session has been removed from ColLab state
4. If you immediately start a new task, run `/wrightward:collab-context` again to re-declare it

This removes the current session's context, last-seen state, and agent registration immediately.

Use this when:
- You've finished your current task and want to start something new in the same session
- You want to stop collaborating but keep the session open
