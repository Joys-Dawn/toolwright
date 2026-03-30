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
- Never blindly accept claims from subagents (auditor or verifier). They can hallucinate or misread code. Always re-read the cited code yourself and independently confirm a finding or issue is real before acting on it.
- If a stage audit fails, do not complete it. Review the logs or retry instead.
- If wrightward blocks a write because another agent owns the file, skip that finding and continue fixing others. Revisit skipped findings after each pass — you can check `.collab/context/<session-id>.json` files to see if the blocking agent has released the file (removed it from their files list or set status to `done`). If blocked findings remain when the stage audit is otherwise complete, wait and retry periodically. If the files are still unavailable after all other work is done, pause and ask the user to let you know when you can proceed.
- For sequential stages (non-parallel groups), do NOT start the next stage until every valid finding from the current stage is fixed — including any that were blocked by file contention. The next audit must run against a fully fixed codebase.

Deciding what to fix vs. defer:
- **Fix immediately** only when the fix is objectively correct — meaning any competent reviewer would agree it is an improvement with no meaningful tradeoff. This applies to all finding types: bugs, security flaws, naming improvements, dead code removal, missing error handling, and clean-code fixes can all be objectively correct.
- **Mark `valid_needs_approval`** and do not edit code when:
  - The finding involves a judgment call, style preference, or architectural opinion where reasonable people could disagree.
  - The fix requires a large refactor or touches many files.
  - There are meaningful tradeoffs (performance vs. readability, consistency vs. correctness, etc.).
  - You are not fully confident the fix is an unambiguous improvement.
- When in doubt, defer. A false `valid_needs_approval` costs the user a quick review; a wrong auto-applied fix costs them debugging time.

Workflow:
1. Start the run:
!`node "${CLAUDE_PLUGIN_ROOT}/coordinator/index.js" start "$ARGUMENTS"`
2. Read the JSON result from the command output and note:
   - `runId`
   - `currentGroupIndex`
   - `activeStages`
   - `groupSnapshotFile`
3. For each stage in `activeStages`, note:
   - `currentStage`
   - `findingsFile`
   - `findingsQueueFile`
   - `decisionsFile`
   - `metaFile`
   - `verifierFile`
4. Initialize or reuse `decisionsFile` and `verifierFile` for each active stage.
5. Repeat until every active stage satisfies both conditions:
   - `metaFile.auditDone` is `true` and the stage audit succeeded
   - every streamed finding in that stage has a decision
6. In each pass:
   - loop through every active stage
   - read that stage's `metaFile`, `findingsQueueFile`, `decisionsFile`, and `verifierFile`
   - identify findings whose `finding.id` is not already in that stage's `verifierFile.processedFindingIds`
   - for each unprocessed finding:
     - re-read the cited file and nearby live-repo context
     - if the finding is still valid and narrowly fixable, apply the fix immediately
     - if wrightward blocks the write (exit code 2 / file overlap), skip this finding for now and move on — do not mark it as processed yet
     - if the live repo drifted enough that the finding is stale, reject it with a rationale
     - if the finding is valid but broad, mark it `valid_needs_approval`
   - update that stage's `decisionsFile` and `verifierFile` after each batch
7. Keep each stage `decisionsFile` as JSON:
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
8. Keep each stage `verifierFile` as JSON:
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
9. When an active stage has `metaFile.auditDone` true, `metaFile.auditSucceeded` true, and all findings have decisions, run lightweight verification on touched files if you made edits.
10. Complete each finished stage separately:
!`node "${CLAUDE_PLUGIN_ROOT}/coordinator/index.js" complete-stage --run "<runId>" --stage "<currentStage>" [--result accepted|rejected|approval]`
11. After every stage in the active group has been completed, advance the pipeline:
!`node "${CLAUDE_PLUGIN_ROOT}/coordinator/index.js" next --run "<runId>"`
12. If `next` returns another active group, repeat from step 2.
13. When the run reports no next group or `status: completed`, and any fixes were applied during the run, dispatch the `agentwright:verifier` subagent. Pass it a summary of every fix applied: the finding ID, the finding description, the files changed, and what was done. The verifier will confirm that the claimed fixes actually exist, run tests, check for regressions, and flag anything unexpected. **Do not blindly accept the verifier's claims.** When the verifier reports an issue, re-read the cited code yourself and confirm the issue actually exists before acting on it. The verifier is a subagent and can hallucinate or misread code just like the auditor can. Only fix issues you independently confirm are real.
14. Present a concise summary table listing every finding. Each row should show the finding and what was done about it:

```
| # | Stage | Finding | File(s) | Decision | Action |
|---|-------|---------|---------|----------|--------|
| 1 | correctness | Unchecked null return from getUser() | auth.js:42 | fixed | Added null guard |
| 2 | security | SQL string concatenation in query builder | db.js:89 | fixed | Switched to parameterized query |
| 3 | best-practices | Function exceeds 80 lines | handler.js:15 | deferred | Refactor scope — needs approval |
| 4 | correctness | Missing await on async call | utils.js:7 | rejected | Already awaited on line 12 |
```

   Keep the **Finding** and **Action** columns to one short phrase each. After the table, add a **Verifier** section with:
   - A one-line overall result (e.g., "pass — no regressions found" or "1 issue fixed, 1 claim rejected").
   - If the verifier raised issues you confirmed and fixed, list them briefly.
   - If you rejected any verifier claims after re-reading the code, list each rejected claim with a one-line rationale explaining why it was wrong.
15. If `.collab/` exists and other agents are registered, use `/wrightward:collab-done` to release your file claims so other agents are unblocked.
16. If there are any `valid_needs_approval` findings, present them to the user. For each deferred finding, show: the finding ID, severity, title, the cited file and problem, and your rationale for deferring. Then ask the user which deferred findings they want you to fix, skip, or modify. Do not proceed to implement any deferred finding until the user explicitly approves it.
