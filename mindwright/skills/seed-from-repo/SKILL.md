---
name: seed-from-repo
description: Bootstrap memory from this project — pulls CLAUDE.md, README, Claude Code's native per-project memory, AND your conversation transcript history into short-term rows for the next dream cycle to consolidate. This is the only seeding entrypoint; transcript history is always included.
---

# /mindwright:seed-from-repo

The single manual seeding command. Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/seed-from-repo.js"
```

It ingests **every** source — transcript history is not optional, it is the
whole point of seeding:
- `CLAUDE.md` (project root only by default)
- `README.md` (root)
- Claude Code's native per-project memory (`~/.claude/projects/<encoded-cwd>/memory/*.md`) — LLM-written notes, re-distilled through consolidation like any other seed input
- **Conversation transcript history** (`~/.claude/projects/<encoded-cwd>/*.jsonl`) — every pre-install transcript, via the bounded/resumable seed loop. The current live session is skipped (it has an offsets row), so live content is never double-ingested.

Each item lands as a `short` tier entry with `kind=seed`. Native-memory and transcript rows carry an `event_ts` (the note's frontmatter date / the transcript record's real timestamp) so recall ranks them by when the memory actually happened, not the seed-run time. The next `/mindwright:dream` distills everything into long-term facts.

**Idempotent / resumable**: re-running skips any markdown/native source already represented by an active short `seed` row; transcript seeding resumes via the `offsets` table, so an already-seeded transcript is never re-ingested. Auto-seeding was removed — there is no longer any automatic SessionStart bootstrap or background `claude --bg` consolidator spawned on your behalf; seeding only happens when you run this command, and consolidation only when you run `/mindwright:dream`.

Report the script's `next_step` field (printed in the stdout JSON) to the user verbatim:
- When transcript rows were seeded, `next_step` instructs `/mindwright:dream` with `scope="all"` — required because transcript history seeds under its original session ids, which a default session-scoped dream would skip.
- With no transcripts, only repo/native rows under the live calling session: a plain `/mindwright:dream` consolidates them.
- No live session ticket: repo/native rows land under the synthetic `seed-from-repo` session and `next_step` directs `scope="all"`.
- Nothing new inserted (all sources already un-drained short `seed` rows): `next_step` still points at `/mindwright:dream` to consolidate the existing rows.

### Ancestor walking (opt-in)

If the user wants ancestor CLAUDE.md files included (monorepo with shared docs in a parent dir, or a legitimate cross-repo CLAUDE.md), pass `--include-ancestors`:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/seed-from-repo.js" --include-ancestors
```

Default is project-root-only because walking parents would pull in `~/.claude/CLAUDE.md` (the user's global config — typically holds personal preferences, account handles, SSH aliases, machine details). Those facts do not belong in a single project's mindwright DB and would surface in retrieval for unrelated work after `/mindwright:dream` consolidates them.
