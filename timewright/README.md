# timewright

Claude Code plugin that lets you undo everything Claude changed since your last prompt — including changes made by Bash commands (npm install, build scripts, git operations, file deletions) that Claude's built-in `/rewind` doesn't cover.

## Installation

```
/plugin marketplace add Joys-Dawn/toolwright
/plugin install timewright@Joys-Dawn/toolwright
```

No configuration needed — hooks activate automatically.

## How to use it

Type `/undo` after Claude makes changes you want to revert.

```
/undo
```

Claude will show you exactly what will change:

- **Modified** — files Claude changed, will be reverted to their state before Claude's turn
- **Added** — files that didn't exist before, will be deleted
- **Removed** — files Claude deleted, will be restored

You'll be asked to confirm before anything is applied.

## What it covers

timewright snapshots your working tree at the start of every Claude turn, so `/undo` reverts changes from **all** mutating tools:

- **Bash** — any command that modifies tracked or untracked source files (`rm -rf`, migrations, `git reset`, sed/awk rewrites, etc.)
- **Write** — new files Claude creates
- **Edit** — inline edits to existing files
- **NotebookEdit** — Jupyter notebook changes

Read-only tools (Read, Grep, Glob) don't trigger snapshots — they're free.

**Important**: timewright respects `.gitignore` and excludes directories like `node_modules/`, `dist/`, `build/`, etc. This means `/undo` cannot restore the contents of those directories. For example, if Claude runs `npm install`, the changes to `package.json` and `package-lock.json` are covered, but the installed packages in `node_modules/` are not. Re-run `npm install` after undoing if needed.

## How it works

1. When you submit a prompt, timewright takes a snapshot of your project's current state
2. Claude does its work (edits files, runs commands, etc.)
3. If you don't like the result, `/undo` restores every file to the snapshot
4. If you're happy with the result, do nothing — the next prompt takes a fresh snapshot automatically

Only one snapshot exists at a time. Each new prompt replaces the previous snapshot.

## What gets preserved

The snapshot captures your in-progress work too. If you had unsaved edits, uncommitted changes, or untracked files when Claude started its turn, `/undo` restores those — not just the last git commit.

## What gets excluded

timewright respects your `.gitignore` and also excludes:

- `node_modules/`, `dist/`, `build/`, `.next/`, and other build output directories
- `.env` and `.env.local` (secret files are never copied into the snapshot)
- `.git/` internals

Non-secret dotenv files like `.env.example` and `.env.template` are included normally.

## What `/undo` does NOT cover

`/undo` rewinds your **project directory**, not your machine. Anything outside the git repo is out of scope:

- Files in `~`, `C:\`, or other user/system directories that Claude touched via Bash (e.g., `echo x > ~/.bashrc`, edits to `C:\Users\you\AppData\...`)
- Global package installs, system configuration changes, or side effects of Bash commands that live outside the repo
- Commits, pushes, or branch operations on a different repository Claude may have `cd`'d into mid-session

The snapshot is bounded to the git repo where Claude was launched. Only files inside that repo (that git would list via `ls-files` or that are dirty) are captured — and only those are restored on `/undo`.

## Head drift warning

If you (or another tool) run git commands that move HEAD between the snapshot and the undo (e.g., `git checkout`, `git reset`, `git rebase`), timewright warns you before applying. The undo would restore files to a state that assumed the old HEAD — which may not be what you want.

## Partial failures

If some files can't be restored (locked by another process, permission issues), timewright reports exactly which files failed and which succeeded. Nothing is silently skipped.

## State

All timewright state lives in `.claude/timewright/` inside your project:

- `snapshot/` — the file tree snapshot
- `snapshot.json` — metadata (timestamp, git HEAD at snapshot time)
- `stale.d/` — internal flag directory

This directory is automatically excluded from snapshots and git.

## Requirements

- Git (timewright uses git plumbing for efficient snapshotting)
- Node.js >= 18
- No external dependencies

## License

Apache-2.0
