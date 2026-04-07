---
name: challenge
description: Independently verify a disputed claim by dispatching two investigators with opposing hypotheses. Use when you disagree with the model's diagnosis, explanation, or proposed fix.
argument-hint: [optional — the specific claim to challenge]
---

You are being asked to independently verify a claim from this conversation. Do NOT flip-flop, speculate, or give your own opinion. Instead, dispatch two investigators and let the evidence decide.

## Step 1: Extract the disputed claim

Identify the most recent substantive claim from this conversation that the user is challenging. If the user passed `$ARGUMENTS`, use that as the claim. Otherwise, find the last claim you made — this could be about code behavior, a bug cause, a proposed fix, an API's capabilities, a library recommendation, a best practice, or any other factual assertion.

Restate the claim as a precise, testable hypothesis. Be specific — "the bug is in auth" is not testable. "The `validateToken` function in `src/auth/middleware.ts` fails to check token expiry" is testable. "React recommends using useEffect for data fetching" is testable. "This API supports pagination" is testable.

Also identify the relevant context: file paths for code claims, API/library names and versions for technical claims, or the specific assertion to look up for factual claims.

## Step 2: Dispatch two detective agents IN PARALLEL

You MUST use the Agent tool with `subagent_type` set to exactly `agentwright:detective` for both agents. Do NOT use `general-purpose` or any other agent type. The detective agent is specifically designed for hypothesis investigation and has the right system prompt for this task.

Launch both agents in a **single message** (two Agent tool calls) so they run in parallel:

**Detective A — Defender:**
In the `prompt`, include:
- The hypothesis stated precisely
- Directive: "Find evidence that SUPPORTS this claim"
- The relevant file paths and code locations
- Any specific assumptions to verify

**Detective B — Challenger:**
In the `prompt`, include:
- The exact same hypothesis (identical wording)
- Directive: "Find evidence that CONTRADICTS this claim. Look for alternative explanations."
- The same file paths and code locations
- The same assumptions to verify

Both agents must receive identical context about the claim — only the directive differs. Include the session ID `${CLAUDE_SESSION_ID}` in both prompts so the agents can optionally read the full transcript if they need more context.

## Step 3: Critically evaluate both reports

After both detectives return, compare their findings. Focus on the **evidence**, not the conclusions. Evaluate:

- Did both agents verify the same assumptions? Did any assumption turn out to be false?
- Does the evidence from one side directly refute specific evidence from the other?
- Is either report based on speculation rather than code they actually read?
- Is there evidence that BOTH missed? If so, check it yourself before ruling.

Then pick a verdict:

- **Original claim correct** — the defender's evidence holds up and the challenger found nothing that refutes it
- **Original claim wrong** — the challenger found concrete evidence against it. State the alternative explanation.
- **Both partially right** — the claim is directionally correct but missing nuance or the real cause is related but different
- **Inconclusive** — neither side produced strong evidence. State what additional investigation would resolve it.

## Step 4: Present the verdict

Report to the user:

1. The claim that was investigated (one sentence)
2. The verdict (one of the four above)
3. Key evidence from both sides (cite file paths and line numbers from the detective reports)
4. Your reasoning for the verdict

Do NOT soften the verdict to avoid disagreeing with your earlier self. If your original claim was wrong, say so plainly. The entire point of this skill is to get an unbiased answer — defeating that by being diplomatic about the result defeats the purpose. At the same time, do NOT flip-flop just because your claim was challenged. If you think you are correct stand by it.
