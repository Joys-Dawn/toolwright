# AI Engineering Plugins

Two independent Claude Code plugins. They can be installed separately or together.

## Installation

Install plugins per-project or globally using Claude Code's `/install-plugin` command:

```
/install-plugin https://github.com/Joys-Dawn/toolwright/tree/master/agentwright
/install-plugin https://github.com/Joys-Dawn/toolwright/tree/master/wrightward
```

Or install both at once by cloning the repo and pointing to the local paths:

```bash
git clone https://github.com/Joys-Dawn/toolwright.git
```

```
/install-plugin /path/to/toolwright/agentwright
/install-plugin /path/to/toolwright/wrightward
```

## [agentwright](agentwright/)

Structured coding workflows. Ships with 14 vendored skills covering code auditing (correctness, security, best-practices, migration, UI accessibility), planning (project, feature, bug-fix), debugging, and testing (coverage analysis, test writing, Deno, frontend, pgTAP). Also includes 4 subagents (verifier, deep-research, update-docs, party-pooper).

Audit skills run as chained pipelines — a headless subprocess audits a frozen snapshot while the current session independently verifies findings and applies fixes on the live repo.

Use when: you want structured code review, greenfield project planning, feature design, systematic debugging, or test coverage analysis. See the [agentwright README](agentwright/README.md) for full details.

## [wrightward](wrightward/)

Multi-agent coordination. When multiple Claude Code agents work on the same codebase, wrightward prevents conflicting edits. Run `/wrightward:collab-context` (user or agent can invoke this) in each session to declare what it's working on. From that point, writes to files claimed by another agent are blocked, and context about other agents' work is automatically injected on reads and non-overlapping writes. Files touched via Edit/Write are auto-tracked even if not declared up front.

Use when: you have two or more agents editing/writing to the same repo at the same time. See the [wrightward README](wrightward/README.md) for full details.

## Using them together

The plugins are independent but aware of each other:

- `agentwright` creates frozen snapshot directories for its auditor subprocesses. `wrightward` automatically excludes agents running inside these snapshots from coordination tracking — they are read-only and should not participate in coordination.
- When `wrightward` blocks a write during an audit (because another agent owns the file), agentwright skips the finding and revisits it later when the file is released. Sequential stages wait for all findings to be resolved before advancing.

## License

Apache-2.0