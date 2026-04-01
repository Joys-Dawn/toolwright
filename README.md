# AI Engineering Plugins

Two independent Claude Code plugins that can be installed separately or together.

| Plugin | What it does |
|--------|-------------|
| [agentwright](agentwright/) | Structured code audits, planning, debugging, and testing — run as automated pipelines or standalone skills. Add your own audits into the pipeline. Turns slop into beautiful correct code. |
| [wrightward](wrightward/) | Multi-agent coordination — prevents conflicting edits when multiple agents work on the same repo and injects context so agents are aware of what other agents are working on |

## Installation

First, add the marketplace:

```
/plugin marketplace add Joys-Dawn/toolwright
```

Then install the plugins you want:

```
/plugin install agentwright@Joys-Dawn/toolwright
/plugin install wrightward@Joys-Dawn/toolwright
```

Or use `/plugin` and browse the **Discover** tab to install interactively.

## Using them together

The plugins are independent but aware of each other:

- During an audit, if wrightward detects another agent owns a file, agentwright skips findings for that file and revisits them later.
- Agents spawned inside agentwright's read-only snapshots are automatically excluded from wrightward coordination.

## License

Apache-2.0
