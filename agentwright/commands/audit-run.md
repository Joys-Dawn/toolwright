---
description: Run the default or named audit pipeline
argument-hint: [pipeline-or-stage-list] [scope]
allowed-tools: Read, Write, Edit, Glob, Grep, Bash(node:*), Bash(git:*), Bash(npx:*), Bash(npm:*), Bash(ruff:*)
---

Run the bundled audit pipeline coordinator and then act as the verifier/fixer for each stage.

Before doing anything else, create a todo list with every workflow step below so you can track progress as you go.

Rules:
- If `$ARGUMENTS` is empty, treat the scope as `--diff`.
- The default pipeline is `correctness`, `security`, `best-practices`.
- If the first token is a known pipeline name, use it. If it is a comma-separated stage list, run those stages sequentially in the provided order. Otherwise treat the full argument string as scope.
- Named pipelines may include parallel groups declared as nested arrays in config.
- The spawned auditor is read-only and audits a frozen stage snapshot. You are the verifier/fixer for the live repo.
- Only fix findings you confirm are valid after re-reading the code.
- For invalid findings, do not edit code; record a rationale.
- Apply valid narrow fixes as findings arrive. Do not wait for the full stage to finish before fixing.
- Never trust snapshot evidence blindly. Re-check the live repo before editing.
- If a stage audit fails, do not complete it. Review the logs or retry instead.

Deciding what to fix vs. defer:
- **Fix immediately** only when the fix is objectively correct — meaning any competent reviewer would agree it is an improvement with no meaningful tradeoff. This applies to all finding types: bugs, security flaws, naming improvements, dead code removal, missing error handling, and clean-code fixes can all be objectively correct.
- **Mark `valid_needs_approval`** and do not edit code when:
  - The finding involves a judgment call, style preference, or architectural opinion where reasonable people could disagree.
  - The fix requires a large refactor or touches many files.
  - There are meaningful tradeoffs (performance vs. readability, consistency vs. correctness, etc.).
  - You are not fully confident the fix is an unambiguous improvement.
- When in doubt, defer. A false `valid_needs_approval` costs the user a quick review; a wrong auto-applied fix costs them debugging time.

Workflow:
1. Check if `.collab/` exists in the project root and contains active agents. If it does:
   - Run `/wrightward:collab-context` with your task set to the audit pipeline and scope, and files set to an empty list. Files you edit will be auto-tracked by wrightward.
   - When the run completes, run `/wrightward:collab-done` to clear your context.
   If `.collab/` does not exist or has no other active agents, skip this step entirely.
2. Start the run:
!`node "${CLAUDE_PLUGIN_ROOT}/coordinator/index.js" start "$ARGUMENTS"`
3. Read the JSON result from the command output and note:
   - `runId`
   - `currentGroupIndex`
   - `activeStages`
   - `groupSnapshotFile`
4. For each stage in `activeStages`, note:
   - `currentStage`
   - `findingsFile`
   - `findingsQueueFile`
   - `decisionsFile`
   - `metaFile`
   - `verifierFile`
5. Initialize or reuse `decisionsFile` and `verifierFile` for each active stage.
6. Repeat until every active stage satisfies both conditions:
   - `metaFile.auditDone` is `true` and the stage audit succeeded
   - every streamed finding in that stage has a decision
7. In each pass:
   - loop through every active stage
   - read that stage's `metaFile`, `findingsQueueFile`, `decisionsFile`, and `verifierFile`
   - identify findings whose `finding.id` is not already in that stage's `verifierFile.processedFindingIds`
   - for each unprocessed finding:
     - re-read the cited file and nearby live-repo context
     - if the finding is still valid and narrowly fixable, apply the fix immediately
     - if the live repo drifted enough that the finding is stale, reject it with a rationale
     - if the finding is valid but broad, mark it `valid_needs_approval`
   - update that stage's `decisionsFile` and `verifierFile` after each batch
8. Keep each stage `decisionsFile` as JSON:
```json
{
  "stage": "<stage>",
  "decisions": [
    {
      "findingId": "<id>",
      "decision": "valid | invalid | valid_needs_approval",
      "action": "fixed | none",
      "rationale": "why",
      "filesChanged": ["relative/path"],
      "verificationEvidence": "what you checked"
    }
  ]
}
```
9. Keep each stage `verifierFile` as JSON:
```json
{
  "stage": "<stage>",
  "lastConsumedIndex": 0,
  "processedFindingIds": ["<id>"],
  "fixedCount": 0,
  "invalidCount": 0,
  "deferredCount": 0,
  "updatedAt": "<iso timestamp>"
}
```
10. When an active stage has `metaFile.auditDone` true, `metaFile.auditSucceeded` true, and all findings have decisions, run lightweight verification on touched files if you made edits.
11. Complete each finished stage separately:
!`node "${CLAUDE_PLUGIN_ROOT}/coordinator/index.js" complete-stage --run "<runId>" --stage "<currentStage>" [--result accepted|rejected|approval]`
12. After every stage in the active group has been completed, advance the pipeline:
!`node "${CLAUDE_PLUGIN_ROOT}/coordinator/index.js" next --run "<runId>"`
13. If `next` returns another active group, repeat from step 3.
14. When the run reports no next group or `status: completed`, and any fixes were applied during the run, dispatch the `agentwright:verifier` subagent. Pass it a summary of every fix applied: the finding ID, the finding description, the files changed, and what was done. The verifier will confirm that the claimed fixes actually exist, run tests, check for regressions, and flag anything unexpected. If the verifier reports issues, fix them before proceeding.
15. Summarize:
   - stages completed
   - valid findings fixed
   - invalid findings rejected with reasons
   - findings deferred for approval
   - verification result (pass/fail and any issues found)
16. If there are any `valid_needs_approval` findings, present them to the user. For each deferred finding, show: the finding ID, severity, title, the cited file and problem, and your rationale for deferring. Then ask the user which deferred findings they want you to fix, skip, or modify. Do not proceed to implement any deferred finding until the user explicitly approves it.
