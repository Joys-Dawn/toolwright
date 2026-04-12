---
description: Undo Claude's changes since the last prompt (covers Bash mutations)
allowed-tools: Bash(node *), AskUserQuestion
---

Undo every filesystem change Claude made since the most recent user prompt, including changes from Bash commands that native `/rewind` does not track. timewright keeps a single snapshot of the working tree taken at the start of the current turn, and this command restores the working tree to that snapshot.

**Do NOT use `!` preprocessing for any of the steps below.** Every command must be invoked via the Bash tool so it interleaves correctly with `AskUserQuestion` — running the commands during preprocessing would apply the undo before the user has a chance to confirm or cancel.

## Steps

1. Using the **Bash tool**, run:

   ```
   node "${CLAUDE_PLUGIN_ROOT}/bin/undo.js" --diff
   ```

2. Parse the JSON the command prints to stdout.

3. **If `ok` is `false`**: report `error` to the user verbatim and stop. Common cause: no snapshot exists yet (first turn in a new project — nothing to undo to).

4. **If `hasChanges` is `false`**: tell the user "nothing to undo — the working tree already matches the snapshot" and stop.

5. **If `headDrift` is not null**: warn the user loudly. The real git HEAD has moved since the snapshot was taken (they ran `git reset`, `git checkout`, `git rebase`, or similar outside Claude). Show both `headDrift.snapshot` and `headDrift.current` SHAs and explain that undoing will overwrite their current state with snapshot-era state that assumed the old HEAD. Ask whether to proceed anyway before the AskUserQuestion below.

6. Show the user a summary of what will change:
   - **Modified (will be reverted)**: list `modified` — Claude changed these, undo will restore them.
   - **Added (will be DELETED)**: list `added` — these exist now but did not exist in the snapshot. Undo will delete them. **This is the dangerous set** — call it out explicitly, since it may include files the user created in parallel in their IDE.
   - **Removed (will be restored)**: list `removed` — the snapshot had these but they are gone from the working tree.

   If any list has more than 20 entries, show the first 20 and note how many more there are.

7. Use `AskUserQuestion` to confirm. Ask: "Apply this undo? This will overwrite the working tree to match the snapshot." Offer two choices: "Yes, undo" and "No, cancel".

8. **On "Yes, undo"**: using the **Bash tool**, run:

   ```
   node "${CLAUDE_PLUGIN_ROOT}/bin/undo.js" --apply
   ```

   Parse the JSON result.
   - If `ok` is `true` and `errors` is absent or empty, tell the user the undo was applied successfully.
   - If `ok` is `true` but `errors` is a non-empty list, tell the user the undo was **partially** applied and show the list of files that failed (often caused by Windows symlink privilege issues, filesystem permissions, or files held open by another process).
   - If `ok` is `false`, show the `error` field to the user.

9. **On "No, cancel"**: tell the user nothing was changed and stop.
