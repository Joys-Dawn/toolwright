---
name: seed-from-repo
description: Bootstrap memory from the current repo — pulls signals from CLAUDE.md, README, and Claude Code's native per-project memory into short-term rows for the next dream cycle to consolidate.
---

# /mindwright:seed-from-repo

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/seed-from-repo.js"
```

The script reads:
- `CLAUDE.md` (project root only by default)
- `README.md` (root)
- Claude Code's native per-project memory (`~/.claude/projects/<encoded-cwd>/memory/*.md`) — these LLM-written notes are an always-included source, re-distilled through consolidation like any other seed input (not direct-mapped to long-term)

Each item lands as a `short` tier entry with `kind=seed`. Native-memory rows additionally carry an `event_ts` (frontmatter date or file mtime) so recall ranks them by when the note was actually written, not the seed-run time. The next `/mindwright:dream` distills them into long-term facts.

**Idempotent**: re-running skips any source file already represented by an active short `seed` row (matched on the source_ref file-path prefix), so repeated invocations don't pile duplicates. An edited file is not re-chunked until its current rows are drained by a dream cycle — staleness until the next consolidation is accepted by design rather than re-diffing on every run.

> Transcript history (`~/.claude/projects/<encoded-cwd>/*.jsonl`) is **not** seeded by this script. It is bootstrapped automatically by the dedicated transcript loop SessionStart fires on a fresh empty install (gated by `MINDWRIGHT_AUTO_SEED`, default on) — see DESIGN.md "Bootstrap". This script covers the repo-local + native-memory sources only.

Report the script's `next_step` field (printed in the stdout JSON) to the user verbatim:
- Normally "Run /mindwright:dream to consolidate the seeded rows" when rows landed under the live calling session.
- When no live Claude session ticket is found, the rows land under the synthetic `seed-from-repo` session instead, and `next_step` will tell the user they must run `/mindwright:dream` with `scope="all"` for this batch to be picked up. Surfacing it prevents a silent miss where a default session-scoped dream skips the seeded rows.
- When nothing new was inserted because every source is already an un-drained short `seed` row, `next_step` still points at `/mindwright:dream` (consolidate the existing rows) rather than reporting "nothing found".

### Ancestor walking (opt-in)

If the user wants ancestor CLAUDE.md files included (monorepo with shared docs in a parent dir, or a legitimate cross-repo CLAUDE.md), pass `--include-ancestors`:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/seed-from-repo.js" --include-ancestors
```

Default is project-root-only because walking parents would pull in `~/.claude/CLAUDE.md` (the user's global config — typically holds personal preferences, account handles, SSH aliases, machine details). Those facts do not belong in a single project's mindwright DB and would surface in retrieval for unrelated work after `/mindwright:dream` consolidates them.
