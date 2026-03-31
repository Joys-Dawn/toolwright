---
description: Run the default or named audit pipeline
argument-hint: [pipeline-or-stage-list] [scope]
allowed-tools: Read, Write, Edit, Glob, Grep, Bash(node *), Bash(git *), Bash(npx *), Bash(npm *), Bash(ruff *)
---

Run the audit pipeline and verify/fix findings as they arrive.

Rules:
- If `$ARGUMENTS` is empty, treat scope as `--diff`. Default pipeline: correctness, security, best-practices.
- If the first token is a known pipeline name, use it. If it is a comma-separated stage list, run those stages sequentially. Otherwise treat the full argument string as scope.
- You are the verifier/fixer for the live repo. The auditor runs on a frozen snapshot.
- Never blindly accept auditor claims. Re-read cited code yourself before acting.
- **Fix immediately** when objectively correct (any competent reviewer would agree). This applies to all finding types: bugs, security flaws, naming, dead code, missing error handling.
- **Mark `valid_needs_approval`** when it's a judgment call, large refactor, or meaningful tradeoff. When in doubt, defer.
- If wrightward blocks a write (file contention), skip that finding — do not record a decision for it. It will reappear on the next poll.

Workflow:

1. Start the run:
!`node "${CLAUDE_PLUGIN_ROOT}/coordinator/index.js" start "$ARGUMENTS"`
Note the `runId` from the JSON output.

2. Poll for findings:
!`node "${CLAUDE_PLUGIN_ROOT}/coordinator/index.js" next-finding --run "<runId>"`

3. Handle the response:
   - `"waiting"` — auditor is still running. Pause briefly, then repeat step 2.
   - `"finding"` — re-read the cited file in the **live repo** (not the snapshot). If valid and narrowly fixable, apply the fix, then record your decision:
!`node "${CLAUDE_PLUGIN_ROOT}/coordinator/index.js" record-decision --run "<runId>" --stage "<stage>" --finding "<findingId>" --decision valid --action fixed --rationale "..." --files-changed "file1.js,file2.js"`
     For invalid findings: `--decision invalid --action none --rationale "..."`
     For deferred findings: `--decision valid_needs_approval --action none --rationale "..."`
     Then repeat step 2.
   - `"error"` — a stage audit failed. Report the error and stop.
   - `"done"` — pipeline complete. Proceed to step 4.

4. If any fixes were applied, dispatch the `agentwright:verifier` subagent with a summary of every fix (finding ID, description, files changed, what was done). Do not blindly accept verifier claims — re-read cited code yourself and independently confirm any reported issue is real before acting on it.

5. Present a summary table:

| # | Stage | Finding | File(s) | Decision | Action |
|---|-------|---------|---------|----------|--------|
| 1 | correctness | Unchecked null return from getUser() | auth.js:42 | fixed | Added null guard |

Keep **Finding** and **Action** columns to one short phrase each. After the table, add a **Verifier** section with a one-line result.

6. If `.collab/` exists and other agents are registered, use `/wrightward:collab-done` to release file claims.

7. If any `valid_needs_approval` findings exist, present them to the user with: finding ID, severity, title, cited file and problem, and your rationale for deferring. Wait for explicit approval before implementing any deferred finding.
