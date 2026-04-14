# wrightward

Claude Code plugin for multi-agent coordination. When multiple Claude Code sessions work in the same repo, wrightward prevents them from silently overwriting each other's work and gives them a peer-to-peer message bus to hand off tasks, watch files, and wake each other up.

- **File conflict prevention** — auto-tracks Edits/Writes; blocks overlapping writes with a summary of who owns the file.
- **Awareness context** — injects short summaries of other agents' active work into the guard hook's output.
- **Message bus** — six MCP tools for sending notes, handoffs, file-watch registrations, and inbox checks between sessions.
- **Channel push** (research preview) — optional wake-up `notifications/claude/channel` ping when an idle session receives an urgent bus event.
- **Zero network I/O** — all state is local files in `.claude/collab/` (auto-gitignored). No daemon, no IPC, no external services.

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

Edit/Write on any file inside `.claude/collab/` is hard-blocked unconditionally — whether or not other agents are active (and the block tells the model to NOT use Bash to get around this). This prevents an agent from bypassing the coordination system by directly editing `agents.json` or another agent's context file (e.g., to remove what it perceives as a "stale" claim). Collab state is managed exclusively by the wrightward skills and hooks. Read access is not blocked — agents can still inspect their own state for debugging.

If an agent believes another agent's claim is stale, the instructions in every collab skill tell it to **wait 6 minutes and try again**. After 6 minutes of no heartbeat, a crashed or abandoned session is automatically excluded from the active set, and its claims stop enforcing. If the claim is still enforced after 6 minutes, the other agent is alive — the claim is legitimate, not stale, and agents are explicitly instructed never to bypass it. Claims declared through `/wrightward:collab-context` can persist for 15 minutes or longer while the other agent works through a plan.

### Idle reminders

If an agent hasn't touched a file in **5 minutes**, a one-time reminder suggests releasing it. This nudges agents to free files they've moved on from without waiting for the timeout.

## Message bus (v3.0)

On top of file coordination, wrightward runs a file-based peer-to-peer message bus so sessions can hand off work, watch files, and notify each other.

- Events are appended to `.claude/collab/bus.jsonl` (append-only, length-bounded, self-compacting).
- Per-session delivery bookmarks in `.claude/collab/bus-delivered/<sessionId>.json` track what each session has already seen.
- Urgent events are delivered via **Path 1** — the guard/heartbeat hooks inject pending events as `additionalContext` on the session's next tool call, then advance the bookmark. This is the sole source of truth for event delivery.
- A bundled MCP server (`wrightward-bus`) exposes six tools for the model to use directly.

### MCP tools

| Tool | Description |
|------|-------------|
| `wrightward_list_inbox` | List urgent events targeted at this session. Advances the delivery bookmark by default. |
| `wrightward_ack` | Acknowledge a handoff or other urgent event (`accepted` / `rejected` / `dismissed`). |
| `wrightward_send_note` | Send a non-urgent info message to another session, `"all"`, or `"role:<name>"`. |
| `wrightward_send_handoff` | Hand work off to another session. Optionally releases files in the same atomic step. |
| `wrightward_watch_file` | Register interest in a file — the sender is notified when it frees up. |
| `wrightward_bus_status` | Diagnostic: event counts, bookmark positions, recent activity. |

### Skill wrappers

Four skills wrap the MCP tools for conversational use (`/wrightward:inbox`, `/wrightward:ack`, `/wrightward:handoff`, `/wrightward:watch`). Skills also run independently of the MCP server — if the MCP server is disabled, the skills still work via bundled bash scripts.

No daemon, no IPC, no CLI. Every agent is a filesystem reader/writer coordinated by an OS-level advisory file lock. The bus is strictly additive: if the MCP server is disabled (`BUS_ENABLED: false`), file coordination still works unchanged.

## Channel push — wake idle sessions (v3.1, research preview)

By default, peer messages surface on a session's next tool call (Path 1). Channels add **Path 2**: a single `notifications/claude/channel` wake-up ping so an idle session notices new events between turns without a new user prompt. The doorbell writes no state and delivers no payload — it just says "you have N pending events". The woken session's next tool call runs Path 1 as usual and injects the actual event content.

