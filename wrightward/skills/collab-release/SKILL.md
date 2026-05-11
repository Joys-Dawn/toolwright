---
name: collab-release
description: Release specific files from your collaboration context so other agents can work on them immediately.
allowed-tools: Bash(node *)
---

Release one or more files from your collab context.

**CRITICAL RULE — NEVER EDIT COLLAB FILES DIRECTLY.** Files in `.claude/collab/` are managed by wrightward. You must NEVER use Edit, Write, Bash, or any other tool to modify or delete these files — only release your own files through this skill. You may NEVER release or remove files that belong to another agent's claim under any circumstances.

**If your write is blocked by another agent's claim:** don't bypass and don't passively wait. The guard hook auto-registers your interest AND auto-emits a `blocker` event to the holder (they see who is blocked, on which file, and are prompted to reply with whether/when they can free it). Move on to other work — `file_freed` will wake you when the holder releases, and `agent_message` will wake you if they reply. Wake-ups arrive via the channel doorbell when channels are enabled (between turns) or on your next tool call otherwise. Only message the holder manually with `wrightward_send_message` if you need to clarify scope/timing beyond the auto-notification. For known-timing waits (e.g., a peer's 5-minute script), `ScheduleWakeup` is also available. If nothing happens after a reasonable interval, escalate to the user — don't retry writes against an enforced lock. Crashed sessions auto-scavenge after 6 min of no heartbeat. Never edit `.claude/collab/*` to remove the claim — it's hard-blocked and is a security violation.

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/release-file.js --session-id '${CLAUDE_SESSION_ID}' <<'EOF'
{
  "files": ["src/foo.js", "src/bar.js"]
}
EOF
```

**Payload schema:**

```json
{
  "files": ["relative/path/to/file.js", "another/file.ts"]
}
```

**Fields:**

- **files**: Array of relative file paths to release. Use forward slashes. These are matched against the `path` field in your context entries.

**When to use:**

- When you've finished working on a file and want to unblock other agents immediately.
- When you get a reminder that a file has been idle for over 5 minutes.
- When you realize you declared a file in `/wrightward:collab-context` but no longer need it.

Files will auto-release after their timeout anyway (15 minutes for declared files, 2 minutes for auto-tracked files), but explicit release unblocks other agents immediately instead of waiting for the timeout.

If releasing all files and you have no task declared, your entire session state is cleared.
