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
- Never blindly accept auditor claims. Re-read cited code yourself and **reason about whether the finding is actually a real problem**. Seeing that the code matches what the auditor described is not enough — you must independently judge whether the described behavior is actually wrong. Think about the logic, the context, edge cases, and whether the "fix" would truly improve correctness or safety.
- **Fix immediately** when objectively correct (any competent reviewer would agree). This applies to all finding types: bugs, security flaws, naming, dead code, missing error handling, and best-practice refactors that are clearly valid improvements (e.g., replacing a brittle pattern with the idiomatic one, extracting duplicated logic, adding missing validation). Do not defer a refactor just because it is a refactor — defer it only if it involves a meaningful tradeoff or is large enough to risk regressions.
- **Mark `valid_needs_approval`** when it's a genuine judgment call, a large-scale refactor that touches many files, or a meaningful tradeoff where reasonable reviewers could disagree. When in doubt, defer.
- If wrightward blocks a write (file contention), skip that finding — do not record a decision for it. It will reappear on the next poll.
- If a finding references a file **outside** the audit scope, do not ignore it. Mark it `valid_needs_approval` and present it to the user at the end with the other deferred findings.

Workflow:

1. Start the run (output includes the runId):
!`node ${CLAUDE_PLUGIN_ROOT}/coordinator/index.js start $ARGUMENTS`

2. Wait 60 seconds for the auditor to start producing findings:
`sleep 60`

3. Poll for findings using the runId from step 1:
`node ${CLAUDE_PLUGIN_ROOT}/coordinator/index.js next-finding --run <runId>`

4. Handle the response:
   - `"waiting"` — auditor is still running. `sleep 60`, then repeat step 3. The auditor often needs several minutes of reading and thinking before emitting its first finding — this is normal. Keep polling every 60 seconds; do not shorten or lengthen the interval, do not check logs, just loop.
   - `"finding"` — verify the finding before acting on it. Follow these steps in order:

     **Step A — Locate**: Read the cited file and lines in the **live repo** (not the snapshot). Also read surrounding context (±30 lines) and any related files the code interacts with (callers, callees, types, tests).

     **Step B — Contradict**: Try to disprove the finding. Actively look for reasons it might be wrong:
     - Is the issue already handled elsewhere? (a parent component, a middleware, a wrapper, a try/catch higher up)
     - Did the auditor misread the code? (wrong variable, wrong branch, outdated line numbers from snapshot vs live)
     - Is there a comment, test, or doc explaining why the code is intentionally written this way?
     - Does the surrounding code make the "problem" unreachable or irrelevant?

     **Step C — Reason through validity**: Confirming the code matches what the auditor described is NOT enough. You must independently judge whether it is actually a problem:
     - **Correctness**: Is the behavior actually wrong, or is it intended? Think about the design intent, edge cases, and whether the "fix" could break something that currently works.
     - **Security**: Is this truly exploitable in practice, or is it a theoretical risk that requires conditions that will never occur? (e.g., the attacker would need server access they already wouldn't have)
     - **Best practices**: Does this violate a real industry standard (DRY, SOLID, KISS, YAGNI, Clean Code) in a way that causes measurable harm (maintenance burden, bug risk, readability), or is it nitpicking / style preference?
     - **UI/Accessibility**: Does this actually affect users, or is the auditor applying a standard that doesn't apply to this platform or context?

     **Step D — Decide**:
     - If you found a contradiction in Step B or the reasoning in Step C shows it's not a real issue → `invalid`
     - If it's a valid issue and narrowly fixable → fix it, then record `valid` with `--action fixed`
     - If it's valid but involves a tradeoff, is large-scale, or you're not fully confident → `valid_needs_approval`

     Your rationale must reflect the reasoning from Steps B and C — not just "auditor is correct" or "code matches description."

`node ${CLAUDE_PLUGIN_ROOT}/coordinator/index.js record-decision --run <runId> --stage <stage> --finding <findingId> --decision valid --action fixed --rationale <why> --files-changed <file1.js,file2.js>`
     For invalid findings: `--decision invalid --action none --rationale <why>`
     For deferred findings: `--decision valid_needs_approval --action none --rationale <why>`
     Then repeat step 3.
   - `"error"` — a stage audit failed. Report the error and stop.
   - `"done"` — pipeline complete. Proceed to step 4.

5. If any fixes were applied, dispatch the `agentwright:verifier` subagent with a summary of every fix (finding ID, description, files changed, what was done). Tell the verifier to compare against the group-0 snapshot directory (its path is in `group-0-snapshot.json` under the run directory) rather than using `git diff`, so it only sees audit-introduced changes. Do not blindly accept verifier claims — re-read cited code yourself and independently confirm any reported issue is real before acting on it. After the verifier completes, clean up the group-0 snapshot:
`node ${CLAUDE_PLUGIN_ROOT}/coordinator/index.js cleanup-snapshot --run <runId> --group 0`

6. Present a summary table:

| # | Stage | Finding | File(s) | Decision | Action |
|---|-------|---------|---------|----------|--------|
| 1 | correctness | Unchecked null return from getUser() | auth.js:42 | fixed | Added null guard |

Keep **Finding** and **Action** columns to one short phrase each. After the table, add a **Verifier** section with a one-line result.

7. If `.claude/collab/` exists and other agents are registered, use `/wrightward:collab-done` to release file claims.

8. If any `valid_needs_approval` findings exist, present them to the user with: finding ID, severity, title, cited file and problem, and your rationale for deferring. Wait for explicit approval before implementing any deferred finding.
