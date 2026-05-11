---
name: workflow-stop
description: Cancel a running forgewright workflow and signal in-flight peers to abort. Use when the user wants to abandon an in-progress workflow.
argument-hint: <workflow-id>
---

Cancel a forgewright workflow.

Important: workflow-stop only halts the LEADER coordinator. Peers that received `wrightward_send_handoff` calls for this workflow keep executing unless you signal them. The coordinator's cancellation write is local and atomic (microseconds), so the broadcast lands within the same window whether you run it before or after — and gating the broadcast on the coordinator response means you do not spam peers when stopping an already-terminal workflow.

Step 1 — run the coordinator stop:

!`node ${CLAUDE_PLUGIN_ROOT}/coordinator/index.js workflow-stop --workflow $ARGUMENTS`

Step 2 — inspect the JSON output:
- If `broadcastNeeded` is `true`, the workflow had an active state and possible in-flight peer handoffs. Broadcast once:

  wrightward_send_message(
    audience="all",
    body="workflow $ARGUMENTS cancelled — if you have an unacked handoff whose task_ref starts with $ARGUMENTS, abort the task, do not commit further edits, ack with status=cancelled."
  )

- If `broadcastNeeded` is `false` (workflow was already terminal — completed/cancelled/failed), skip the broadcast. There are no in-flight handoffs to abort.

Step 3 — report the JSON result to the user. The coordinator marks the workflow `cancelled`. Pipeline-phase snapshots are managed by the LLM driving `/agentwright:audit-run` (cleanup happens inside that flow), and any leftovers get swept by agentwright's own orphan-snapshot cleanup the next time it runs. When a broadcast was sent, tell the user that the peer cancel signal is best-effort — peers may not see it until their next wrightward poll, and any edits already in progress before the broadcast can still land.
