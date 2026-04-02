---
description: Run a single audit stage
argument-hint: [stage] [scope]
allowed-tools: Read, Write, Edit, Glob, Grep, Bash(node *), Bash(git *), Bash(npx *), Bash(npm *), Bash(ruff *)
---

Run a one-stage audit pipeline using the provided stage and scope.

Interpret the first token of `$ARGUMENTS` as the stage and the remaining text as the scope. If the scope is missing, use `--diff`.

1. Start the stage:
!`node ${CLAUDE_PLUGIN_ROOT}/coordinator/index.js start-stage $ARGUMENTS`
Note the `runId` from the JSON output.

2. Wait 60 seconds for the auditor to start producing findings:
`sleep 60`

3. Follow the same poll loop as `audit-run`:
   - Call `next-finding --run <runId>` to get findings one at a time
   - For each finding, follow `audit-run`'s verification process exactly (Steps A–D): locate the code, try to contradict the finding, critically reason through whether it's a real issue, then decide
   - Call `record-decision` for each finding
   - Repeat until `"done"`

4. Apply the same fix vs. defer rules as `audit-run`:
   - **Fix immediately** when objectively correct
   - **Mark `valid_needs_approval`** for judgment calls or large refactors
   - Skip file-contention-blocked findings (they reappear on next poll)

5. After completion, if any fixes were applied, dispatch the `agentwright:verifier` subagent. Do not blindly accept verifier claims.

6. Present a concise per-finding summary table (see `audit-run` for format).

7. If any findings were deferred, present them to the user and wait for explicit approval.
