---
name: critique
description: Adversarial critique of an idea, plan, claim, or proposal. Reads the session transcript to find the target, stress-tests it, and makes the strongest case against it.
argument-hint: [optional focus area, e.g. "scaling risks"]
context: fork
agent: agentwright:party-pooper
---

Adversarially critique the most recent plan, proposal, claim, or decision in this conversation. You do not have direct access to the conversation — read it from the session transcript on disk.

## Step 1: Locate the session transcript

The transcript is at `~/.claude/projects/<sanitized-cwd>/${CLAUDE_SESSION_ID}.jsonl`. Locate it with:

```bash
find ~/.claude/projects -name "${CLAUDE_SESSION_ID}.jsonl" 2>/dev/null | head -1
```

## Step 2: Extract the target of critique

The file is JSON Lines and can be thousands of lines. **Only look at the tail** — the recent discussion. Start by reading the last ~300 lines (`tail -n 300 <path>`) and widen the window only if the plan being discussed extends further back.

Entry types you care about:

- **User messages**: `{"type":"user","message":{"content":[{"type":"text","text":"..."}]}}`. Filter out tool results and tool_use_ids:
  ```bash
  tail -n 300 <path> | grep '"type":"user"' | grep -v '"tool_result"' | grep -v '"tool_use_id"'
  ```
  These capture what the user asked about and any refinements they made.

- **Assistant messages**: `{"type":"assistant","message":{"content":[...]}}`. The content array has text blocks where the main agent proposed plans, made recommendations, or stated claims:
  ```bash
  tail -n 300 <path> | grep '"type":"assistant"'
  ```

- Ignore the trailing entries that belong to this `/critique` invocation itself.

From these, identify the **strongest version** of the plan/proposal/claim being discussed. If multiple things could be critiqued, pick the most recent substantive one — or if the user passed arguments, use those to disambiguate.

## Step 3: Critique it

Follow your normal adversarial critique process from your system prompt:

1. Steelman the target first — restate it in the strongest form before attacking.
2. Find every valid critique: failure modes, hidden assumptions, missing edge cases, scaling risks, cost/complexity tradeoffs, ecosystem/team fit, reversibility.
3. Rank critiques by severity. Distinguish **showstoppers** (would make the plan fail) from **concerns** (worth considering but not fatal).
4. Where you have a concrete counter-proposal, state it briefly — but your primary job is finding problems, not designing alternatives.

Do not soften critiques to be diplomatic. Do not reframe the target to make it easier to defend.

## Focus area

If the user passed arguments, use them to focus the critique. Otherwise critique the whole target.

$ARGUMENTS
