---
name: reset
description: Destructive — drop the mindwright database and all markdown mirrors. Requires explicit confirmation. Useful when the schema is corrupt or you want a clean re-bootstrap.
---

# /mindwright:reset

Run via Bash:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/reset.js" --yes
```

Without `--yes` the script prints what it would delete and exits. With `--yes` it deletes `.claude/mindwright/mindwright.db` and the entire `.claude/mindwright/mirrors/` tree.

Models (`~/.cache/huggingface/hub/`) are NOT touched — they survive reset.

After a reset, mindwright treats the project as a fresh install: the next Claude Code session automatically re-learns from this project's local transcript history in the background, re-spending subscription tokens to rebuild what you just deleted. If you are resetting to purge unwanted or sensitive memory (not just to rebuild a corrupt schema), set `MINDWRIGHT_AUTO_SEED=false` in your environment before the next session so it does not come back. The dry-run and the post-delete output both print this reminder when local transcripts are present.

If an active mindwright daemon is bound to this project, `--yes` refuses with a guidance message. Close the Claude Code session(s) in the project first (wait ~10s for the ticket to expire) and re-run. Deleting underneath a live daemon would either fail mid-delete on Windows (DB file locked) or leave the daemon writing to an orphan inode on POSIX while new hooks open a fresh DB at the same path — both produce silent inconsistency.

Two-stage override for diagnostic recovery (single-flag override of a destructive op was deemed too coarse — it's irreversible if you guess wrong about the daemon being dead):

- `--force` (alongside `--yes`): use when you're confident the daemon process is dead but its ticket may still be inside the 10-min freshness window. If the daemon is still showing alive at the moment you run this, `--force` will *still refuse* with a clearer message — only the next flag actually overrides.
- `--bypass-live-daemon` (alongside `--yes --force`): the nuclear option. Used after `--force` refused. Says "I have manually verified the daemon process is dead and only the ticket file is lingering." Wrong call here corrupts state.
