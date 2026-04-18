# wrightward

> Multi-agent coordination for Claude Code. When two or more sessions work in the same repo, wrightward blocks conflicting writes, injects awareness context, and gives sessions a peer-to-peer message bus (eight MCP tools) to hand off tasks, watch files, and wake each other. Ships with an optional Discord bridge.

**Version**: 3.9.0 · [Source](https://github.com/Joys-Dawn/toolwright/tree/master/wrightward) · [README](https://github.com/Joys-Dawn/toolwright/blob/master/wrightward/README.md)

## Install

```text
/plugin marketplace add Joys-Dawn/toolwright
/plugin install wrightward@Joys-Dawn/toolwright
```

Requires Node.js ≥ 18 and a git repo. Hooks activate automatically. State lives at `<repo-root>/.claude/collab/` (auto-gitignored).

### Recommended permissions

Add to your global `~/.claude/settings.json` to skip consent dialogs:

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

The `mcp__wrightward-bus__*` entry auto-allows every wrightward MCP tool — important so wake-up pings don't stall on a permission prompt.

## File coordination

Default-on. No setup. Every Edit/Write is auto-tracked.

- **Auto-tracked files** are held for **2 minutes** from last touch.
- **Declared files** (via `/wrightward:collab-context`) are held for **15 minutes**, auto-extended if the agent edits near the deadline.
- **Idle reminder** fires after **5 minutes** of no touches, suggesting release.

### Guard behavior

Before every tool call:

- Read/Glob/Grep on another agent's file → awareness context injected (who owns it, what they're doing).
- Write to another agent's file → **blocked**; the agent sees who owns it.
- Write to an unrelated file → proceeds with awareness of other active agents.
- Solo agent → everything proceeds silently.

Context injection is deduplicated — the same summary appears once per change.

### Collab state is protected

Edit/Write on `.claude/collab/*` is hard-blocked by the guard hook. Bash is not intercepted — the block message and every collab skill tell the agent never to escalate to shell.

## Slash commands

All live under `/wrightward:<name>`.

| Command | Purpose |
|---|---|
| `/wrightward:help` | Rulebook — tool reference, coordination rules, Discord routing, event types, etiquette. |
| `/wrightward:collab-context` | Declare or update task + claimed files. JSON payload with `task`, `files` (`+` create / `~` modify / `-` delete), `functions`, `status`. |
| `/wrightward:collab-release` | Release specific files. JSON payload with `files` array. |
| `/wrightward:collab-done` | Release everything and exit coordination. |
| `/wrightward:inbox` | List pending urgent events (rarely needed — auto-injected). |
| `/wrightward:ack` | Acknowledge a handoff with `accepted` / `rejected` / `dismissed`. |
| `/wrightward:handoff` | Hand a task to another agent and release files atomically. |
| `/wrightward:watch` | Register interest in a file — get notified when it frees up. |
| `/wrightward:config-init` | Write `.claude/wrightward.json` with every default populated. Pass `--force` to overwrite. |

## Message bus (v3.0)

Sessions hand off work, watch files, and notify each other through `.claude/collab/bus.jsonl` (append-only, length-bounded, self-compacting). Urgent events inject as `additionalContext` on the next tool call.

### MCP tools

