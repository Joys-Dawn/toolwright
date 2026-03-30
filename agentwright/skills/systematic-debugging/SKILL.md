---
name: systematic-debugging
description: "Guides root-cause analysis with a structured process: reproduce, isolate, hypothesize, verify. Use when debugging bugs, investigating failures, or when the user says something is broken or not working as expected."
---
# Systematic Debugging

Work through failures in order. Don't guess at fixes until the cause is narrowed down.

## Scope

- **User reports a bug**: Clarify what "wrong" means (error message, wrong result, crash, hang). Get steps to reproduce or environment details if missing.
- **User points at code**: Treat that as the suspected area; still reproduce and isolate before changing code.
- **Logs/stack traces provided**: Use them to form hypotheses; don't ignore them.

## Process

### 1. Reproduce

- Confirm the failure is reproducible. If not, note that and list what's needed (e.g. data, env, steps).
- Identify: one-off or intermittent? In which environment (dev/staging/prod, OS, version)?
- Output: "Reproducible: yes/no. How: …"

### 2. Isolate

- Shrink the problem: minimal input, minimal code path, or minimal config that still fails.
- Bisect if useful: which commit, which option, which input range?
- Remove variables (other features, network, time) to see when the failure goes away.
- Output: "Failure occurs when: …" and "Failure does not occur when: …"

### 3. Hypothesize

- State one or more concrete hypotheses that explain the observed behavior (e.g. "null passed here", "race between A and B", "wrong type at runtime").
- Tie each hypothesis to evidence from reproduce/isolate (logs, stack trace, line numbers).
- Prefer the simplest hypothesis that fits the evidence.
- Output: "Hypothesis: …" with "Evidence: …"

### 4. Verify

- Propose a minimal check (log, assert, unit test, or one-line change) that would confirm or rule out the top hypothesis.
- If the user can run it, give the exact step. If you can run it (e.g. tests), do it.
- After verification: "Confirmed: …" or "Ruled out; next hypothesis: …"

### 5. Fix

- Only suggest a fix after the cause is confirmed or highly likely.
- Fix the root cause when possible; document or ticket workarounds if you suggest one.
- Suggest a regression test or assertion so the bug doesn't come back.

## Output

- Prefer short bullets over long paragraphs.
- Always cite file/line/function when pointing at code.
- If stuck (can't reproduce, no logs), say what's missing and what would help next.
- Don't suggest random fixes (e.g. "try clearing cache") without tying them to a hypothesis.
