# AI Engineering Plugins

Two independent Claude Code plugins. They can be installed separately or together.

## [agentwright](agentwright/)

Automated code auditing. Spawns a headless auditor subprocess against a frozen snapshot while the current session verifies findings and applies fixes on the live repo. Ships with 10 vendored skills (correctness, security, best-practices, migration, UI accessibility, debugging, planning, Deno testing, frontend testing, and pgTAP testing) and 3 subagents (verifier, deep-research, update-docs).

Use when: you want automated, structured code review — security audits, correctness checks, best-practices enforcement.

## [wrightward](wrightward/)

Multi-agent coordination. When multiple Claude Code agents work on the same codebase, wrightward prevents conflicting edits. The user runs `/collab-context` in each agent session to declare what it's working on. From that point, writes to files claimed by another agent are blocked, and context about other agents' work is automatically injected on reads and non-overlapping writes. Files touched via Edit/Write are auto-tracked even if not declared up front.

Use when: you have two or more agents editing/writing to the same repo at the same time.

## Using them together

The plugins are independent but aware of each other:

- `agentwright` creates frozen snapshot directories for its auditor subprocesses. `wrightward` automatically excludes agents running inside these snapshots from coordination tracking as they are read-only.
- When an audit run detects active agents via `.collab/`, it declares its own context through `wrightward` so other agents know an audit is in progress.


## License

Apache-2.0