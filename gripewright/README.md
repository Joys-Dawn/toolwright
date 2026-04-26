# gripewright

Claude Code plugin that captures user complaints about agent behavior into a labeled NDJSON corpus. Type `/gripewright:wtf` when the agent does something you disagree with — gripewright records the prior assistant turn, plus the agent's response to your gripe, as a negative training example.

- **One command, no setup** — `/gripewright:wtf` works the moment the plugin is installed.
- **Captures the full turn you're griping about** — text, thinking, tool calls, and tool results from the assistant turn that prompted your `/wtf`.
- **Pairs each gripe with the model's self-reflection** — the agent's response to your `/wtf` is appended to the same record, so you can study how the model reasons about its own mistakes (even when you cut it off mid-thought).
- **Look back any number of turns** — `/gripewright:wtf 3` anchors three user-prompts back when you only just noticed the bad behavior.
- **Chained gripes work** — if the agent's response to one `/wtf` itself deserves a `/wtf`, the second invocation correctly anchors on the first.
- **One global log across every project** — every gripe appends to `~/.claude/gripewright/log.ndjson`. No per-project state, no setup per repo.

## Installation

```
/plugin marketplace add Joys-Dawn/toolwright
/plugin install gripewright@Joys-Dawn/toolwright
```

Zero config. The first invocation creates `~/.claude/gripewright/log.ndjson`.

## Using it

When the agent takes a shortcut, dismisses a real issue, fabricates a fact, flip-flops, or ignores your instructions, type one of:

```
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

The agent confirms in one short sentence and then engages with your reason directly — addressing the critique or briefly reflecting on what likely went wrong.

## How it works

### Logging the gripable turn

`/gripewright:wtf` runs `node scripts/log-wtf.js` as SKILL preprocessing — **before** the model produces any response. The script walks the session transcript, picks the prior real user message (skipping synthetic markers like `<system-reminder>`, `<local-command-stdout>`, and `[Request interrupted by user]`), collects every assistant block until that anchor, and appends one NDJSON record to `~/.claude/gripewright/log.ndjson`.

Slash commands — including a *prior* `/gripewright:wtf` — count as real user messages, so chained gripes work: if the agent's response to one `/wtf` itself deserves another, the second invocation correctly anchors on the first.

### Backfilling the model's self-reflection

The model then produces its response to your `/wtf`. Two hooks cooperate to capture it:

- **Stop hook** — fires when the response finishes cleanly. Reads the just-completed assistant turn, finds this session's most recent record without a `wtf_response` field, and atomically rewrites `log.ndjson` with `wtf_response` filled in.
- **UserPromptSubmit hook** — fires on every subsequent user prompt as a fallback. Stop does not fire on user interrupts (Esc) — without this hook, an interrupted `/wtf` response would silently lack `wtf_response`. UserPromptSubmit catches that case: if the most recent record for this session is still pending, it backfills with whatever assistant blocks were captured between the `/wtf` and the new prompt.

Both hooks are silent — no user-visible output, exit 0 on every error path. If the transcript is missing, `log.ndjson` doesn't exist, or there's no pending record, they no-op.

`turn_events` plus `wtf_response` lets you study how the model reasons about its own mistakes — not just the bad turn in isolation, but its self-assessment afterward, even when you cut the agent off mid-thought.

## Commands

| Command | Args | Purpose |
|---|---|---|
| `/gripewright:wtf` | `[N] [reason]` | Log the most recent (or N-back) assistant turn as a negative example, with optional free-text reason. |

## Hooks

Two hooks run automatically — no user intervention needed:

| Hook | Event | What it does |
|---|---|---|
| [`on-stop.js`](hooks/on-stop.js) | `Stop` | Happy-path capture. Backfills `wtf_response` after the agent's response to `/wtf` finishes cleanly. No-ops when the just-finished turn was not a `/wtf`. |
| [`on-user-prompt-submit.js`](hooks/on-user-prompt-submit.js) | `UserPromptSubmit` | Interrupt-recovery fallback. On every new user prompt, checks if this session's most recent record is still pending; if so, backfills with assistant blocks captured between the `/wtf` and now. Catches text-only and tool-mid-flight interrupts that Stop misses. |

## Record shape

Each `/gripewright:wtf` invocation appends one JSON object:

```json
{
  "logged_at": "2026-04-26T10:13:00Z",
  "session_id": "777c43c1-…",
  "transcript_path": "/path/to/session.jsonl",
  "cwd": "/path/to/repo",
  "git_branch": "main",
  "reason": "lazy fix, deleted the test instead of fixing it",
  "lookback_requested": 1,
  "lookback_effective": 1,
  "prior_user_prompt": { "text": "fix the failing test", "timestamp": "…" },
  "turn_events": [
    { "type": "thinking", "text": "…", "timestamp": "…" },
    { "type": "text", "text": "…", "timestamp": "…" },
    { "type": "tool_use", "name": "Bash", "input": { "command": "rm test/foo.test.js" }, "timestamp": "…" },
    { "type": "tool_result", "content": "…", "timestamp": "…" }
  ],
  "wtf_response": [
    { "type": "thinking", "text": "…", "timestamp": "…" },
    { "type": "text", "text": "Logged wtf. You're right — deleting…", "timestamp": "…" }
  ]
}
```

`wtf_response` is **absent** (not `null`) on records where neither hook managed to capture the response.

## State

All gripes go to a single file:

| Path | Contents |
|---|---|
| `~/.claude/gripewright/log.ndjson` | One JSON object per line, append-only, shared across every project and session that uses your home directory. |

No database, no per-project state — back it up like any other dotfile.

## Privacy

The log captures the content of your prompt and the agent's full turn — including any source code, paths, secrets, or tool output that appeared in the transcript. Treat `~/.claude/gripewright/log.ndjson` as sensitive and don't sync it anywhere you don't want that content to go.

## Requirements

- Node.js ≥ 20
- No external dependencies

## License

Apache-2.0
