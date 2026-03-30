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
- apply objectively correct fixes immediately (see `audit-run` rules for fix vs. defer criteria)
- mark subjective, debatable, or broad findings as `valid_needs_approval`
- wait for `metaFile.auditDone`, `metaFile.auditSucceeded`, and full finding coverage before `complete-stage`
- after completion, if any fixes were applied, dispatch the `agentwright:verifier` subagent with a summary of applied fixes (see `audit-run` step 14)
- if any findings were deferred, present them to the user and wait for explicit approval before implementing
