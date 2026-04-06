---
name: verify
description: Verify that completed work matches what was requested. Reads the session transcript directly and checks implementations against claims.
argument-hint: [optional focus area]
context: fork
agent: agentwright:verifier
---

Verify the work that was just completed. Your scope is **uncommitted changes** (what `git diff` shows) plus anything recently committed as part of the current task — not the entire session history. The session transcript is only a source for *what was claimed* about those changes.

## Step 1: Locate the session transcript

The transcript is at `~/.claude/projects/<sanitized-cwd>/${CLAUDE_SESSION_ID}.jsonl`. Locate it with:

```bash
find ~/.claude/projects -name "${CLAUDE_SESSION_ID}.jsonl" 2>/dev/null | head -1
```

## Step 2: Extract the recent request and claims

The file is JSON Lines and can be thousands of lines across a long session. **Only look at the tail** — the current task. Start by reading the last ~200 lines (`tail -n 200 <path>`) and work backward only if you need more context.

Entry types you care about:

- **User requests**: `{"type":"user","message":{"content":[{"type":"text","text":"..."}]}}`. Filter out tool results and tool_use_ids:
  ```bash
  tail -n 200 <path> | grep '"type":"user"' | grep -v '"tool_result"' | grep -v '"tool_use_id"'
  ```
  The most recent real user message (ignoring the `/verify` invocation itself) is the task to verify.

- **Assistant claims and tool calls**: `{"type":"assistant","message":{"content":[...]}}`. The content array has text blocks (the claims) and `tool_use` blocks. Edit/Write/NotebookEdit tool_use blocks contain `input.file_path` — those are the files actually modified.
  ```bash
  tail -n 200 <path> | grep '"type":"assistant"'
  ```

- Ignore the trailing entries that belong to this `/verify` invocation itself.

If `git diff` shows changes that go back further than the last 200 lines of transcript, widen the tail window until you have the full picture of the current task.

## Step 3: Verify

Now follow your normal verification process from your system prompt:

1. **Scope**: state what was requested (from user messages) and what was claimed (from assistant text + tool calls). Do not paraphrase optimistically — use the agent's own words for claims.
2. **Check each claim**: read the touched files and confirm the claimed changes are present and correct.
3. **Check the diff**: run `git diff` (or compare against a snapshot directory if the transcript mentions one) to find unstated changes.
4. **Check for regressions**: run relevant tests in the affected area if they exist.
5. **Verdict**: PASS / FAIL / PARTIAL with specific file paths and line numbers for any issues.

## Focus area

If the user passed arguments, focus the verification on that area. Otherwise verify everything that was claimed.

$ARGUMENTS
