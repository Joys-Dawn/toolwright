---
name: help
description: List all mindwright skills and their one-line descriptions.
---

# /mindwright:help

Skills:

- `/mindwright:setup` — one-time model download + smoke test.
- `/mindwright:status` — store sizes, last consolidation, daemon liveness.
- `/mindwright:recall <query>` — explicit retrieval.
- `/mindwright:retain` — save a fact directly.
- `/mindwright:forget <fact_id>` — soft-archive a fact.
- `/mindwright:restore <fact_id>` — undo a forget (flip `active=1` back).
- `/mindwright:update-memory <fact_id>` — supersede a fact with a new version.
- `/mindwright:resolve-contradiction <a> <b>` — pick / merge / scope two contradictory facts.
- `/mindwright:dream` — consolidate short-term into long-term.
- `/mindwright:seed-from-repo` — bootstrap from repo files.
- `/mindwright:assign-role <session> <role>` — attach a role tag.
- `/mindwright:unassign-role <session> <role>` — detach a role tag.
- `/mindwright:reset` — destructive DB drop.

See `DESIGN.md` for architecture and `README.md` for the steady-state flow.
