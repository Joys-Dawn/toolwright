---
description: Show ideawright pipeline status and top-ranked ideas
allowed-tools: Bash(node *)
---

Run the status command and summarize for the user.

!`node ${CLAUDE_PLUGIN_ROOT}/scripts/ideawright.mjs status`

Present the result as:

1. A one-line summary of counts across the lifecycle: new → scored → verified → gated → promoted → archived.
2. Top-promoted ideas as a numbered list: title, target user, composite rank, novelty verdict, feasibility verdict.
3. If every count is zero, suggest running `/ideawright:scan` to populate signals.
4. If there are verified ideas but nothing promoted, suggest running `/ideawright:daily` to complete feasibility + ranking.
