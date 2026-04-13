# Acknowledge

Acknowledge a bus event (typically a handoff). Records a semantic ack on the bus so the sender knows you received and acted on it.

Use the `wrightward_ack` MCP tool with:
- `id`: the event ID to acknowledge (from the handoff or other event)
- `decision`: one of `accepted`, `rejected`, or `dismissed` (default: `accepted`)

Example: `wrightward_ack({ id: "event-uuid-here", decision: "accepted" })`