**Path 1 is always-on and authoritative.** Path 2 is a best-effort wake-up signal. If the channel notification is dropped (known Claude Code bugs on some platforms) or the subsystem is disabled, Path 1 still delivers on the next interaction — the user's experience degrades to "wake up on your next message" instead of "wake up immediately".

### Launching with channels

The plugin form `--channels plugin:wrightward@<marketplace>` requires wrightward to be on Anthropic's approved channel allowlist. Until it's approved, use the `server:` form instead — [Anthropic's documented workflow](https://code.claude.com/docs/en/channels-reference#test-during-the-research-preview) for plugin-developer channels:

1. **Add the server to your user-level MCP config** (`~/.mcp.json`):

    ```json
    {
      "mcpServers": {
        "wrightward-bus": {
          "type": "stdio",
          "command": "node",
          "args": ["/absolute/path/to/.claude/plugins/cache/<marketplace>/wrightward/<version>/mcp/server.mjs"]
        }
      }
    }
    ```

2. **Launch Claude Code with the development flag:**

    ```
    claude --dangerously-load-development-channels server:wrightward-bus
    ```

The expected banner reads *"Listening for channel messages from: server:wrightward-bus"*. If you instead see "not on the approved channels allowlist", you used the `plugin:` form — switch to `server:` as above.

Once the plugin is on Anthropic's allowlist, the `--channels plugin:wrightward@<marketplace>` form will work without the `server:` workaround and without the dev flag.

### Launching from VS Code / Cursor

The Claude Code VS Code / Cursor extension supports [`claudeCode.claudeProcessWrapper`](https://code.claude.com/docs/en/vs-code) — an executable that wraps the `claude` binary and can prepend CLI args.

**Windows — `claude-dev.cmd`:**
```cmd
@echo off
claude --dangerously-load-development-channels server:wrightward-bus %*
```

**POSIX — `claude-dev.sh`:**
```sh
#!/usr/bin/env sh
exec claude --dangerously-load-development-channels server:wrightward-bus "$@"
```

Then in `settings.json`:
```json
{ "claudeCode.claudeProcessWrapper": "C:\\Users\\<you>\\bin\\claude-dev.cmd" }
```

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

Add these to your global `~/.claude/settings.json` to skip consent dialogs on wrightward's skills and MCP tools:

```json
{
  "permissions": {
    "allow": [
      "Skill(wrightward:collab-context)",
      "Skill(wrightward:collab-done)",
      "Skill(wrightward:collab-release)",
      "mcp__wrightward-bus__*"
    ]
  }
}
```

The `mcp__wrightward-bus__*` entry auto-allows every wrightward MCP tool. This is important when using Channels: after a wake-up ping, the model typically calls `wrightward_list_inbox` immediately — if that call hits a permission prompt, the wake-up flow stalls.

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

## Security

- **No network I/O.** The plugin and bundled MCP server make zero outbound HTTP/DNS/socket calls. All state is file reads and writes under `.claude/collab/`.
- **Channel notifications carry no payload.** The doorbell emits a fixed short string (`"You have N new wrightward bus event(s)..."`) plus a `pending_count` attribute. Event content is always delivered through Path 1's hook-injected `additionalContext`, which is standard Claude Code context injection.
- **Bus messages originate only from co-located sessions.** There is no external sender. The bus carries only events written by other wrightward sessions running in the same repo.
- **Edit/Write to collab state are hard-blocked.** The guard hook unconditionally rejects Edit and Write tool calls targeting any file under `.claude/collab/`, including from the agent itself. Bash is not intercepted — the block message and skill instructions tell the agent never to escalate to shell commands (`rm`, `sed`, redirects) to modify collab files, but this is a prompt-level directive, not an enforced block. State changes should always go through wrightward's skills.
- **Advisory file locking.** All bus mutations (append, compact, bookmark advance, interest registration) run under one exclusive file lock with stale-lock detection. Prevents torn writes across concurrent sessions without any cross-process IPC.
- **No telemetry.** No events, usage stats, or crash reports leave the user's machine.

## Requirements

- Node.js >= 18
- One runtime dependency: `@modelcontextprotocol/sdk` (required for the bundled MCP server; bundled with the plugin's `node_modules/`)
- Cross-platform (Windows + Unix)

## License

Apache-2.0
