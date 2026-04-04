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

### Idle reminders

If an agent hasn't touched a file in **5 minutes**, a one-time reminder suggests releasing it. This nudges agents to free files they've moved on from without waiting for the timeout.

## Skills

| Skill | Description |
|-------|-------------|
| `/wrightward:collab-context` | Declare or update the current task and claimed files (`+` create, `~` modify, `-` delete) |
| `/wrightward:collab-release` | Release specific files so other agents can work on them immediately |
| `/wrightward:collab-done` | Release all file claims and exit coordination |

## Hooks

Five hooks run automatically — no user intervention needed:

| Hook | Trigger | What it does |
|------|---------|--------------|
| `register.js` | Session start | Registers the agent in `.claude/collab/agents.json` |
| `heartbeat.js` | After every tool call | Updates heartbeat, auto-tracks files, runs scavenging, fires idle reminders |
| `guard.js` | Before Edit/Write/Read/Glob/Grep | Blocks conflicting writes, injects awareness context |
| `plan-exit.js` | After exiting plan mode | Reminds the agent to declare files (only when other agents are active) |
| `cleanup.js` | Session end | Deregisters the agent and releases all claims |

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

- Node.js >= 18 (no external dependencies)
- Cross-platform (Windows + Unix)

## License

Apache-2.0
