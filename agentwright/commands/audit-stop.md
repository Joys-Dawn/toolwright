---
description: Stop a running audit and kill its processes
argument-hint: [run-id]
allowed-tools: Read, Bash(node *)
---

Stop an active audit run, killing all worker and auditor processes.

If a run id is provided, execute:
!`node ${CLAUDE_PLUGIN_ROOT}/coordinator/index.js stop --run $ARGUMENTS`

If no run id is provided:
1. List runs with `node ${CLAUDE_PLUGIN_ROOT}/coordinator/index.js status`
2. Identify any run with status `running` or `auditing`
3. Run the stop command for that run

Summarize:
- which processes were killed (stage, role, pid)
- the final run status
- if no active run was found, say so
