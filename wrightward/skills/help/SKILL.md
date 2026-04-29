---
name: help
description: Quick reference for multi-agent coordination — MCP tool catalogue, file-coordination skills, Discord routing, when to emit note vs finding vs decision, urgent event types, and etiquette. Use when you are unsure which wrightward tool or skill applies, or need a refresher on coordination rules.
---

# Help — wrightward coordination rulebook

Quick reference for multi-agent coordination. Use when you're unsure which tool or skill applies.

## Messaging (MCP tools)

Agents are addressed by **handle** — a deterministic `<name>-<number>` derived from the session (e.g. `bob-42`). Your own handle appears in your SessionStart context; call `wrightward_whoami` if you need to re-confirm it. Name-only (`bob`) works when unambiguous, else it errors with the live handles listed.

| Goal | Tool | Key parameters |
|---|---|---|
| Know your own handle | `wrightward_whoami` | No args. Returns your handle, session ID, and registration time. |
| Message another agent or reply to the user on Discord | `wrightward_send_message` | `audience`: `"user"` (reply into your own Discord thread so the user can follow inline), `"all"` (Discord broadcast + every agent's inbox), or a peer handle like `"bob-42"` (that agent's thread + inbox). |
| Log an observability entry | `wrightward_send_note` | `kind`: `"note"` (quiet; default), `"finding"` (urgent; broadcasts), or `"decision"` (urgent; broadcasts). `to`: peer handle or `"all"` (default). See "When to emit note/finding/decision" below. |
| Hand off work + release files | `wrightward_send_handoff` | `to`: target handle (e.g. `"bob-42"`, required); `files_unlocked`: files to release |
| Watch a file another agent owns | `wrightward_watch_file` | You get a `file_freed` event when they release it |
| Acknowledge a handoff (notifies the original sender) | `wrightward_ack` | `id`: handoff event id; `decision`: `accepted`, `rejected`, or `dismissed`. Routes the ack at the sender so they see it on their next tool call + in their Discord thread. |
| Check inbox manually | `wrightward_list_inbox` | Returns urgent events only |
| Diagnose bus health | `wrightward_bus_status` | Bridge, lock, pending counts |

Urgent events are **automatically injected** into your context on the next tool call (capped at `BUS_URGENT_INJECTION_CAP`, default 5). You rarely need to call `wrightward_list_inbox`. Each injected line carries the event `id` and an `→` action hint — pass the id verbatim to `wrightward_ack` and follow the hint rather than re-querying.

Tool responses include a `hint` field on success (e.g., "Broadcast to all agents' inboxes") and on actionable errors (e.g., `ackOf … unknown` → "Call wrightward_list_inbox to see live event ids"). Read it before deciding what to do next.

## File coordination (slash-command skills)

- `/wrightward:collab-context` — declare `{ task, files, functions, status }` so other agents see what you're touching. Declared files held 15 min; auto-tracked files (detected from your Edits) held 2 min.
- `/wrightward:collab-release` — release specific files early
- `/wrightward:collab-done` — clear your context entirely

**Never edit `.claude/collab/*` files by hand.** The guard hook blocks it unconditionally. If a claim looks stale, wait 6 min — it may legitimately persist for 15+ min while the other agent works through a plan.

## Discord integration

Messages from a human on Discord arrive as `user_message` events with `meta.source === "discord"`, tagged `(Discord)` in the injected context.

**To reply to Discord**, call `wrightward_send_message` with `audience="user"`. The reply lands inline in your own forum thread (not the broadcast channel) so the user can follow the conversation in context. Plain assistant output is CLI-only and never reaches Discord.

**Long outbound messages auto-split into multiple Discord posts** (continuation marker `↳ (n/N)` on each chunk, code fences balanced across the boundary) — no silent truncation. Keep per-message content focused so the user can follow along: a plan can span chunks, but a one-line ack should not.

Inbound routing:
- Reply in an agent's forum thread → routes to that agent (no `@mention` needed)
- `@agent-<handle>` in broadcast or thread → fans out to the mentioned session(s). Accepts full handles (`@agent-bob-42`) and name-only (`@agent-bob` — resolves if unambiguous, otherwise broadcasts).
- `@agent-all` → broadcasts to every registered agent

**`AskUserQuestion` and `ExitPlanMode` route automatically based on where the user last replied.** When the user's last input came from Discord:
- `AskUserQuestion` is denied at the hook — ask via `wrightward_send_message(audience="user")` instead (the deny reason tells you so).
- `ExitPlanMode` posts the plan to the user's Discord thread and waits up to 5 min for a reply. `approve` / `yes` / `ok` / `lgtm` / `ship it` / `go` / `proceed` / `👍` → allow. Anything else → deny with the user's reply text as feedback. No reply within 5 min → deny with a stop-and-wait message; **do NOT re-present the plan automatically** — wait for the user to say "ask me again" (or similar) before re-calling ExitPlanMode.

When the user's last input came from the CLI, both render natively. The channel toggles automatically every time the user types.

## When to emit note/finding/decision

All three are logged to the bus and mirror to Discord by default (recipient's thread if `to=<handle>`, broadcast channel if `to="all"`). They differ by how loudly they announce themselves:

- **`note`** (non-urgent) — casual observation. Logged for the record; appears on Discord only. Other agents will NOT be auto-notified. Use for running commentary, low-signal FYI, or anything the reader can read-or-skip at their leisure.
- **`finding`** (urgent) — you discovered something others MUST know. Bug, gotcha, surprising behavior, environmental constraint, something that invalidates an assumption. Fans out to every agent's inbox on their next tool call. Use sparingly.
- **`decision`** (urgent) — you made a choice that affects others' work. Picked approach X over Y, ruled out a path, committed to an interface. Same urgency as `finding`.

Reserve `finding` and `decision` for events where acting on stale info would waste an agent's work. When in doubt, use `note`.

## Urgent events (what appears in your inbox)

- `handoff` — work handed to you; acknowledge with `wrightward_ack`
- `user_message` — from a human (CLI or Discord); if from Discord, reply via `wrightward_send_message audience="user"`
- `agent_message` — another agent's message; recipients are in the event's `to` field (`"all"` or a sessionId the bus resolved from a handle)
- `ack` — the recipient of a handoff you sent has accepted/rejected/dismissed it
- `finding` — another agent discovered something you MUST know
- `decision` — another agent made a choice that affects your work
- `file_freed` — a file you watched was released
- `blocker` — another agent is blocked on something
- `delivery_failed` — the bus failed to deliver one of your earlier events

## Etiquette

- **Declare before you write.** Run `/wrightward:collab-context` after planning so other agents don't stomp on files you're about to edit.
- **Release when done.** Use `/wrightward:collab-release` or `/wrightward:collab-done` — don't let claims hold past their usefulness.
- **Acknowledge handoffs.** Call `wrightward_ack` — the sender will see your decision on their next tool call.
- **Be judicious with `finding`/`decision`.** Urgent broadcasts interrupt everyone's attention. Use them when staleness costs work; use `note` otherwise.
