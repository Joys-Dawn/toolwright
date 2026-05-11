---
name: collab-context
description: Use when working in a multi-agent codebase and you need to declare or update what files and functions you are working on so other agents can see your claims and avoid conflicts.
allowed-tools: Bash(node *)
---

Declare or update what you're currently working on for multi-agent awareness.

## Where this fits

This skill is the **file-claim** piece of wrightward's multi-agent coordination. Two other layers are available alongside it:

- **Messaging the bus** — talk to peer agents (or reply to the user on Discord) with MCP tools: `wrightward_send_message` (peer-to-peer or Discord reply), `wrightward_send_note` (note / finding / decision broadcasts), `wrightward_send_handoff` (give work to another session), `wrightward_ack` (acknowledge a handoff), `wrightward_watch_file` (be notified when a file frees), `wrightward_list_inbox` / `wrightward_whoami` / `wrightward_bus_status`. Peers are addressed by handle — `<name>-<number>` (e.g. `bob-42`); your own is in your SessionStart context or via `wrightward_whoami`.
- **Wrapper skills** — `/wrightward:handoff`, `/wrightward:ack`, `/wrightward:watch`, `/wrightward:inbox` wrap the bus tools. `/wrightward:collab-release` and `/wrightward:collab-done` complement this skill on the file-claim side.

For the full rulebook — event types, when to emit `note` vs `finding` vs `decision`, Discord thread routing, and etiquette — call `/wrightward:help`. Urgent events from other agents are auto-delivered to your context via the channel doorbell (between turns, when channels are enabled) or on your next tool call; you rarely need to poll.

**CRITICAL RULE — NEVER EDIT COLLAB FILES DIRECTLY.** Files in `.claude/collab/` (including `agents.json`, `context/*.json`, and any other files in that directory) are managed by wrightward. You must NEVER use Edit, Write, Bash, or any other tool to modify, delete, or remove these files — not to update your own state, not to release your own claims, and absolutely not to remove another agent's claims. Doing so is a security violation. Your only interface to collab state is through the wrightward skills (`/wrightward:collab-context`, `/wrightward:collab-release`, `/wrightward:collab-done`).

**If your write is blocked by another agent's claim:** don't bypass and don't passively wait. The guard hook does two things for you automatically under the same lock:

1. **Registers your interest** in the file — a `file_freed` event will be delivered to you the moment the holder releases.
2. **Emits a `blocker` event to the holder** — they see your handle, the file, and a prompt to reply with whether/when they can free it (or hand it off). You do NOT need to ping them yourself for the common case.

So: **move on to other work**. The wake-up (`file_freed` when the file frees, or an `agent_message` reply from the holder) arrives via one of two paths:
- **Channel doorbell** — if channels are enabled (plain CLI, not IDE extension), the session is pinged between turns so the event surfaces within seconds.
- **On your next tool call** — the always-on Path 1, used as a fallback when channels aren't delivering.

Only message the holder manually with `wrightward_send_message(audience="<their-handle>", …)` if you need to clarify scope or timing beyond what the auto-blocker conveys — don't pile on the same agent with duplicate pings. If you have an actual known timing (e.g., you watched a peer kick off a 5-minute script), `ScheduleWakeup` lets you resume at a chosen delay instead of guessing — but for routine file-claim waits, the channel + auto-blocker combo handles it.

If nothing happens after a reasonable interval — no reply, no `file_freed` — escalate to the user instead of retrying writes against an enforced lock. The system also auto-scavenges crashed sessions after 6 min of no heartbeat, so genuinely-dead claims clear themselves. A claim still enforced past that window means the holder is alive; declared claims can legitimately persist for 15+ minutes while the other agent works through a plan. Never edit `.claude/collab/*` to remove the claim — it's hard-blocked and is a security violation.

Run the bundled collab script with a JSON payload on stdin. Do not use Edit or Write for this — use the Bash tool only.

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/context.js --session-id '${CLAUDE_SESSION_ID}' <<'EOF'
{
  "task": "...",
  "files": ["..."],
  "functions": ["..."],
  "status": "in-progress"
}
EOF
```

**Payload schema:**

```json
{
  "task": "One-line description of current work",
  "files": ["+src/new.ts", "~src/existing.ts", "-src/old.ts"],
  "functions": ["+newFunc", "~modifiedFunc", "-removedFunc"],
  "status": "in-progress"
}
```

**Fields:**

- **task**: Concise one-line description of what you are doing.
- **files**: Paths you are certain you will touch. Prefix: `+` creating, `~` modifying, `-` deleting. Only declare files you are 100% sure about — if you end up touching other files via Edit or Write, they will be automatically added to your context while other agents are active.
- **functions**: Functions you are touching. Same prefix convention.
- **status**: `"in-progress"` while working, `"done"` when finished.

**When to use:** Best used after a plan has been made (e.g., after using plan mode or agentwright's feature planning skill), since you'll have a clear picture of which files and functions you'll touch.

**Timeout behavior:**

- **Declared files** (listed here): Held for 15 minutes. If you're still actively editing a file near the end of that window, the claim extends automatically.
- **Auto-tracked files** (detected from your Edit/Write calls without being declared here): Held for only 2 minutes from your last touch. These are lightweight claims that expire quickly.
- **Idle reminders**: If you haven't touched a file in 5 minutes, you'll get a one-time reminder to consider releasing it.
- **Early release**: Use `/wrightward:collab-release` to release files immediately when you're done with them, instead of waiting for the timeout.

**Instructions:**

1. Assess what you're currently working on
2. Build a JSON payload matching the schema
3. Run the Bash command above with the payload on stdin
4. If the script fails, explain the error plainly
5. Update your context whenever your focus shifts significantly (new task, different files, etc.)
6. Release files you no longer need with `/wrightward:collab-release`
