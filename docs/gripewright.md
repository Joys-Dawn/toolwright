# gripewright

> Capture user complaints about agent behavior into a labeled NDJSON corpus. Type `/gripewright:wtf` when the agent goes wrong; the prior turn (and the agent's response to your gripe) is appended to `~/.claude/gripewright/log.ndjson` as a negative training example.

**Version**: 0.3.0 · [Source](https://github.com/Joys-Dawn/toolwright/tree/master/gripewright) · [README](https://github.com/Joys-Dawn/toolwright/blob/master/gripewright/README.md)

## Install

```text
/plugin marketplace add Joys-Dawn/toolwright
/plugin install gripewright@Joys-Dawn/toolwright
```

Requires Node.js ≥ 20. Zero config — the first invocation creates `~/.claude/gripewright/log.ndjson`.

## Using it

When the agent takes a shortcut, dismisses a real issue, fabricates a fact, flip-flops, or ignores your instructions, type one of:

```text
/gripewright:wtf
/gripewright:wtf 3
/gripewright:wtf lazy fix, deleted the test instead of fixing it
/gripewright:wtf 2 ignored my explicit instruction not to commit
```

| Form | Effect |
|---|---|
| `/gripewright:wtf` | Logs the most recent assistant turn. |
| `/gripewright:wtf <N>` | Logs the turn from N user-prompts back. Useful when the bad behavior was several turns ago. |
| `/gripewright:wtf <reason>` | Logs the most recent turn with a free-text reason. |
| `/gripewright:wtf <N> <reason>` | Both. |

After logging, the agent confirms in one short sentence and engages with your reason directly — addressing the critique or briefly reflecting on what likely went wrong.

The "prior user prompt" the record anchors on is the most recent **real** user message before the `/wtf`. Synthetic markers (`<system-reminder>`, `<local-command-stdout>`, `[Request interrupted by user]`) are skipped automatically. Slash commands — including a *prior* `/gripewright:wtf` — do count, so chained gripes work: if the agent's response to one `/wtf` itself deserves another, the second invocation correctly anchors on the first.

## How it works

### Logging the gripable turn

`/gripewright:wtf` runs as SKILL preprocessing — `node scripts/log-wtf.js` executes **before** the model produces any response. The script walks the session transcript, picks the prior real user message, collects every assistant block until that anchor (`text`, `thinking`, `tool_use` plus the corresponding `tool_result` events), and appends one NDJSON record to `~/.claude/gripewright/log.ndjson`.

### Backfilling the model's self-reflection

The model then produces its response to your `/wtf`. Two hooks cooperate to capture it:

- **Stop hook** ([`on-stop.js`](https://github.com/Joys-Dawn/toolwright/blob/master/gripewright/hooks/on-stop.js)) — fires when the response finishes cleanly. Reads the just-completed turn, finds this session's most recent record without `wtf_response`, atomically rewrites `log.ndjson`.
- **UserPromptSubmit hook** ([`on-user-prompt-submit.js`](https://github.com/Joys-Dawn/toolwright/blob/master/gripewright/hooks/on-user-prompt-submit.js)) — fires on every subsequent user prompt as a fallback. Stop does not fire on user interrupts (Esc) — without this hook, an interrupted `/wtf` response would silently lack `wtf_response`. UserPromptSubmit catches that case: if the most recent record for this session is still pending, it backfills with whatever assistant blocks were captured between the `/wtf` and the new prompt.

Both hooks are silent — no user-visible output, exit 0 on every error path. If the transcript is missing, `log.ndjson` doesn't exist, or there's no pending record, they no-op.

`turn_events` plus `wtf_response` lets you study how the model reasons about its own mistakes — not just the bad turn in isolation, but its self-assessment afterward, even when you cut the agent off mid-thought.

## Commands

| Command | Args | Purpose |
|---|---|---|
| `/gripewright:wtf` | `[N] [reason]` | Log the most recent (or N-back) assistant turn as a negative example, with optional free-text reason. |

## Hooks

| Hook | Event | What it does |
|---|---|---|
| [`on-stop.js`](https://github.com/Joys-Dawn/toolwright/blob/master/gripewright/hooks/on-stop.js) | `Stop` | Happy-path capture. Backfills `wtf_response` after the agent's response to `/wtf` finishes cleanly. No-ops when the just-finished turn was not a `/wtf`. |
| [`on-user-prompt-submit.js`](https://github.com/Joys-Dawn/toolwright/blob/master/gripewright/hooks/on-user-prompt-submit.js) | `UserPromptSubmit` | Interrupt-recovery fallback. On every new user prompt, checks if this session's most recent record is still pending; if so, backfills with assistant blocks captured between the `/wtf` and now. Catches text-only and tool-mid-flight interrupts that Stop misses. |

## Record shape

Each invocation appends one JSON object to `~/.claude/gripewright/log.ndjson`:

| Field | Notes |
|---|---|
| `logged_at` | ISO timestamp. |
| `session_id`, `transcript_path`, `cwd`, `git_branch` | Where the gripe happened. |
| `reason` | Your free text, or `null`. |
| `lookback_requested` / `lookback_effective` | Effective is clamped to available prompts. |
| `prior_user_prompt` | `{text, timestamp}` of the prompt that triggered the gripable turn. |
| `turn_events[]` | The agent's full turn you're complaining about — `text`, `thinking`, `tool_use` blocks plus the `tool_result` events that came back. |
| `wtf_response[]` | The agent's response *to your `/wtf`*. Filled in once that response finishes (or on the next user prompt if interrupted). **Absent** on records where neither hook managed to capture. |

## State

| Path | Contents |
|---|---|
| `~/.claude/gripewright/log.ndjson` | One JSON object per line, append-only. Shared across every project and session that uses your home directory. |

No database, no per-project state — back it up like any other dotfile.

## Privacy

The log captures the content of your prompt and the agent's full turn — including any source code, paths, secrets, or tool output that appeared in the transcript. Treat `~/.claude/gripewright/log.ndjson` as sensitive and don't sync it anywhere you don't want that content to go.
