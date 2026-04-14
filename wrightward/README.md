# wrightward

Claude Code plugin for multi-agent file coordination. When multiple Claude Code sessions work in the same repo, wrightward prevents them from silently overwriting each other's work. It tracks which files each agent is touching, blocks conflicting writes, and injects awareness of what other agents are doing.

## Installation

```
/plugin marketplace add Joys-Dawn/toolwright
/plugin install wrightward@Joys-Dawn/toolwright
```

No configuration needed — hooks activate automatically.

## Quick start

1. Open two or more Claude Code sessions in the same repo
2. Work normally — wrightward auto-tracks every file each agent edits or creates
3. If an agent tries to write to a file another agent is working on, the write is blocked
4. For longer claims, run `/wrightward:collab-context` to declare files up front (held for 15 minutes vs 2 minutes for auto-tracked files)
5. Release files early with `/wrightward:collab-release` when you're done with them

## How it works

### Auto-tracking

Every Edit/Write is automatically tracked. No setup required. If `.claude/collab/` doesn't exist yet, the first Edit/Write creates it. Auto-tracked files are held for **2 minutes** from the last touch — short enough to expire quickly when the agent moves on.

### Declared files

Running `/wrightward:collab-context` lets an agent declare files up front with a task description. Declared files are held for **15 minutes**, with automatic extension if the agent is still actively editing near the deadline. Best used after planning, when the agent knows which files it will touch.

### Guard (conflict prevention)

Before every tool call, wrightward checks for conflicts:

- **Read/Glob/Grep on another agent's files** — non-blocking context injected (who owns it, what they're doing)
- **Write to another agent's file** — blocked, agent sees who owns it
- **Write to an unrelated file** — proceeds with awareness of other active agents
- **Solo agent** — everything proceeds silently with zero overhead

Context injection is deduplicated — the same summary is only shown once per change in other agents' state.

### Collab state is off-limits to the model

Edit/Write on any file inside `.claude/collab/` is hard-blocked unconditionally — whether or not other agents are active. This prevents an agent from bypassing the coordination system by directly editing `agents.json` or another agent's context file (e.g., to remove what it perceives as a "stale" claim). Collab state is managed exclusively by the wrightward skills and hooks. Read access is not blocked — agents can still inspect their own state for debugging.

If an agent believes another agent's claim is stale, the instructions in every collab skill tell it to **wait 6 minutes and try again**. After 6 minutes of no heartbeat, a crashed or abandoned session is automatically excluded from the active set, and its claims stop enforcing. If the claim is still enforced after 6 minutes, the other agent is alive — the claim is legitimate, not stale, and agents are explicitly instructed never to bypass it. Claims declared through `/wrightward:collab-context` can persist for 15 minutes or longer while the other agent works through a plan.

### Idle reminders

If an agent hasn't touched a file in **5 minutes**, a one-time reminder suggests releasing it. This nudges agents to free files they've moved on from without waiting for the timeout.

## Message bus (v3.0)

On top of file coordination, wrightward runs a file-based peer-to-peer message bus so sessions can hand off work, watch files, and notify each other.

- Events are appended to `.claude/collab/bus.jsonl` and fanned out to the target session via an injected context block on the next tool call (Path 1).
- Per-session delivery bookmarks in `.claude/collab/bus-delivered/<sessionId>.json` track what each session has already seen.
- A bundled MCP server (`wrightward-bus`) exposes six tools — `wrightward_list_inbox`, `wrightward_ack`, `wrightward_send_note`, `wrightward_send_handoff`, `wrightward_watch_file`, `wrightward_bus_status` — wrapped by four skills: `/wrightward:inbox`, `/wrightward:ack`, `/wrightward:handoff`, `/wrightward:watch`.

No daemon, no IPC, no CLI — every agent is a filesystem reader/writer. The bus is strictly additive: with an older Claude Code or the MCP server disabled, file coordination still works exactly as before.

## Channel push — wake idle sessions (v3.1, research preview)

By default, peer messages surface on a session's next tool call. If you want idle sessions to wake between turns — without a new user prompt — launch Claude Code with the `--channels` flag. wrightward's MCP server emits a single summary `notifications/claude/channel` (the **doorbell**) when urgent events arrive; the woken session's next tool call then runs Path 1, which injects the full event content as additional context.

```
claude --channels plugin:wrightward@<marketplace>
```

Path 1 (next-tool-call injection) remains the source of truth for event content — the doorbell just wakes the session earlier. If channels are unsupported or the notification is silently dropped (a known Claude Code issue on some platforms), the plugin still works: the user's next interaction surfaces the event via Path 1, as in the default behavior.

### Allowlist / dev-mode workaround

The `--channels` flag requires the plugin to be on the Claude Code channel allowlist. Until wrightward is allowlisted, use the development flag:

