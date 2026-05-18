---
name: seed-from-repo
description: Bootstrap memory from this project — pulls CLAUDE.md, README, Claude Code's native per-project memory, AND your conversation transcript history into short-term rows, consolidating each bounded slice in THIS session. The only seeding entrypoint; transcript history is always included.
---

# /mindwright:seed-from-repo

The single manual seeding command. Seeding **and** consolidation are fully
user-invoked and run **in this session**: there is no automatic SessionStart
bootstrap and no background `claude --bg` consolidator spawned on your behalf.
You (this agent) do the consolidation yourself, inline, on each slice.

A full transcript history is far too large to seed-and-distill in one shot —
one consolidator pass cannot digest that volume — so this runs as a bounded,
resumable loop.

## The loop

1. **Seed one slice:**

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/seed-from-repo.js" --plugin-data "${CLAUDE_PLUGIN_DATA}"
   ```

   It ingests a bounded slice into `short`-tier `kind=seed` rows from every
   source — `CLAUDE.md` (project root only by default), `README.md`, Claude
   Code's native per-project memory (`~/.claude/projects/<encoded-cwd>/memory/*.md`),
   and **conversation transcript history** (`*.jsonl` — the whole point of
   seeding). The live session is skipped (it has an `offsets` row) so live
   content is never double-ingested. Native-memory and transcript rows carry
   an `event_ts` so recall ranks them by when the memory actually happened,
   not the seed-run time.

2. **Consolidate that slice now, in this session.** Parse the stdout JSON.
   If `short_rows_inserted` or `transcript_rows_inserted` is > 0, run
   `/mindwright:dream` with the scope the script's `next_step` specifies
   (`scope="all"` whenever transcript rows landed — they seed under their
   original session ids, which a default session-scoped dream skips). Repeat
   `/mindwright:dream` passes until that scope's short-term is drained: one
   drain pass is capped (`DRAIN_MAX_ROWS`), so a slice may take several
   passes. **This is the consolidation — performed by you, not a spawned
   process.**

3. **Continue if more remains.** If the JSON has `more_remaining: true`,
   more transcript history is queued — go back to step 1. Each transcript
   commits atomically with its offset advance, so the next run resumes
   exactly where this one stopped; nothing is re-ingested or lost.

4. **Stop conditions.** Stop when a run returns `more_remaining: false`. To
   protect this session's context, do at most **5** slice iterations per
   invocation; if you reach that with `more_remaining` still true, tell the
   user verbatim: *"Seeded and consolidated N slices; more transcript history
   remains — re-run /mindwright:seed-from-repo to continue (it resumes
   automatically)."*

Always relay the script's `next_step` field to the user. Cases it covers
besides transcripts: repo/native rows only, under the live calling session →
a plain `/mindwright:dream` consolidates them; no live session ticket → rows
land under the synthetic `seed-from-repo` session and `next_step` directs
`scope="all"`; nothing new inserted (all sources already have un-drained
short `seed` rows) → `next_step` still points at `/mindwright:dream` to
consolidate the existing rows.

**Idempotent / resumable:** re-running skips any markdown/native source
already represented by an active short `seed` row; transcript seeding
resumes via the `offsets` table, so an already-seeded transcript is never
re-ingested.

### Ancestor walking (opt-in)

If the user wants ancestor CLAUDE.md files included (monorepo with shared
docs in a parent dir, or a legitimate cross-repo CLAUDE.md), pass
`--include-ancestors`:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/seed-from-repo.js" --include-ancestors --plugin-data "${CLAUDE_PLUGIN_DATA}"
```

Default is project-root-only because walking parents would pull in
`~/.claude/CLAUDE.md` (the user's global config — typically holds personal
preferences, account handles, SSH aliases, machine details). Those facts do
not belong in a single project's mindwright DB and would surface in
retrieval for unrelated work after `/mindwright:dream` consolidates them.
