---
name: config-init
description: Write the default forgewright.json into the current repo so workflows, retention, reaudit thresholds, and the agentwright path are visible and editable locally. Also performs a one-time discovery pass for the agentwright CLI. Use when the user wants to customize forgewright settings or before their first workflow run.
argument-hint: [--force]
---

Create `.claude/forgewright.json` populated with every default value, and resolve `agentwright.path` so steady-state workflow runs don't depend on the Claude Code plugin cache layout.

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/config-init.js $ARGUMENTS
```

**Instructions:**

1. Run the bash command above, forwarding any arguments the user passed.
2. If the script reports the file already exists, ask the user whether to re-run with `--force` to overwrite. Never overwrite without confirmation.
3. On success, confirm:
   - The path written.
   - Whether the agentwright CLI was discovered (and at which version). If not found, surface the install instruction so the user can install agentwright before running their first workflow.
   - Remind the user that deleting `.claude/forgewright.json` reverts to the built-in defaults (so they can regenerate anytime with this skill).

**Use when:**
- The user is about to run their first forgewright workflow.
- The user wants to customize built-in workflows, define their own, or tune retention / re-audit / test-command settings.
- The user wants to scaffold a fresh config to see all available defaults. (After an agentwright upgrade you don't need this — every workflow start auto-refreshes `agentwright.path`.)
