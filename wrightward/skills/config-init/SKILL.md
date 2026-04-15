---
name: config-init
description: Write the default wrightward.json into the current repo so every tunable is visible and editable locally. Use when the user wants to customize wrightward settings.
allowed-tools: Bash(node *)
argument-hint: [--force]
---

Create `.claude/wrightward.json` populated with every default value, so the user can see and edit any knob locally without hunting through docs.

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/config-init.js $ARGUMENTS
```

**Instructions:**

1. Run the Bash command above, forwarding any arguments the user passed.
2. If the script reports the file already exists, ask the user whether to re-run with `--force` to overwrite. Never overwrite without confirmation.
3. On success, confirm the path written and remind the user that deleting `.claude/wrightward.json` reverts to the built-in defaults (so they can regenerate anytime).

**Use when:**
- The user wants to tune wrightward (bus retention, timeouts, Discord bridge, mirror policy, etc.) and asks how or where to configure it.
- The user asks for a "default config" or an example to edit.
