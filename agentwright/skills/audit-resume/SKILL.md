---
name: audit-resume
description: Resume an audit run from the next incomplete stage
argument-hint: [run-id]
---

Resume an existing run by advancing to the next incomplete group.

1. Require a run id.
2. Advance the pipeline:
!`node ${CLAUDE_PLUGIN_ROOT}/coordinator/index.js next --run $ARGUMENTS`
3. If the run is complete, report that clearly.
4. Otherwise, enter the same wait-and-fetch loop as `audit-run`:
   - Call `next-finding --run <runId> --wait` (pass `timeout=600000` to Bash). The command blocks internally until a finding lands, the stage errors, or the pipeline finishes.
   - On `"waiting"`, repeat the same call (auditor is still working).
   - On `"finding"`, follow `audit-run`'s verification process exactly (Steps A–D): locate the code, try to contradict the finding, critically reason through whether it's a real issue, then decide.
   - Call `record-decision` for each finding.
   - Repeat until `"done"` or `"error"`.
5. Apply the same fix vs. defer rules, verifier subagent step, summary table, and deferred-findings presentation as `audit-run`.
