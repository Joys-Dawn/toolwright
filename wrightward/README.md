# wrightward

Claude Code plugin that coordinates multiple agents working on the same codebase. Prevents conflicting edits by blocking writes to files another agent has claimed, and injects awareness context so agents know what others are doing.

## Installation

```
/install-plugin https://github.com/Joys-Dawn/toolwright/tree/master/wrightward
```

## Workflow

### Setup

When a session starts alongside other agents, run `/wrightward:collab-context` (user or agent can invoke this). This declares what the agent is working on — task description, files it plans to touch, and functions it will modify. The declaration is written to `.collab/` in the project root.

Best used after a plan has been made (e.g., after using plan mode or agentwright's feature planning skill), since the agent will have a clear picture of which files and functions it will touch. Only declare files you are certain you will touch — files edited via Edit/Write are automatically added to your context while other agents are active.

### What happens automatically

Once context is declared, three hooks run on every tool call with no user intervention:

**On session start** (`register.js`): The agent is registered in `.collab/agents.json` with its PID and a heartbeat timestamp.

**After every tool call** (`heartbeat.js`): The agent's heartbeat is updated. If the tool was an Edit or Write, the file is automatically added to the agent's declared file list — so even files the user didn't anticipate are tracked.

**Before every tool call** (`guard.js`): This is where coordination happens. The guard checks what other active agents have declared and compares it against the current tool call:

- **Edit or Write on a file another agent claimed** → The tool call is **blocked** (exit code 2). The agent sees a summary of who is working on that file and what they're doing. The write does not proceed.
- **Edit or Write on a file no other agent claimed, but other agents are active** → The tool call **proceeds**, but the agent receives injected context summarizing what other agents are working on (only when this information has changed since last injection).
- **Read, Glob, or Grep targeting files another agent claimed** → The tool call **proceeds** with non-blocking injected context about the overlapping agent's work.
- **No other agents active, or no overlap** → The tool call proceeds silently.

### Teardown

When finished, run `/wrightward:collab-done` to remove the session from coordination state. If not called, the session expires automatically (ignored after 6 minutes of inactivity, hard-scavenged after 60 minutes).

## Skills

Both skills can be invoked by the user or by the agent itself.

| Skill | Description |
|-------|-------------|
| `/wrightward:collab-context` | Declare (or update) the current task, files, and functions |
| `/wrightward:collab-done` | Clear the session from coordination state, releasing file claims |

## Context schema

```json
{
  "task": "One-line description of current work",
  "files": ["+src/new.ts", "~src/existing.ts", "-src/old.ts"],
  "functions": ["+newFunc", "~modifiedFunc", "-removedFunc"],
  "status": "in-progress"
}
```

Prefixes: `+` create, `~` modify, `-` delete. Files edited via Edit/Write are auto-tracked by the heartbeat hook even if not declared up front.

## Hooks

| Event | Hook | What it does |
|-------|------|--------------|
| SessionStart | `register.js` | Registers the agent in `.collab/agents.json` |
| PostToolUse | `heartbeat.js` | Updates heartbeat timestamp; auto-tracks files written by Edit/Write |
| PreToolUse | `guard.js` | Blocks writes on claimed files; injects context for reads and non-overlapping writes |

## Key behaviors

- Writes to files claimed by another agent are blocked (exit code 2), not just warned
- Writes to unclaimed files still get injected context about other active agents (so the agent stays aware)
- Context injection is deduplicated — the same summary is only shown once (hash comparison)
- Solo agents (no other active agents) are never blocked or interrupted
- All state lives in `.collab/` (auto-gitignored)
- Agents inside `agentwright` snapshot directories are automatically excluded from registration

## Testing

```bash
node --test
```

## Requirements

- Node.js (no external dependencies)
- Cross-platform (Windows + Unix)

## License

Apache-2.0
