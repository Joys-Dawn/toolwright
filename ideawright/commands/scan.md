---
description: Run signal miners (Reddit, HN, GitHub + arXiv, bioRxiv, PubMed) to populate new ideas
allowed-tools: Bash(node *)
---

Run the miner pipeline.

!`node ${CLAUDE_PLUGIN_ROOT}/scripts/ideawright.mjs scan`

Miner module (A) is under construction. If the command exits with a "module not yet built" error, report that cleanly — do not fall back to alternate implementations.

On success, show the user:

- How many ideas were newly inserted (reported by the runner)
- Which sources contributed
- Suggest `/ideawright:vet` to score novelty on the new rows.
