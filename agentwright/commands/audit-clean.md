---
description: Clean retained audit artifacts
argument-hint: [--logs-only]
allowed-tools: Read, Bash(node:*)
---

Clean retained artifacts for completed `agentwright` runs under `.claude/`.

Run:
!`node "${CLAUDE_PLUGIN_ROOT}/coordinator/index.js" clean "$ARGUMENTS"`

Then summarize:
- how many stage log folders were removed
- how many findings files were removed
- which completed run ids were pruned entirely
- whether anything was kept because of the retention policy
