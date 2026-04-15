# toolwright — Claude Code plugins

Three zero-config [Claude Code](https://docs.anthropic.com/en/docs/claude-code) plugins, shipped from one marketplace. Install any subset.

| Plugin | What it does |
|---|---|
| [agentwright](agentwright.md) | Automated code audits that find and fix bugs, security issues, and bad practices. Planning, debugging, and testing skills included. Run `/audit-run` — it does the rest. |
| [wrightward](wrightward.md) | Multi-agent coordination. Blocks conflicting writes across sessions, injects awareness context, runs a peer-to-peer message bus (seven MCP tools), and offers an optional Discord bridge. |
| [timewright](timewright.md) | Undo for Claude's in-session changes — including Bash-driven mutations that native `/rewind` misses. Type `/undo` to revert. |

## Install

```text
/plugin marketplace add Joys-Dawn/toolwright
/plugin install agentwright@Joys-Dawn/toolwright
/plugin install wrightward@Joys-Dawn/toolwright
/plugin install timewright@Joys-Dawn/toolwright
```

Or run `/plugin` and browse the **Discover** tab.

### Requirements

- Node.js ≥ 18 (all three plugins)
- Git (timewright uses git plumbing for snapshots; wrightward expects a git repo)
- `claude` on `PATH` (agentwright's headless auditor subprocess)
- A Discord bot token — only for wrightward's optional Discord bridge

## Using them together

The three plugins are independent but aware of each other:

- During an audit, if wrightward signals another agent is working on a file, agentwright skips that finding and revisits it on the next poll.
- When an audit finishes, it runs `/wrightward:collab-done` to release file claims if other agents are active.

## License

All three plugins are Apache-2.0. See [LICENSE](https://github.com/Joys-Dawn/toolwright/blob/master/LICENSE).

## Issues and feedback

- File an issue: <https://github.com/Joys-Dawn/toolwright/issues>
- Source: <https://github.com/Joys-Dawn/toolwright>
