---
description: Stop a running audit and kill its processes
argument-hint: [run-id]
allowed-tools: Read, Bash(node *)
---

Stop an active audit run, killing all worker and auditor processes.

Execute:
!`node ${CLAUDE_PLUGIN_ROOT}/coordinator/index.js stop $ARGUMENTS`

If no run id is provided, it auto-detects the active run.

Summarize:
- which processes were killed (stage, role, pid)
- the final run status
- if no active run was found, say so