```
claude --dangerously-load-development-channels plugin:wrightward@<marketplace>
```

### Launching from VS Code / Cursor

The Claude Code VS Code / Cursor extension has no direct "extra CLI args" setting, but it supports [`claudeCode.claudeProcessWrapper`](https://code.claude.com/docs/en/vs-code) — an "Executable path used to launch the Claude process." Point it at a shim that prepends the flag and forwards the remaining args.

**Windows — `claude-dev.cmd`:**
```cmd
@echo off
claude --dangerously-load-development-channels plugin:wrightward@<marketplace> %*
```

**POSIX — `claude-dev.sh`:**
```sh
#!/usr/bin/env sh
exec claude --dangerously-load-development-channels plugin:wrightward@<marketplace> "$@"
```

Then in VS Code / Cursor `settings.json`:

```json
{
  "claudeCode.claudeProcessWrapper": "C:\\Users\\<you>\\bin\\claude-dev.cmd"
}
```

Use the wrapper only while actively testing channels — otherwise every session unnecessarily loads dev-mode channels.

## Skills

| Skill | Description |
|-------|-------------|
| `/wrightward:collab-context` | Declare or update the current task and claimed files (`+` create, `~` modify, `-` delete) |
| `/wrightward:collab-release` | Release specific files so other agents can work on them immediately |
| `/wrightward:collab-done` | Release all file claims and exit coordination |
| `/wrightward:inbox` | List pending urgent messages from other agents |
| `/wrightward:ack` | Acknowledge a handoff or other urgent event |
| `/wrightward:handoff` | Hand a task off to another agent, releasing listed files |
| `/wrightward:watch` | Register interest in a file — get notified when it frees up |

## Hooks

Six hooks run automatically — no user intervention needed:

| Hook | Trigger | What it does |
|------|---------|--------------|
| `register.js` | Session start | Registers the agent in `.claude/collab/agents.json` |
| `heartbeat.js` | After every tool call | Updates heartbeat, auto-tracks files, runs scavenging, fires idle reminders |
| `guard.js` | Before Edit/Write/Read/Glob/Grep | Blocks conflicting writes, injects awareness context |
| `bash-allow.js` | Before Bash | Auto-approves wrightward's own script invocations (workaround for [claude-code#11932](https://github.com/anthropics/claude-code/issues/11932)) |
| `plan-exit.js` | After exiting plan mode | Reminds the agent to declare files (only when other agents are active) |
| `cleanup.js` | Session end | Deregisters the agent and releases all claims |

## Recommended permissions

Add these to your global `~/.claude/settings.json` to avoid the "Use skill?" consent dialog on every skill invocation:

```json
{
  "permissions": {
    "allow": [
      "Skill(wrightward:collab-context)",
      "Skill(wrightward:collab-done)",
      "Skill(wrightward:collab-release)"
    ]
  }
}
```

## Configuration

Create `.claude/wrightward.json` in your project to override timeout defaults. All fields are optional — only include what you want to change. Values are in **minutes**. See [wrightward.example.json](wrightward.example.json) for the full list.

```json
{
  "PLANNED_FILE_TIMEOUT_MIN": 15,
  "AUTO_TRACKED_FILE_TIMEOUT_MIN": 2,
  "REMINDER_IDLE_MIN": 5,
  "AUTO_TRACK": true
}
```

| Key | Default | Description |
|-----|---------|-------------|
| `ENABLED` | true | Master switch — when false, all hooks exit immediately |
| `PLANNED_FILE_TIMEOUT_MIN` | 15 | How long declared files are held |
| `PLANNED_FILE_GRACE_MIN` | 2 | Extends the timeout if the file was touched within this window before expiry |
| `AUTO_TRACKED_FILE_TIMEOUT_MIN` | 2 | How long auto-tracked files are held (from last touch) |
| `REMINDER_IDLE_MIN` | 5 | How long a file must be idle before the release reminder |
| `INACTIVE_THRESHOLD_MIN` | 6 | How long before a session is considered stale |
| `SESSION_HARD_SCAVENGE_MIN` | 60 | Hard cleanup for truly dead sessions |
| `AUTO_TRACK` | true | Whether Edit/Write auto-creates a context when none has been declared. When false, files are still tracked into an existing context but no new context is created automatically |

## Disabling in a repo

Set `ENABLED` to `false` in `.claude/wrightward.json` to fully disable wrightward in a repo. All hooks exit immediately — no registration, no tracking, no blocking.

```json
{ "ENABLED": false }
```

## State

All coordination state lives in `.claude/collab/` (auto-gitignored). No state persists between sessions.

## Requirements

- Node.js >= 18
- One runtime dependency: `@modelcontextprotocol/sdk` (required for the bundled MCP server; bundled with the plugin's `node_modules/`)
- Cross-platform (Windows + Unix)

## License

Apache-2.0
