---
description: Show audit run status
argument-hint: [run-id]
allowed-tools: Read, Bash(node *)
---

Show the current state of an `agentwright` audit run.

If a run id is provided, execute:
!`node "${CLAUDE_PLUGIN_ROOT}/coordinator/index.js" status --run "$ARGUMENTS"`

If no run id is provided, execute:
!`node "${CLAUDE_PLUGIN_ROOT}/coordinator/index.js" status`

Summarize:
- current group
- active stages
- completed stages
- pending stages
- whether findings are still streaming or verification is still in progress
