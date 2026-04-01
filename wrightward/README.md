# wrightward

Claude Code plugin that coordinates multiple agents working on the same codebase. Blocks writes to files another agent has claimed, and injects context so agents stay aware of each other's work.

## Installation

```
/plugin marketplace add Joys-Dawn/toolwright
/plugin install wrightward@Joys-Dawn/toolwright
```

## Quick start

1. Start two or more Claude Code sessions in the same repo
2. In each session, run `/wrightward:collab-context` to declare what the agent is working on. This is best done after a Plan session or an agentwright:feature-planning skill call. The agent is told to declare their context when exiting plan mode automatically.
3. Writes to files claimed by another agent are automatically blocked
4. When done, run `/wrightward:collab-done` to release file claims (or let them expire after 6 minutes of inactivity)

## How it works

Four hooks run automatically — no user intervention needed after initial setup:

| Hook | Trigger | Behavior |
|------|---------|----------|
| `register.js` | Session start | Registers the agent in `.claude/collab/agents.json` |
| `heartbeat.js` | After every tool call | Updates heartbeat; auto-tracks files touched by Edit/Write |
| `guard.js` | Before every tool call | Blocks writes on claimed files; injects context on reads and non-overlapping writes |
| `plan-exit.js` | After exiting plan mode | Reminds the agent to declare file claims via `/wrightward:collab-context` (only when other agents are active) |

### Write behavior

- **File claimed by another agent** — write is blocked (exit code 2), agent sees who owns the file
- **File not claimed, but other agents are active** — write proceeds, agent receives context about what others are doing
- **Solo agent (no other active agents)** — everything proceeds silently, zero overhead

Context injection is deduplicated — the same summary is only shown once per change.

## Skills

| Skill | Description |
|-------|-------------|
| `/wrightward:collab-context` | Declare or update the current task, files (`+`create, `~`modify, `-`delete), and functions |
| `/wrightward:collab-done` | Release all file claims and exit coordination |

Best used after planning (e.g., plan mode or a feature-planning skill), when the agent knows which files it will touch. Files edited via Edit/Write are auto-tracked even if not declared up front.

## State

All coordination state lives in `.claude/collab/` (auto-gitignored). Sessions expire after 6 minutes of inactivity and are hard-scavenged after 60 minutes.

## Requirements

- Node.js (no external dependencies)
- Cross-platform (Windows + Unix)

## License

Apache-2.0
