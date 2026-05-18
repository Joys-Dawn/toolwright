---
name: reset
description: Destructive — drop the mindwright database and all markdown mirrors. Requires explicit confirmation. Useful when the schema is corrupt or you want a clean re-bootstrap.
---

# /mindwright:reset

Run via Bash:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/reset.js" --yes --plugin-data "${CLAUDE_PLUGIN_DATA}"
```

Without `--yes` the script prints what it would delete and exits. With `--yes` it deletes `.claude/mindwright/mindwright.db` (plus its `-wal` / `-shm` WAL sidecars) and the entire `.claude/mindwright/mirrors/` tree.

Models (in the plugin's persistent data dir, `${CLAUDE_PLUGIN_DATA}/model-cache`) are NOT touched — they survive reset.

After a reset the project has no memory, and nothing rebuilds the deleted content on its own: there is no automatic SessionStart bootstrap and no background process that re-seeds from your transcript history. (The Stop-hook consolidator only ever distills short-term that already exists into long-term — it never re-seeds, so with an empty store it has nothing to act on.) Memory returns only when you explicitly run `/mindwright:seed-from-repo` (then `/mindwright:dream` to consolidate). So reset is also the clean way to purge unwanted or sensitive memory — drop the DB and simply don't re-seed; nothing re-learns the deleted content behind your back.

`--yes` refuses with a guidance message when either signal says the store is still live: (a) a Claude session is bound to this project (its SessionStart ticket records a process id that is still alive), or (b) the database is actively in use (some connection is holding the SQLite lock right now). There is no expiry window — close the Claude Code session(s) in this project and the binding clears the moment those processes exit; then re-run with `--yes`. Deleting while bound would either fail mid-delete on Windows (the DB file is locked) or, on POSIX, leave the live connection writing to an orphan inode while new hooks open a fresh DB at the same path — both produce silent inconsistency.

Two-stage override for diagnostic recovery (a single-flag override of an irreversible delete was deemed too coarse — the common mistake is mis-judging whether anything is still bound):

- `--force` (alongside `--yes`): the recovery case — a crashed or already-exited session left a stale ticket behind but the DB is genuinely idle. If something is *still* actually bound when you run it (a live session, or a held DB lock), `--force` alone **still refuses**, with a clearer message pointing you at the next flag.
- `--bypass-live-daemon` (alongside `--yes --force`): the second and final flag — **both** `--force` and `--bypass-live-daemon` must be present to override the refusal. Use only when you have manually verified nothing is using the DB and only a stale ticket file is lingering. A wrong call here corrupts state.
