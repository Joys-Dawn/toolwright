---
name: config-init
description: Write the default agentwright.json into the current repo so pipelines, custom stages, and retention are visible and editable locally. Use when the user wants to customize agentwright settings.
argument-hint: [--force]
---

Create `.claude/agentwright.json` populated with every default value, so the user can see and edit pipelines, custom stages, and retention settings locally without hunting through docs.

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/config-init.js $ARGUMENTS
```

**Instructions:**

1. Run the Bash command above, forwarding any arguments the user passed.
2. If the script reports the file already exists, ask the user whether to re-run with `--force` to overwrite. Never overwrite without confirmation.
3. On success, confirm the path written and remind the user that deleting `.claude/agentwright.json` reverts to the built-in defaults (so they can regenerate anytime).

**Use when:**
- The user wants to customize pipelines, define custom stages, or tune retention settings.
- The user asks for a "default config" or an example to edit.
