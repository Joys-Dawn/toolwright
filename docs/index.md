# toolwright — Claude Code plugins

Seven zero-config [Claude Code](https://docs.anthropic.com/en/docs/claude-code) plugins, shipped from one marketplace. Install any subset.

| Plugin | What it does |
|---|---|
| [agentwright](agentwright.md) | Automated code audits that find and fix bugs, security issues, and bad practices. Planning, debugging, and testing skills included. Run `/audit-run` — it does the rest. |
| [wrightward](wrightward.md) | Multi-agent coordination. Blocks conflicting writes across sessions, injects awareness context, runs a peer-to-peer message bus (eight MCP tools), and offers an optional Discord bridge. |
| [timewright](timewright.md) | Undo for Claude's in-session changes — including Bash-driven mutations that native `/rewind` misses. Type `/undo` to revert. |
| [ideawright](ideawright.md) | Daily ranked list of novel, code-only product ideas backed by quoted public evidence. Mines pain signals (Reddit/HN/GitHub) and new capabilities (arXiv/bioRxiv/PubMed), checks novelty, gates on feasibility. Run `/ideawright:daily`. |
| [gripewright](gripewright.md) | Capture user complaints about agent behavior into a labeled NDJSON corpus you can mine for patterns or use as a training signal. Type `/gripewright:wtf` when the agent goes wrong. |
| [forgewright](forgewright.md) | Multi-agent workflow orchestrator on agentwright + wrightward. One Claude session is the leader (plans, drives audit pipelines, verifies, talks to you on Discord); peers receive implementation handoffs (or — zero peers — the leader does it). `/forgewright:workflow-run feature "..."` strings plan → plan-quality-review → checkpoint → handoff(implement) → verify-plan → audit pipeline → tests into one resumable, stateful orchestration. |
| [mindwright](mindwright.md) | Per-agent memory + cross-session learning. Each session quietly accumulates short-term observations; a background (or on-demand `/mindwright:dream`) consolidator distills them into long-term facts that auto-inject into future prompts by relevance — nothing dumped at session start, nothing irrelevant injected. Run `/mindwright:setup` once, then it's automatic. |

## Install

```text
/plugin marketplace add Joys-Dawn/toolwright
/plugin install agentwright@Joys-Dawn/toolwright
/plugin install wrightward@Joys-Dawn/toolwright
/plugin install timewright@Joys-Dawn/toolwright
/plugin install ideawright@Joys-Dawn/toolwright
/plugin install gripewright@Joys-Dawn/toolwright
/plugin install forgewright@Joys-Dawn/toolwright
/plugin install mindwright@Joys-Dawn/toolwright
```

Or run `/plugin` and browse the **Discover** tab.

### Requirements

- Node.js ≥ 18 for agentwright / wrightward / timewright; **≥ 20 for gripewright / mindwright**; **≥ 22.5 for ideawright** (uses the built-in `node:sqlite`).
- Git — only timewright needs it (uses `git worktree`/plumbing for snapshots). The other plugins work in any directory; wrightward simply adds its state dir to an existing `.gitignore` when one is present and never creates one.
- `claude` on `PATH` (agentwright's headless auditor and ideawright's LLM judge both spawn it; mindwright's auto-spawned consolidator uses it too, falling back to a manual nudge if absent).
- mindwright ships native npm dependencies (better-sqlite3, sqlite-vec, `@huggingface/transformers`) and pulls a one-time ~5 GB local model set via `/mindwright:setup` before memory features activate. The other six are dependency-free and work the moment they're installed.
- A Discord bot token — only for wrightward's optional Discord bridge.

## Using them together

The plugins are independent but aware of each other:

- During an audit, if wrightward signals another agent is working on a file, agentwright skips that finding and revisits it on the next poll.
- When an audit finishes, it runs `/wrightward:collab-done` to release file claims if other agents are active.

## License

All plugins are Apache-2.0. See [LICENSE](https://github.com/Joys-Dawn/toolwright/blob/master/LICENSE).

## Issues and feedback

- File an issue: <https://github.com/Joys-Dawn/toolwright/issues>
- Source: <https://github.com/Joys-Dawn/toolwright>
