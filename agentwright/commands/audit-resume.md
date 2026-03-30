---
description: Resume an audit run from the next incomplete stage
argument-hint: [run-id]
allowed-tools: Read, Write, Edit, Glob, Grep, Bash(node:*), Bash(git:*), Bash(npx:*), Bash(npm:*), Bash(ruff:*)
---

Resume an existing run by checking the current incomplete group and only advancing if that group is fully complete.

1. Require a run id.
2. Execute:
!`node "${CLAUDE_PLUGIN_ROOT}/coordinator/index.js" next --run "$ARGUMENTS"`
3. If the run is complete, report that clearly.
4. Otherwise, the returned JSON may describe either:
   - a newly launched active group, or
   - an already active group whose stages are still streaming findings
   - a blocked group with `failedStages` that must be investigated or retried before advancing
5. Use the returned `activeStages` list and follow the same streamed verification/fix workflow as `audit-run` for each stage in that group, including the fix vs. defer criteria, file contention handling, the `agentwright:verifier` subagent step for applied fixes (do not blindly accept verifier claims — independently confirm each), the concise per-finding summary table (see `audit-run` step 15), and the user approval step for deferred findings.
