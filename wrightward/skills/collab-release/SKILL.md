---
name: collab-release
description: Release specific files from your collaboration context so other agents can work on them immediately.
allowed-tools: Bash(node *)
---

Release one or more files from your collab context.

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/release-file.js <<'EOF'
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
