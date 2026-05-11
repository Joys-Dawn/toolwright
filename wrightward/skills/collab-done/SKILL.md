---
name: collab-done
description: Use when you have finished your current task in a multi-agent codebase and need to release your file claims so other agents are unblocked.
allowed-tools: Bash(node *)
---

Clear the current session from collab coordination state.

**CRITICAL RULE — NEVER EDIT COLLAB FILES DIRECTLY.** Files in `.claude/collab/` are managed by wrightward. You must NEVER use Edit, Write, Bash (`rm`, `sed`, redirects, etc.), or any other tool to modify or delete these files. Only clear your own session through this skill. You may NEVER remove another agent's context or claims.

**If your write is blocked by another agent's claim:** don't bypass and don't passively wait. The guard hook auto-registers your interest AND auto-emits a `blocker` event to the holder (they see who is blocked, on which file, and are prompted to reply with whether/when they can free it). Move on to other work — `file_freed` will wake you when the holder releases, and `agent_message` will wake you if they reply. Wake-ups arrive via the channel doorbell when channels are enabled (between turns) or on your next tool call otherwise. Only message the holder manually with `wrightward_send_message` if you need to clarify scope/timing beyond the auto-notification. For known-timing waits (e.g., a peer's 5-minute script), `ScheduleWakeup` is also available. If nothing happens after a reasonable interval, escalate to the user — don't retry writes against an enforced lock. Crashed sessions auto-scavenge after 6 min of no heartbeat. Never edit `.claude/collab/*` to remove the claim — it's hard-blocked and is a security violation.

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
