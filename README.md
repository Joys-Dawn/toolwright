# AI Engineering Plugins

Five [Claude Code](https://docs.anthropic.com/en/docs/claude-code) plugins that can be installed separately or together. All are zero-config — install and start using them immediately.

> 📖 **Full docs:** <https://joys-dawn.github.io/toolwright/> — setup (including Discord bot walkthrough), config reference, MCP tools, hooks, and every option for all five plugins. Start there.

| Plugin | What it does |
|--------|-------------|
| [agentwright](agentwright/) | Automated code audits that find and fix bugs, security issues, and bad practices. Also includes skills for planning, debugging, and testing. Run `/audit-run` and it does the rest. |
| [wrightward](wrightward/) | Multi-agent coordination. When two or more Claude Code sessions work in the same repo, wrightward blocks conflicting writes, injects awareness context, and runs a peer-to-peer message bus (eight MCP tools) for handoffs, file watches, and inter-agent messages. Optional Discord bridge mirrors events to a forum channel (one thread per agent) and relays human replies back to the bus. |
| [timewright](timewright/) | Undo for Claude's in-session source file changes — including Bash-driven mutations (file deletions, sed rewrites, git operations) that native `/rewind` misses. Type `/undo` to revert. |
| [ideawright](ideawright/) | Auto-surfaces novel, code-only product opportunities by mining public pain-point signals (Reddit/HN/GitHub issues) and newly-published capabilities (arXiv/bioRxiv/PubMed), then running a multi-source novelty check, an LLM feasibility gate, and a composite ranker. `/ideawright:daily` produces a ranked top-N digest with quoted evidence. |
| [gripewright](gripewright/) | Capture user complaints about agent behavior into a labeled NDJSON corpus. Type `/gripewright:wtf` when the agent does something wrong; the prior turn (and the agent's response to your gripe) is appended to `~/.claude/gripewright/log.ndjson` as a negative training example. Make a dataset of agents' failure points in your workflows and use it to guide them in the future. |

## Installation

In any Claude Code session, add the marketplace and install the plugins you want:

```
/plugin marketplace add Joys-Dawn/toolwright
/plugin install agentwright@Joys-Dawn/toolwright
/plugin install wrightward@Joys-Dawn/toolwright
/plugin install timewright@Joys-Dawn/toolwright
/plugin install ideawright@Joys-Dawn/toolwright
/plugin install gripewright@Joys-Dawn/toolwright
```

Or use `/plugin` and browse the **Discover** tab to install interactively.

## Customize defaults

agentwright and wrightward both run zero-config. If you want to tune anything, drop a fully-defaulted config into your repo:

```
/agentwright:config-init        # writes .claude/agentwright.json
/wrightward:config-init         # writes .claude/wrightward.json
```

Edit any value; delete the file to revert to built-in defaults. Pass `--force` to overwrite an existing file.

## Quick start

### agentwright

Run an audit on your recent changes:

```
/audit-run
```

This audits files in your `git diff` through any stages you choose (i.e. implementation → correctness → best-practices → behavior → test-coverage or any custom skills/pipelines), verifies each finding, and applies fixes. See [agentwright/README.md](agentwright/) for all commands, skills, and configuration options.

### wrightward

Open two or more Claude Code sessions in the same repo. The core coordination activates automatically — every Edit/Write is auto-tracked, and writes to another agent's active file are blocked with a summary of who owns it.

For longer-lived claims and handoffs, agents use the skills:

```
/wrightward:collab-context   # declare task + files you're about to touch
/wrightward:handoff          # hand a task to another session (atomically releases files)
/wrightward:watch <file>     # get notified when another session frees a file
/wrightward:inbox            # check pending urgent events
/wrightward:help             # full rulebook (tools, routing, etiquette)
```

Sessions exchange urgent events (handoffs, blockers, findings, decisions, inter-agent messages) through a file-based bus; urgent events auto-inject as context on the next tool call.

**Optional add-ons** (see the [wrightward docs](https://joys-dawn.github.io/toolwright/wrightward/) for setup):

- **Channel push** (research preview, Claude Code ≥ 2.1.80) — wakes idle sessions between turns when they receive an urgent bus event, so handoffs don't wait for the user to type. Activated by launching Claude Code with `--dangerously-load-development-channels plugin:wrightward@toolwright-joysdawn` until wrightward is approved in the official channel allowlist. **CLI only — the VS Code and Cursor extensions don't deliver the wake-up ping.**
- **Discord bridge** — disabled by default (`discord.ENABLED: false`); flip it on in `.claude/wrightward.json`. Mirrors bus events to a Discord forum channel (thread per agent) and relays replies (thread replies, `@agent-<id>` mentions, `@agent-all` broadcasts) back into the bus. REST-only, coexists with the stock Discord plugin on the same bot token. Full setup walkthrough (bot creation, Message Content Intent, OAuth2 invite, channel IDs) in the docs.

See [wrightward/README.md](wrightward/) or the [docs page](https://joys-dawn.github.io/toolwright/wrightward/) for the full reference.

### timewright

After Claude makes changes you want to revert:

```
/undo
```

Claude shows you what will change (modified, added, deleted files) and asks for confirmation before applying. Covers everything — Bash commands, file edits, notebook changes. See [timewright/README.md](timewright/) for details.

### ideawright

Get a daily ranked list of code-only product ideas backed by quoted public evidence:

```
/ideawright:daily
```

Output lands in `.claude/ideawright/digests/YYYY-MM-DD.md` — a ranked top-N digest with the pain quote, novelty verdict, feasibility verdict, and a one-paragraph build sketch per idea. Use `/ideawright:status` to see what's currently promoted. See [ideawright/README.md](ideawright/) for sources, gates, and configuration.

### gripewright

When Claude does something wrong — takes a shortcut, dismisses a real issue, fabricates a fact, ignores your instructions — type:

```
/gripewright:wtf [optional reason]
/gripewright:wtf 3 ignored my instruction not to commit
```

The prior assistant turn (or last N turns if an int follows the wtf) and the agent's response to your gripe gets appended to `~/.claude/gripewright/log.ndjson` as a labeled negative example you can use for evaluation, fine-tuning, or just to spot patterns. See [gripewright/README.md](gripewright/) for the record shape.

## Requirements

- Node.js >= 18
- Claude CLI (`claude` on PATH) — required for agentwright's and ideawright's headless auditor/judge subprocesses
- No external dependencies

## License

Apache-2.0
