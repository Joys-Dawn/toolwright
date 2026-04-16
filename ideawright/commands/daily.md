---
description: Full pipeline — scan miners, vet novelty, gate feasibility, rank, emit digest
allowed-tools: Bash(node *)
---

Run the end-to-end ideawright pipeline.

!`node ${CLAUDE_PLUGIN_ROOT}/scripts/ideawright.mjs daily`

Report results to the user: a final summary of the top-N promoted ideas with titles, target users, and composite ranks. If any stage reports "module not yet built", flag which one and stop.
