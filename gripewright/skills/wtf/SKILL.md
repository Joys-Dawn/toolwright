---
name: wtf
description: Log the previous agent turn(s) as a labeled gripe (negative training example). Use when the user invokes /gripewright:wtf to flag recent assistant behavior as a shortcut, dismissal, hack, or otherwise wrong-headed move.
allowed-tools: Bash(node *)
argument-hint: [N turns back] [optional reason]
---

!`node ${CLAUDE_PLUGIN_ROOT}/scripts/log-wtf.js ${CLAUDE_SESSION_ID} $ARGUMENTS`

Confirm in one short sentence that the gripe was logged (events captured, log path). Then engage with the user's reason — address their critique directly if they gave one, or briefly reflect on what likely went wrong in the prior turn if they didn't. If the script reported an error, surface it verbatim.
