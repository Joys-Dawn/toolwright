---
name: snapshot
description: Take a manual timewright snapshot of the working tree (overwrites the slot)
allowed-tools: Bash(node *)
---

Capture a fresh snapshot of the working tree at this moment, overwriting any existing snapshot. Use when `/undo` should restore to here — typically because the user's request came in via wrightward/Discord and the `UserPromptSubmit` hook never fired.

!`node ${CLAUDE_PLUGIN_ROOT}/bin/snapshot.js`

Parse the JSON the command prints. On `ok: true`, confirm to the user that the snapshot was captured (mention `createdAt` and `dirtyFileCount` so they know what was preserved). On `ok: false`, surface the `error` field verbatim.
