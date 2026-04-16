---
description: Write a fully-defaulted .claude/ideawright.json into this repo
argument-hint: [--force]
allowed-tools: Bash(node *)
---

!`node ${CLAUDE_PLUGIN_ROOT}/scripts/ideawright.mjs config-init $ARGUMENTS`

Tell the user where the config was written and list the top-level keys (sources, novelty, feasibility, digest, schedule) so they know what's tunable. If --force overwrote an existing file, mention that.
