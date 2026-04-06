---
name: update-docs
description: Update project documentation (README, architecture docs, setup guides, docstrings) to match current code. Use after code changes or when docs are stale.
argument-hint: [scope — e.g. "README" or "the auth module"]
context: fork
agent: agentwright:update-docs
---

Update project documentation to match the current code. Identify what has drifted from reality, update only what is wrong or missing, and do not rewrite docs that are already accurate. Document what actually exists — no invented APIs or behavior.

Scope:

$ARGUMENTS

If no scope is given, infer from recent changes (`git diff`, `git log`) and update the minimum needed. If nothing is obvious, ask the user before making changes.
