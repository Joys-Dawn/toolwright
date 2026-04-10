---
name: collab-release
description: Release specific files from your collaboration context so other agents can work on them immediately.
allowed-tools: Bash(node *)
---

Release one or more files from your collab context.

**CRITICAL RULE — NEVER EDIT COLLAB FILES DIRECTLY.** Files in `.claude/collab/` are managed by wrightward. You must NEVER use Edit, Write, Bash, or any other tool to modify or delete these files — only release your own files through this skill. You may NEVER release or remove files that belong to another agent's claim under any circumstances.

**If you believe another agent's claim is stale:** wait 6 minutes and try again. If the claim is still enforced after 6 minutes, the other agent is alive and the claim is legitimate — do not attempt to bypass it, and do not assume it is stale. Claims declared through `/wrightward:collab-context` can legitimately persist for 15 minutes or longer while the other agent works through a plan. If you need more certainty, ask the user.

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
