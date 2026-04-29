---
name: audit-step
description: Run a single audit stage
argument-hint: [stage] [scope]
---

Run a one-stage audit pipeline using the provided stage and scope.

Interpret the first token of `$ARGUMENTS` as the stage and the remaining text as the scope. If the scope is missing, use `--diff`. Scope tokens: `--diff` (changed lines vs HEAD), `--all` (entire repo), or paths/files (targeted).

**Run all `coordinator/index.js` commands from the project root** — the same cwd where you started the stage. The run directory is located at `<cwd>/.claude/audit-runs/<runId>/` by relative path; running from a subdirectory or a different repo will fail with a "run not found" style error rather than a real audit failure.

1. Start the stage:
!`node ${CLAUDE_PLUGIN_ROOT}/coordinator/index.js start-stage $ARGUMENTS`
Note the `runId` from the JSON output.

2. Follow the same wait-and-fetch loop as `audit-run`:
   - Call `next-finding --run <runId> --wait` (pass `timeout=600000` to Bash). The command blocks internally until a finding lands, the stage errors, or it finishes.
   - On `"waiting"`, repeat the same call (auditor is still working).
   - On `"finding"`, follow `audit-run`'s verification process exactly (Steps A–D): locate the code, try to contradict the finding, critically reason through whether it's a real issue, then decide.
   - Call `record-decision` for each finding.
   - Repeat until `"done"` or `"error"`. **Do NOT stop after recording the last finding's decision — keep polling until you explicitly receive a `"done"` response.** On `"error"`, run `node ${CLAUDE_PLUGIN_ROOT}/coordinator/index.js status <runId>` to confirm before treating the stage as crashed: a coordinator-level error (wrong cwd, bad args, unknown finding-id) is recoverable by re-running the same command correctly, while a real stage failure shows up in `status`.

3. Apply the same fix vs. defer rules as `audit-run`:
   - **Fix immediately** when objectively correct
   - **Mark `valid_needs_approval`** for judgment calls or large refactors
   - **Behavior-audit findings (stage `behavior`): defer only when fixing the finding would directly reverse something the user explicitly asked for.** Read the conversation context and the original request. Only mark `valid_needs_approval` when the auditor is flagging the exact behavior the user explicitly requested — only the user can revise their own request. Otherwise apply the normal fix-vs-defer rules; loose or incidental relation to a feature the user requested is not enough to defer.
   - Skip file-contention-blocked findings (they reappear on next poll)

4. After completion, if any fixes were applied, dispatch the `agentwright:verifier` subagent. Do not blindly accept verifier claims.

5. Present a concise per-finding summary table (see `audit-run` for format).

6. If any findings were deferred, present them to the user and wait for explicit approval.
