# AI Engineering Plugins

Three [Claude Code](https://docs.anthropic.com/en/docs/claude-code) plugins that can be installed separately or together. All are zero-config — install and start using them immediately.

| Plugin | What it does |
|--------|-------------|
| [agentwright](agentwright/) | Automated code audits that find and fix bugs, security issues, and bad practices. Also includes skills for planning, debugging, and testing. Run `/audit-run` and it does the rest. |
| [wrightward](wrightward/) | Multi-agent coordination — when two or more Claude Code sessions work in the same repo, wrightward blocks conflicting writes, injects awareness context, and gives the sessions a peer-to-peer message bus (with six MCP tools) to hand off tasks, watch files, and wake each other up via Claude Code channels. |
| [timewright](timewright/) | Undo for Claude's in-session source file changes — including Bash-driven mutations (file deletions, sed rewrites, git operations) that native `/rewind` misses. Type `/undo` to revert. |

## Installation

In any Claude Code session, add the marketplace and install the plugins you want:

```
/plugin marketplace add Joys-Dawn/toolwright
/plugin install agentwright@Joys-Dawn/toolwright
/plugin install wrightward@Joys-Dawn/toolwright
/plugin install timewright@Joys-Dawn/toolwright
```

Or use `/plugin` and browse the **Discover** tab to install interactively.

## Quick start

### agentwright

Run an audit on your recent changes:

```
/audit-run
```

This audits files in your `git diff` through three stages (correctness → security → best-practices), verifies each finding, and applies fixes. See [agentwright/README.md](agentwright/) for all commands, skills, and configuration options.

### wrightward

Open two or more Claude Code sessions in the same repo, then in each session:

```
/wrightward:collab-context
```

Declare which files each agent will touch. Each agent automatically receives context about what the others are working on as it reads and writes files. See [wrightward/README.md](wrightward/) for the full workflow.

### timewright

After Claude makes changes you want to revert:

```
/undo
```

Claude shows you what will change (modified, added, deleted files) and asks for confirmation before applying. Covers everything — Bash commands, file edits, notebook changes. See [timewright/README.md](timewright/) for details.

## Using them together

The plugins are independent but aware of each other:

- During an audit, if wrightward signals that another agent is working on a file, agentwright skips that finding and revisits it on the next poll.
- When an audit finishes, it automatically runs `/wrightward:collab-done` to release file claims if other agents are active.

## Requirements

- Node.js >= 18
- Claude CLI (`claude` on PATH) — required for agentwright's headless auditor subprocess
- No external dependencies

## License

Apache-2.0
