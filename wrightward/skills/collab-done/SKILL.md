---
name: collab-done
description: Use when you have finished your current task in a multi-agent codebase and need to release your file claims so other agents are unblocked.
allowed-tools: Bash(node *)
---

Clear the current session from collab coordination state.

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/context.js --done
```

**Instructions:**

1. Run the Bash command above
2. If it reports no current context exists, use `/wrightward:collab-context` first
3. Otherwise, confirm that this session has been removed from collab state

This removes the current session's context, last-seen state, and agent registration immediately. Other agents blocked on your files will be unblocked.

**Use when:**
- You've finished your current task and want to release file claims
- You want to stop collaborating but keep the session open
- Another agent is waiting on files you no longer need
