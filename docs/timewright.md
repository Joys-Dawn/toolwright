# timewright

> Single-slot undo for Claude's in-session changes — including Bash-driven mutations (deletions, `sed`/`git` rewrites) that native `/rewind` misses.

**Version**: 1.2.0 · [Source](https://github.com/Joys-Dawn/toolwright/tree/master/timewright) · [README](https://github.com/Joys-Dawn/toolwright/blob/master/timewright/README.md)

## Install

```text
/plugin marketplace add Joys-Dawn/toolwright
/plugin install timewright@Joys-Dawn/toolwright
```

Requires Node.js ≥ 18 and a git repository (timewright uses `git worktree add HEAD` for snapshotting). Zero config.

## Using it

Type `/undo` to revert Claude's changes from the last turn.

1. Claude runs `node bin/undo.js --diff` and prints a three-bucket summary:
    - **Modified (will be reverted)** — restored from snapshot.
    - **Added (will be DELETED)** — the dangerous set; may include files you created in parallel.
    - **Removed (will be restored)** — snapshot had them, working tree doesn't.
    - Lists > 20 truncate with "…and N more".
2. If `HEAD` moved between the snapshot and now (e.g., you ran `git reset` or `git checkout`), Claude prints `headDrift.snapshot` and `headDrift.current` SHAs and warns.
3. `AskUserQuestion` asks "Apply this undo?" — **Yes, undo** or **No, cancel**.
4. On **Yes**, Claude runs `node bin/undo.js --apply` and confirms. If some files couldn't be restored (locked by another process, Windows symlink-privilege, etc.), the exact list is reported.

## Coverage

| Tool | Covered |
|---|---|
| `Bash` | Any command that modifies tracked or untracked source files inside the repo — `rm -rf`, migrations, `git reset`, `sed`/`awk` rewrites. |
| `Write` / `Edit` | All in-repo file operations. |
| `NotebookEdit` | Jupyter notebook changes. |

`Read`/`Grep`/`Glob` don't trigger snapshots — they're free.

Files outside the git repo, global package installs, and side effects of Bash commands living outside the repo are not tracked.

## Snapshot model

- **When**: every `UserPromptSubmit` where a mutating tool fired in the previous turn. Pure Read/Grep/Glob turns skip snapshotting entirely.
- **What**: every tracked file (`git ls-files`) plus every dirty or untracked file in the working tree. Includes uncommitted edits.
- **Where**: `.claude/timewright/snapshot/` inside the repo root.
- **Single-slot**: each new prompt replaces the previous snapshot. `/undo` rewinds to the *most recent* snapshot only — no history.

The `UserPromptSubmit` hook recognizes `/undo` and `/timewright:undo` and skips snapshotting on those turns so the existing snapshot stays consumable.

## Excluded paths

Combines `.gitignore` (via `git ls-files`) with an explicit exclusion set.

- Directories (any path segment matches): `.claude`, `node_modules`, `.git`, `dist`, `build`, `.next`, `.nuxt`, `.output`, `.turbo`, `.vercel`, `.svelte-kit`, `coverage`, `__pycache__`, `.pytest_cache`, `.mypy_cache`, `.ruff_cache`.
- Secret env files (basename match): `.env`, `.env.local`, `.env.development.local`, `.env.test.local`, `.env.production.local`.

`.env.example`, `.env.template`, and `.env.sample` are **included** — those are routinely committed.

!!! note "Installed packages aren't snapshot"
    If Claude runs `npm install`, undo restores `package.json`/`package-lock.json` but not `node_modules/`. Re-run `npm install` after undoing a dependency change.

## Hooks

| Hook | Event | What it does |
|---|---|---|
| [`on-session-start.js`](https://github.com/Joys-Dawn/toolwright/blob/master/timewright/hooks/on-session-start.js) | `SessionStart` | Resolves the git repo root from the launch `cwd` and records it at `<repoRoot>/.claude/timewright/root` so later hooks find the project root even if Claude `cd`s into a subdirectory. |
| [`on-user-prompt-submit.js`](https://github.com/Joys-Dawn/toolwright/blob/master/timewright/hooks/on-user-prompt-submit.js) | `UserPromptSubmit` | Clears the stale marker and creates a snapshot. Skips on `/undo`. |
| [`on-post-tool-use.js`](https://github.com/Joys-Dawn/toolwright/blob/master/timewright/hooks/on-post-tool-use.js) | `PostToolUse` on `Bash\|Write\|Edit\|NotebookEdit` | Flips the stale flag so the next `UserPromptSubmit` takes a fresh snapshot. |

All three hooks fail silently to stderr — they never block a session start, prompt, or tool call.

## CLI

[`bin/undo.js`](https://github.com/Joys-Dawn/toolwright/blob/master/timewright/bin/undo.js):

| Invocation | Behavior |
|---|---|
| `node bin/undo.js --diff` | Prints JSON with `modified`, `added`, `removed`, `headDrift`, `counts`, `hasChanges`, `snapshotCreatedAt`. |
| `node bin/undo.js --apply` | Restores the snapshot. Prints JSON with `ok`, `applied`, and (partial) `errors`. |

The `/undo` command invokes both via the Bash tool (not `!` preprocessing) so you confirm between `--diff` and `--apply`.

## State directory

`.claude/timewright/` (auto-gitignored):

- `snapshot/` — file-tree snapshot
- `snapshot.json` — timestamp + git HEAD at snapshot time
- `stale.d/` — internal flag directory
- `root` — project-root anchor file
