---
description: Run a single audit stage
argument-hint: [stage] [scope]
allowed-tools: Read, Write, Edit, Glob, Grep, Bash(node:*), Bash(git:*), Bash(npx:*), Bash(npm:*), Bash(ruff:*)
---

Run a one-stage audit pipeline using the provided stage and scope.

Interpret the first token of `$ARGUMENTS` as the stage and the remaining text as the scope. If the scope is missing, use `--diff`.

Equivalent coordinator call shape:
!`node "${CLAUDE_PLUGIN_ROOT}/coordinator/index.js" start-stage "$ARGUMENTS"`

Then follow the same streamed verifier/fixer workflow used by `audit-run` for that single stage only:
- consume `findingsQueueFile` incrementally
- verify each finding against the live repo as it arrives
- apply objectively correct fixes immediately (see `audit-run` rules for fix vs. defer criteria and file contention handling)
- mark subjective, debatable, or broad findings as `valid_needs_approval`
- wait for `metaFile.auditDone`, `metaFile.auditSucceeded`, and full finding coverage before `complete-stage`
- after completion, if any fixes were applied, dispatch the `agentwright:verifier` subagent with a summary of applied fixes (see `audit-run` step 14). Do not blindly accept the verifier's claims — re-read cited code yourself and independently confirm any reported issue is real before acting on it.
- present the final summary as a concise per-finding table (see `audit-run` step 15 for format)
- if any findings were deferred, present them to the user and wait for explicit approval before implementing