| Tool | Required | Optional | Purpose |
|---|---|---|---|
| `wrightward_list_inbox` | — | `limit`, `types`, `mark_delivered` (default `true`) | List urgent events targeted at this session. Advances the bookmark. |
| `wrightward_ack` | `id` | `decision` (`"accepted"` \| `"rejected"` \| `"dismissed"`) | Acknowledge a handoff. Routes the ack at the sender so they see it on their next tool call and in their Discord thread. |
| `wrightward_send_note` | `body` | `to` (handle or `"all"`), `kind` (`"note"` \| `"finding"` \| `"decision"`, default `"note"`), `files` | Log an observability entry. `note` is quiet; `finding`/`decision` are urgent and broadcast. |
| `wrightward_send_handoff` | `to` (peer handle e.g. `"bob-42"`), `task_ref`, `next_action` | `files_unlocked` | Hand work to another session by handle. Atomically releases the listed files and emits `file_freed` to watchers. |
| `wrightward_watch_file` | `file` | — | Register interest. You get a `file_freed` event when the owner releases it. |
| `wrightward_bus_status` | — | — | Diagnostic — pending urgent count, recent timestamp, bound session ID, bridge status. |
| `wrightward_send_message` | `body`, `audience` | — | Send a message via Discord. `audience` = `"user"` (reply into the sender's own thread), `"all"` (Discord broadcast + every agent's inbox), or a peer handle like `"bob-42"` (that agent's thread + inbox). Requires the Discord bridge to be running for Discord delivery. |
| `wrightward_whoami` | — | — | Return your own agent handle, session ID, and registration time. Handles are deterministic per-session; useful after compaction. |

### Event types (15)

Nine urgent (auto-inject on next tool call, capped by `BUS_URGENT_INJECTION_CAP`); six non-urgent (persisted, not auto-surfaced).

**Urgent (9):** `handoff`, `file_freed`, `user_message`, `blocker`, `delivery_failed`, `agent_message`, `ack`, `finding`, `decision`.

**Non-urgent (6):** `note`, `interest`, `session_started`, `session_ended`, `context_updated`, `rate_limited`.

### Routing

- `to` is a session ID, `"all"`, or an array of session IDs.
- `from === to` never matches — no echo.
- `ambiguous_mention` flag signals a short-ID collision resolved to `"all"`.

## Channel push (v3.1, research preview)

Adds a `notifications/claude/channel` wake-up ping so idle sessions notice new events between turns. Requires **Claude Code ≥ 2.1.80**. Gated behind Anthropic's allowlist — until wrightward is approved, use the `server:` workaround.

### Enable

1. Add the server to your user-level `~/.mcp.json`:

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

2. Launch Claude Code with the dev flag:

    ```text
    claude --dangerously-load-development-channels server:wrightward-bus
    ```

Expected banner: *"Listening for channel messages from: server:wrightward-bus"*.

### Wait ~10 seconds between concurrent agent launches

When spinning up multiple CLI agents in the same repo, wait about 10 seconds between each `claude ...` command. The MCP server binds to its session via a ticket file written by the SessionStart hook; on Windows (and other setups where `process.ppid` doesn't match the Claude Code process directly), the fallback scanner refuses to bind across more than one unclaimed ticket in its 10-second freshness window. Launching 2+ agents back-to-back leaves them all unbound — channel wake-ups silently stop until the session restarts. Spacing launches by 10s or more avoids this.

### IDE extensions are not supported

Channels only work when Claude Code is launched from a plain terminal. The **VS Code and Cursor extensions do not deliver `notifications/claude/channel` wake-up pings** — the Path 2 doorbell is silently dropped regardless of `claudeCode.claudeProcessWrapper` or dev-flag configuration. Path 1 still works inside the IDEs (urgent events inject on the session's next tool call), so you won't lose delivery — just between-turn wake-ups. Launch `claude` from a terminal if you need the doorbell.

## Discord bridge (v3.2)

An opt-in subprocess that mirrors bus events to Discord. REST-only (no gateway), so it coexists with the stock `discord@claude-plugins-official` plugin on the same bot token.

When enabled:

- Creates one **forum thread per agent** named `<task> (<handle>)` (e.g. `refactor auth (bob-42)`) and posts per-session events there. Handles are deterministic per-session — the same UUID always derives the same `<name>-<number>` handle.
- Mirrors `session_started` / `session_ended` / broadcast handoffs / `user_message` targeted at `"all"` into a shared **broadcast text channel**.
- Watches the broadcast channel and every live agent thread for inbound messages, routing them back into `bus.jsonl` as `user_message` events.
- Renames a thread when `/wrightward:collab-context` updates the session's task.

### Setup

1. **Create a Discord application and bot** at <https://discord.com/developers/applications>.
    - Click **New Application**, name it, then go to the **Bot** tab and click **Add Bot**.
    - Under **Token**, click **Reset Token** and copy it (shown once). Keep it secret.
    - **Turn on Message Content Intent.** Still on the **Bot** tab, scroll to **Privileged Gateway Intents** and toggle **Message Content Intent** *on*. Without it, Discord strips message bodies — `@agent-<id>` mentions can't resolve, and thread replies arrive empty. Enable it.

2. **Invite the bot** via **OAuth2 → URL Generator**.
    - Scopes: `bot`.
    - Permissions: `View Channels`, `Send Messages`, `Send Messages in Threads`, `Manage Threads`, `Read Message History`.
    - Open the generated URL and add the bot to a server you own.

3. **Create two channels** in your Discord server:
    - One **forum channel** — one thread per agent.
    - One **text channel** — the shared broadcast feed.

4. **Enable Developer Mode in Discord** (User Settings → Advanced → *Developer Mode*). Right-click to **Copy ID**. You'll need:
    - The forum channel ID (→ `FORUM_CHANNEL_ID`).
    - The broadcast text channel ID (→ `BROADCAST_CHANNEL_ID`).
    - Your Discord user ID (→ `ALLOWED_SENDERS` — right-click your name → *Copy User ID*).

5. **Install and provide the bot token.** `/plugin install wrightward@Joys-Dawn/toolwright`. On first run, Claude Code prompts for the `discord_bot_token` — paste it and you're done. The token is stored in your OS keychain (declared `sensitive: true` in [`plugin.json`](https://github.com/Joys-Dawn/toolwright/blob/master/wrightward/.claude-plugin/plugin.json)) and passed to the bridge as `DISCORD_BOT_TOKEN`.

    Alternatively, set `DISCORD_BOT_TOKEN` in the shell that launches `claude`:

    === "POSIX"
        ```sh
        export DISCORD_BOT_TOKEN=your-token-here
        claude
        ```

    === "Windows cmd"
        ```cmd
        set DISCORD_BOT_TOKEN=your-token-here
        claude
        ```

    === "PowerShell"
        ```powershell
        $env:DISCORD_BOT_TOKEN = "your-token-here"
        claude
        ```

6. **Create `.claude/wrightward.json`** in your project root:

    ```json
    {
      "discord": {
        "ENABLED": true,
        "FORUM_CHANNEL_ID": "1234567890",
        "BROADCAST_CHANNEL_ID": "1234567891",
        "ALLOWED_SENDERS": ["your-discord-user-id"]
      }
    }
    ```

    `ALLOWED_SENDERS: []` runs the bridge send-only.

7. **Start a Claude session.** The first session spawns the bridge under a single-owner lockfile at `.claude/collab/bridge/bridge.lock`. Other sessions in the same repo share it — exactly one bridge per repo.

Verify with `wrightward_bus_status` — the `bridge` sub-object should show `running: true`, `last_error: null`, and `owner_session_id` matching your session. Tail `.claude/collab/bridge/bridge.log` for diagnostics.

### Inbound routing

All gated on `ALLOWED_SENDERS`:

- **Reply in an agent's forum thread** → delivered to that thread's session without an `@mention`.
- **`@agent-<handle>` in broadcast or thread** → delivered to the mentioned session(s). Both full handle (`@agent-bob-42`) and name-only (`@agent-bob`) resolve; name-only matches a single agent by name, otherwise broadcasts with `ambiguous_mention: true`. Fan-out works: a thread reply with extra `@agent-<handle>` mentions goes to the union of the thread owner and mentioned sessions.
- **`@agent-all`** → every registered agent. `ambiguous_mention` stays `false` for explicit all-broadcasts.

### Mirror policy defaults

User overrides merge on top. Demote to `silent` via `mirrorPolicy` if noisy.

| Event type | Destination |
|---|---|
| `user_message`, `handoff`, `blocker`, `agent_message` | Recipient's thread. Promotes to broadcast when sent to `"all"`. `agent_message` with `audience="user"` posts into the **sender's** own thread (not broadcast). |
| `file_freed` | Recipient's thread (targeted only); `silent` when broadcast. |
| `session_started`, `session_ended` | Broadcast channel. |
| `note`, `finding`, `decision` | Target thread when sent to a sessionId; broadcast channel when sent to `"all"`. |
| `ack` | Original handoff sender's thread. |
| `context_updated` | Renames the sender's thread to match the new task. |
| `interest`, `delivery_failed`, `rate_limited` | Never mirrored (hard rail — can't be elevated). |

### Security model

- `ALLOWED_SENDERS` gates on Discord user ID, not channel membership. Access to the broadcast channel alone doesn't grant inbound rights.
- Bot tokens, `Bot <token>` headers, and Discord webhook URLs are scrubbed from every `bridge.log` write and every inbound body before it reaches `bus.jsonl`.
- Inbound content clamped at 4000 bytes on a UTF-8 boundary.
- Outbound messages exceeding Discord's 2000-byte cap auto-split into ordered posts with `(n/N)` continuation markers, balanced code fences across chunks, and UTF-8-safe cuts — no silent truncation.
- Discord-originated events use the reserved `system` sender with `meta.source: "discord"`. A loop guard prevents re-mirroring back to Discord.
- Local operation keeps flowing if Discord is down — the bridge retries in the background.

## Hooks

| Hook | Event | What it does |
|---|---|---|
| [`register.js`](https://github.com/Joys-Dawn/toolwright/blob/master/wrightward/hooks/register.js) | `SessionStart` | Registers the agent in `.claude/collab/agents.json`. Emits `session_started` on `source=startup\|resume` only. |
| [`heartbeat.js`](https://github.com/Joys-Dawn/toolwright/blob/master/wrightward/hooks/heartbeat.js) | `PostToolUse` (all tools) | Updates heartbeat, auto-tracks files, scavenges stale sessions, fires idle reminders. |
| [`guard.js`](https://github.com/Joys-Dawn/toolwright/blob/master/wrightward/hooks/guard.js) | `PreToolUse` (`Edit\|Write\|Read\|Glob\|Grep`) | Blocks conflicting writes; injects awareness context. |
| [`bash-allow.js`](https://github.com/Joys-Dawn/toolwright/blob/master/wrightward/hooks/bash-allow.js) | `PreToolUse` (`Bash`) | Auto-approves wrightward's own script invocations (workaround for claude-code#11932). |
| [`plan-exit.js`](https://github.com/Joys-Dawn/toolwright/blob/master/wrightward/hooks/plan-exit.js) | `PostToolUse` (`ExitPlanMode`) | Reminds the agent to declare files — only when other agents are active. |
| [`cleanup.js`](https://github.com/Joys-Dawn/toolwright/blob/master/wrightward/hooks/cleanup.js) | `SessionEnd` | Deregisters, releases claims, emits `session_ended`. |

## Config

`.claude/wrightward.json` (all fields optional). See [`wrightward.example.json`](https://github.com/Joys-Dawn/toolwright/blob/master/wrightward/wrightward.example.json).

Run `/wrightward:config-init` to drop the full default config into your repo — every key populated so you can edit any knob in place. Add `--force` to overwrite an existing file; delete the file to fall back to built-in defaults.

### Base coordination

| Key | Default | Description |
|---|---|---|
| `ENABLED` | `true` | Master switch. `false` exits all hooks immediately. |
| `PLANNED_FILE_TIMEOUT_MIN` | 15 | How long declared files are held. |
| `PLANNED_FILE_GRACE_MIN` | 2 | Extends the timeout when the file is touched near expiry. |
| `AUTO_TRACKED_FILE_TIMEOUT_MIN` | 2 | How long auto-tracked files are held (from last touch). |
| `REMINDER_IDLE_MIN` | 5 | Idle threshold for the release reminder. |
| `INACTIVE_THRESHOLD_MIN` | 6 | Stale-session threshold. |
| `SESSION_HARD_SCAVENGE_MIN` | 60 | Hard cleanup for dead sessions. |
| `AUTO_TRACK` | `true` | Auto-create a context when none has been declared. |

### Bus

| Key | Default | Description |
|---|---|---|
| `BUS_ENABLED` | `true` | `false` skips the MCP server entirely. |
| `BUS_RETENTION_DAYS` | 7 | Drop events older than this from `bus.jsonl`. |
| `BUS_RETENTION_MAX_EVENTS` | 10000 | Hard cap on retained events. |
| `BUS_HANDOFF_TTL_MIN` | 30 | Handoffs expire if never acked. |
| `BUS_INTEREST_TTL_MIN` | 60 | TTL on file-watch registrations. |
| `BUS_URGENT_INJECTION_CAP` | 5 | Max urgent events auto-injected per tool call. Overflow points to `/wrightward:inbox`. |

### Discord

| Key | Default | Description |
|---|---|---|
| `discord.ENABLED` | `false` | Master switch for the bridge. |
| `discord.FORUM_CHANNEL_ID` | — | Forum channel for per-agent threads. |
| `discord.BROADCAST_CHANNEL_ID` | — | Text channel for announcements and inbound mentions. |
| `discord.ALLOWED_SENDERS` | `[]` | Discord user IDs permitted to route inbound messages. |
| `discord.POLL_INTERVAL_MS` | 3000 | How often to poll the broadcast channel and each active thread. |
| `discord.THREAD_RENAME_ON_CONTEXT_UPDATE` | `true` | Whether `/wrightward:collab-context` task changes rename the thread. |
| `discord.BOT_USER_AGENT` | `DiscordBot (https://github.com/Joys-Dawn/toolwright, 3.9.0)` | Override only with a reason; must start with the literal `DiscordBot` to avoid Cloudflare blocking. |
| `discord.mirrorPolicy` | see above | Per-event-type override. |

### Disable in a repo

```json
{ "ENABLED": false }
```

All hooks exit immediately.

## State layout

`.claude/collab/`:

- `context/`, `context-hash/` — per-session task/file claims
- `mcp/` — MCP server binding tickets
- `bus.jsonl` — append-only event log
- `bus-delivered/` — per-session delivery bookmarks
- `bus-index/` — derived indices (Discord thread map, etc.)
- `bridge/` — Discord lockfile, log, circuit breaker, last-polled markers

## Security

- **No network I/O by default.** Outbound traffic happens only when the Discord bridge is enabled, in which case the bridge talks to `discord.com/api/v10` via REST.
- **Channel notifications carry no payload.** The doorbell emits a fixed short string; event content always flows through hook-injected `additionalContext`.
- **Bus messages originate only from co-located sessions** — no external sender.
- **Edit/Write to collab state are hard-blocked.** Bash isn't intercepted; the agent is prompted never to escalate to shell.
- **Advisory file locking** on every bus mutation, with stale-lock detection.
- **No telemetry.**
