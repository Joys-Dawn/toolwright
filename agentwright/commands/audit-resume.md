---
description: Resume an audit run from the next incomplete stage
argument-hint: [run-id]
allowed-tools: Read, Write, Edit, Glob, Grep, Bash(node *), Bash(git *), Bash(npx *), Bash(npm *), Bash(ruff *)
---

Resume an existing run by advancing to the next incomplete group.

1. Require a run id.
2. Advance the pipeline:
!`node ${CLAUDE_PLUGIN_ROOT}/coordinator/index.js next --run $ARGUMENTS`
3. If the run is complete, report that clearly.
4. Otherwise, wait 60 seconds for the auditor to start producing findings:
`sleep 60`
5. Enter the same poll loop as `audit-run`:
   - Call `next-finding --run <runId>` to get findings one at a time
   - For each finding, follow `audit-run`'s verification process exactly (Steps A–D): locate the code, try to contradict the finding, critically reason through whether it's a real issue, then decide
   - Call `record-decision` for each finding
   - Repeat until `"done"`
6. Apply the same fix vs. defer rules, verifier subagent step, summary table, and deferred-findings presentation as `audit-run`.
