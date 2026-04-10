---
name: collab-done
description: Use when you have finished your current task in a multi-agent codebase and need to release your file claims so other agents are unblocked.
allowed-tools: Bash(node *)
---

Clear the current session from collab coordination state.

**CRITICAL RULE — NEVER EDIT COLLAB FILES DIRECTLY.** Files in `.claude/collab/` are managed by wrightward. You must NEVER use Edit, Write, Bash (`rm`, `sed`, redirects, etc.), or any other tool to modify or delete these files. Only clear your own session through this skill. You may NEVER remove another agent's context or claims.

**If you believe another agent's claim is stale:** wait 6 minutes and try again. If the claim is still enforced after 6 minutes, the other agent is alive and the claim is legitimate — do not attempt to bypass it, and do not assume it is stale. Claims declared through `/wrightward:collab-context` can legitimately persist for 15 minutes or longer while the other agent works through a plan. If you need more certainty, ask the user.

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/context.js --session-id '${CLAUDE_SESSION_ID}' --done
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
