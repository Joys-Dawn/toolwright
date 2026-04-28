---
name: audit-reset
description: Explain how to discard an audit run
argument-hint: [run-id]
---

This package stores run state in `.claude/audit-runs/<run-id>/`.

If the user provided a run id:
- explain that resetting means deleting that run directory
- ask for confirmation before doing anything destructive

If the user did not provide a run id:
- explain how to list run ids with `/audit-status` and no arguments
