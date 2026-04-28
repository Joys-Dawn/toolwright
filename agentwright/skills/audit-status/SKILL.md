---
name: audit-status
description: Show audit run status
argument-hint: [run-id]
---

Show the current state of an `agentwright` audit run.

Execute:
!`node ${CLAUDE_PLUGIN_ROOT}/coordinator/index.js status $ARGUMENTS`

Summarize:
- current group
- active stages
- completed stages
- pending stages
- whether findings are still streaming or verification is still in progress
