---
description: Run novelty verification on new ideas
allowed-tools: Bash(node *)
---

Run the novelty pass against status=new ideas.

!`node ${CLAUDE_PLUGIN_ROOT}/scripts/ideawright.mjs vet`

Novelty module (B) is under construction. If the command reports "module not yet built", surface that cleanly.

On success, show the user:

- How many ideas advanced to `scored`
- Split across `novel` / `niche` / `crowded`
- How many were archived directly
- Suggest `/ideawright:daily` for the full feasibility + ranking pass.
