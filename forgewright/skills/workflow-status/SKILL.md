---
name: workflow-status
description: Show forgewright workflow status — list all workflows, or dump the full state of one. Use when the user wants to see what's running, what's paused, or inspect a workflow's history.
argument-hint: [workflow-id]
---

Show the status of a specific workflow, or list all workflows when no ID is given.

If `$ARGUMENTS` is empty, list every workflow with its summary state. Otherwise, dump the full workflow JSON.

Run:

!`CLAUDE_PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT}" node "${CLAUDE_PLUGIN_ROOT}/coordinator/index.js" workflow-status $ARGUMENTS`

Format the output for the user:

- Without an ID: print a small table with `workflowId`, `workflowName`, `status`, `phases[currentPhaseIndex].name` (current phase name), `currentPhaseIndex/totalPhases`, `updatedAt`. Sort by most recently updated.
- With an ID: print the workflow's `status`, `workflowName`, `args`, current phase (`phases[currentPhaseIndex].name` + `type`), and a list of completed phases by `name`. Don't dump the entire JSON unless the user asked for it explicitly.
