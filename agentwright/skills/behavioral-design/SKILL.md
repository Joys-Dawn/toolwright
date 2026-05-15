---
name: behavioral-design
description: Designs the WHAT of a feature, project, or idea — fully specified behaviors, triggers, edge cases, alternatives, and acceptance criteria — without any implementation language. Works at any scale: one Job for a feature, many Jobs for a whole greenfield product. Use upstream of feature-planning / project-planning when the WHAT itself needs to be decided, not just how to build it. Examples: "when should this passive skill trigger and how should edge cases be handled" (feature), "what's the user behavior of this new product before we pick a stack" (greenfield), "when should this hook approve vs reject a tool call" (primitive).
---

# Behavioral Design

Before doing anything, enter plan mode. While in plan mode, produce a complete, implementation-ready **behavioral** specification. This skill designs WHAT the thing does, not HOW it's built. The output is a `behavioral-design.md` artifact that downstream planning skills (`feature-planning`, `project-planning`) consume so they can focus on the implementation.

**Scale.** This skill works at any scale — a single feature, a primitive (hook / CLI command / scheduled job), or an entire greenfield product. The techniques are the same; what changes is multiplicity. A feature usually has **one Job Story** + one Main Success Scenario + one Extensions sweep. A greenfield product has **multiple Job Stories** (one per distinct Job the product serves — e.g., for a notes app: capture, retrieve, share, organize) + one MSS per Job + one Extensions sweep per Job. Run the steps once per Job; the cross-Job sections (Alternatives, Simplicity, Pre-Mortem, Acceptance, Out of Behavior, Open Questions) are written holistically across all Jobs.

## Trigger

When this skill is invoked, **immediately enter plan mode** using the EnterPlanMode tool. All elicitation, exploration, and design work happens inside plan mode. The deliverable is the design document — no code, no implementation steps, no file paths.

## Scope

- **Idea / feature request**: Treat the user's description as a starting point, not the spec. The spec is what *you* (the agent) construct from it, then validate with them.
- **Vague request**: That's expected — your job is to make it concrete using deep, critical thinking, then bring concrete proposals to the user.
- **Detailed request**: Validate it against the elicitation passes. A user who arrives with a "complete" spec has almost always under-specified edge cases, alternatives, or simplification opportunities. Run the passes anyway.

**What this skill does NOT cover:**
- Data models, schemas, APIs, file paths, module structure, state-management mechanics — those belong in `feature-planning` or `project-planning`.
- Visual layout, surfaces, screen organization — that's `agentwright:ui-design` (run after this).
- Implementation steps, blast radius, test sequencing — also planning's job.

**The implementation-language rule.** The output must describe what the thing DOES in terms a user or domain expert would use, not in terms of code primitives. The only exception is when the subject *is* a primitive — designing a hook, a CLI command, a SDK function, a scheduled job. In that case the primitive is the noun, but its behavior is still expressed as inputs → conditions → outcomes, not as code. "When a `PreToolUse` event for `Bash` fires AND the command starts with `rm -rf`, the hook rejects with reason X" — that's behavioral. "The hook calls `parseCommand()` and returns `{approve: false, reason}`" — that's HOW, not WHAT.

## What this skill produces

A `behavioral-design.md` file containing: Job Story, Main Success Scenario, Extensions (edge cases), optional Decision Table or State Diagram, Alternatives Considered (with the load-bearing assumptions), Simplicity Notes, Pre-Mortem failure modes, Acceptance Criteria, Out of Behavior, and Open Questions. No HOW content.

## Working principle: agent generates, user validates

**You — the agent running this skill — are the one doing the design thinking.** Don't push the work back to the user with blank-canvas questions. They're busy, they don't have your breadth across techniques, and they will miss things you wouldn't. Their role is to provide domain context, constraints, priorities, and corrections — not to brainstorm every edge case, every alternative, and every failure mode from scratch.

For every step in the process below:

1. **Reason through it yourself first.** Use the named technique, your domain knowledge, what you can read from the codebase, and your understanding of how this kind of thing typically works. Generate a concrete candidate — a drafted Job Story, a drafted Main Success Scenario, an exhaustive list of edges per MSS step, named alternatives with their load-bearing assumptions, candidate failure modes. Think deeply and critically; produce specifics, not vague gestures.

2. **Present your candidates as a concrete strawman.** Bring the user a *proposal*, not a *question*. "I drafted X — here it is. Confirm, correct, or add what I missed." Concrete proposals provoke specific reactions; blank questions provoke vague agreement or fatigue. This is the strawman-proposal technique: reviewers improve specific proposals far better than they invent from scratch.

3. **Take the user's input as the signal that grounds your work.** They know things you don't — their real users, their constraints, their history, their priorities. They will:
   - **Confirm** items where you got it right (good — record the confirmation).
   - **Correct** items where domain context shifts the answer (revise the doc).
   - **Reject** items that don't apply to their reality (drop and explain why in the doc).
   - **Add** items you couldn't have known (rare but valuable — capture verbatim).

4. **Polanyi's principle applies — "we can know more than we can tell."** A user who's asked "what edge cases?" tends to surface 2–3 and stop. A user who's shown "here are 12 candidate edges I generated; tell me the intended behavior, mark inapplicable, or add ones I missed" reliably produces a much fuller spec. The cognitive move from *generate* to *recognize* is the unlock.

5. **Realistic candidates only — no theater.** "Generate" means surface every *plausible, defensible* candidate you can think of from genuine reasoning. It does NOT mean manufacture filler to hit a count, invent edge cases that don't realistically apply to this feature, fabricate "alternatives" that nobody would actually consider, or write strawman failure modes just to look thorough. If a lens turns up nothing real for a given step, say so — empty is better than fake. A user pruning 12 real edges to 5 is collaboration; a user pruning 12 fake edges to 0 is wasted time and lost trust. When in doubt about a candidate: include it but mark your uncertainty ("this may not apply because...") so the user can decide quickly.

**What this looks like across the 8 steps.** For each step, you do real work in the language of the named technique before opening your mouth to the user. The "Verbatim prompts" below are what you say to the user *after* you've done the thinking — they're validation prompts, not delegation prompts.

**The one exception is Step 8** (tacit-knowledge sweep), where the user has access to past-tense concrete instances you genuinely can't generate. There you ask for the narrative; you don't draft it.

## Process

8 steps of interactive elicitation. Each is grounded in named, established practice from product design, requirements engineering, and safety analysis. Run them in order. Skip a step only if it genuinely doesn't apply (e.g., skip the State Diagram step if the behavior is stateless) — and say so explicitly in the doc. Calibrate ceremony to the scale of the change: a simple feature doesn't need a 9-step MSS or a decision table.

### Step 1 — Anchor the Job Story (or stories)

**Your task first.** Identify the distinct Jobs the thing serves, then draft a Job Story per Job in Klement / Intercom format (2013):

> **When** *[the situation that prompts this]*, **I want** *[what the user wants to accomplish]*, **so I can** *[the outcome they're chasing]*.

- **Feature / primitive scale**: usually one Job → one Job Story. If you find yourself drafting two, double-check it's actually two — or whether one of them belongs in a different feature.
- **Project / greenfield scale**: identify every distinct Job the product serves. For a notes app: capture, retrieve, organize, share are all distinct Jobs; each gets its own Job Story. Two Jobs are distinct if they have different situations, different motivations, or different outcomes — not just different inputs. Cap at the meaningful Jobs (typically 3–7 for a product); resist inventing one per minor feature.

Use your reading of the request and the codebase to fill every blank with concrete content. If the situation is unclear, draft your best guess and mark it for confirmation. Do NOT leave any blank for the user — they're easier to correct than to fill from nothing.

**Then validate with the user.**

> "I identified [N] distinct Job(s) and drafted a Job Story for each:
> 1. **When** [...], **I want** [...], **so I can** [...]
> 2. ...
>
> For each: confirm, correct any blank, or rewrite. Tell me if I should split / merge / drop any Job, or if I missed one entirely."

If multiple Jobs emerge, treat each subsequent step (MSS, Extensions, etc.) as one pass *per Job*. Cross-Job concerns (alternatives, simplicity, acceptance) get a single holistic pass after all per-Job passes.

### Step 2 — Main Success Scenario(s)

**Your task first.** Draft **one happy path per Job Story** (Cockburn's use-case style, *Writing Effective Use Cases*, 2000). Each MSS is a **numbered list of 3–9 steps**, each step being one observable thing — by the user, the system, or an external actor. Not code. Not implementation.

3–9 is the proven count for "complete without bloat" per scenario. If your draft is <3, the Job isn't real (push back or merge with another Job). If >9, it's secretly two Jobs or you slipped into HOW (rewrite at a higher abstraction, or split into two Jobs and update step 1).

Use your understanding of the *kind* of feature/product this is. For notifications you know the shape (subscribe → event → render → acknowledge). For exports (select → format → trigger → consume). For a notes app's capture Job (open input → write → save → close). Bring that domain knowledge in — it's why the agent drafts first.

**Then validate with the user.**

> "Here's the happy path I drafted in [N] steps:
> 1. [Actor] does X
> 2. [System] does Y
> 3. ...
>
> Confirm, correct any step, reorder, add missing steps, or split this into multiple scenarios if it isn't a single flow. Each step should be one observable thing — if I described internals, flag it."

### Step 3 — Extensions sweep (edge cases)

**Your task first — and this is where most of the elicitation work happens.** For each step in the Main Success Scenario, run all five edge-case lenses *yourself* with deep, critical thinking. List every realistic candidate you can defend; the user prunes what doesn't apply.

The five lenses, per step:

#### 3a. Equivalence + boundary (Myers, ISTQB testing canon)
Think: what inputs or values vary at this step? List three values per varying input — inside the valid range, at the boundary, just past the boundary. Name the resulting behavior you *think* is intended (you may be wrong; the user will tell you).

#### 3b. Sad path (Happy/Sad path canon)
Think: what preconditions does this step assume? What if each fails? Network down, permission denied, resource missing, dependent service unavailable, prior state corrupted. Each failure → a candidate edge with intended user-visible behavior.

#### 3c. Abuse case (OWASP Abuse Case Cheat Sheet)
Think: if a hostile or careless user wanted to break this step, what would they do? Don't skip this for "internal" tools — power users abusing an internal feature still matters. Generate at least three attack vectors per step.

#### 3d. STPA four-pattern sweep (Leveson, *Engineering a Safer World*)
For any triggered behavior, consider all four control-action defects:
- (a) Trigger never fires when it should.
- (b) Trigger fires when it shouldn't.
- (c) Trigger fires at the wrong time — too early, too late, out of order.
- (d) Trigger fires correctly but stops too early or runs too long.

Generate the resulting candidate edge for each that applies.

#### 3e. Concurrency / multiplicity
Think: what if this step happens twice in a row? What if two actors do it simultaneously? What if an actor starts it and walks away mid-flow? What if it interleaves with another in-progress instance?

**Output of your thinking.** For each MSS step, list every *real* candidate edge the five lenses surfaced — could be 2, could be 15. Don't pad to hit a number. Each candidate gets: (i) the situation, (ii) your proposed intended behavior, (iii) any reason you're uncertain or unsure it applies. If a lens turns up no realistic edges for a given step (e.g., the step has no input, so equivalence/boundary doesn't apply), skip that lens for that step and say so.

**Then validate with the user, step by step.**

> "For MSS step [N], I generated [count] candidate edges. For each, tell me: (a) confirm the intended behavior, (b) correct the behavior, (c) mark it inapplicable, or (d) say it's out of scope. After we go through these, tell me any edges I missed.
>
> [list of edges with my proposed behavior]
>
> Go."

Capture confirmed/corrected edges in the Extensions section. Record inapplicable ones briefly so the next reviewer doesn't re-raise them. Capture additions verbatim from the user.

### Step 4 — Rule consolidation (decision table or state diagram, *only if warranted*)

**Your task first.** Assess whether the behavior warrants formal structuring:

- **Decision table** if the Extensions sweep surfaced behavior depending on **more than two interacting conditions** (e.g., user role × feature flag × resource state). Decision tables expose missing rows (combinations you forgot) and conflicting rows (two rules that fire differently for the same input).
- **State diagram** if the user's language is temporal — "until", "after", "while in mode X", "once it has", "then it transitions to". Model states, transitions, triggers, and guards.
- **Skip this step** if the behavior is a simple rule with one or two conditions and no temporal/state quality. Don't add ceremony.

If a table or diagram is warranted, **draft it yourself** based on the Extensions you've collected. Fill every cell or transition you can infer. Mark cells/transitions where the intended behavior is unclear with `?`.

**Then validate.**

> "Based on the conditions / states that surfaced in step 3, I drafted this [decision table | state diagram]. Cells marked `?` are unclear — tell me the intended behavior for each. Also: rows / transitions I should add."

### Step 5 — Alternatives via "What Would Have to Be True" + Steelman

**Your task first.** Don't ask the user "what are the alternatives?" — that produces theater. Instead, you do the analytical work. At feature scale this is one alternatives pass. At project / greenfield scale, alternatives exist at **two levels**: (i) product-level — could this product not exist? could it be a different shape entirely (a CLI vs a web app, a library vs a service, a manual workflow vs an automated one)? — and (ii) per-Job — could any individual Job be served by a simpler mechanism than what you drafted? Do both passes; capture them as separate sub-sections in Alternatives Considered.

**5a. Run WWHTBT (Roger Martin, *Playing to Win*) on the current draft.** Ask yourself: for the design I've drafted to be the right answer, what would have to be true about the world? List the load-bearing assumptions concretely:
- About the users (who they are, how many, how often they use this)
- About scale (volume, rate, peak load)
- About failure cost (what happens if it goes wrong)
- About the rest of the system (what it provides, what it doesn't)
- About the user's priorities (which dimensions they care about: speed, accuracy, cost, simplicity, flexibility)

For each assumption, mark **confident** (you're sure from context) or **guess** (you're inferring; the user may know better).

**5b. Steelman the simplest alternative.** Imagine doing almost nothing — a single rule, a property on an existing thing, no new mechanism at all. Build the strongest case *for* that being right. Use the load-bearing assumptions: if some of them are guesses, the minimal alternative may win.

**5c. If a genuinely different shape emerges** during 5a/5b — e.g., a polling design vs. an event design, a per-user setting vs. a system default — capture it as Option C. Don't manufacture options for the sake of having three.

**Then validate.**

> "Here are the load-bearing assumptions I think your current design depends on: [list, each marked confident/guess]. For each: confirm, correct, or tell me which ones are wrong.
>
> Here's the steelmanned minimal alternative: [one-paragraph description of doing almost nothing]. Tell me where it breaks for your actual use case.
>
> Here's why I think Option A wins over Option B [or doesn't]: [specific dimension]. Do you agree, or does the minimal alternative actually fit?"

Capture all of this in the **Alternatives Considered** section (Nygard ADR format).

**The "three options" tell.** Don't write three options because three is the magic number. If the second and third are foils for the first — described only by tradeoffs they lose on, options nobody would actually choose — drop them. One steelmanned alternative the user genuinely had to reason about beats two manufactured strawmen every time.

### Step 6 — Simplicity pass

**Your task first.** Audit your own design draft against the established overengineering checks. At project scale, the biggest simplicity wins are usually **whole-Job cuts** ("does this product really need to do Job 4?") — surface those first. Then the per-Job and per-mechanism cuts below. For each, generate the specific finding:

**YAGNI (Beck/Fowler):** Scan your draft for any behavior that exists for a future case you can't point to a current user for. List them.

**Brooks essential vs accidental (*No Silver Bullet*, 1986):** For each piece of complexity in the design, classify it: essential (required by the problem itself) or accidental (created by how you're solving it). Accidental complexity is negotiable.

**Gall's Law (*Systemantics*, 1975):** Identify the smallest working version that does anything useful. Could the current design be split into that minimum + later growth?

**Henney's "simplicity before generality":** Spot abstractions or general mechanisms that have only one consumer in the current design. They're debt.

**Could-this-be-simpler check:** Could any chunk of the design be replaced with: a property on an existing thing, a single conditional rule, a function someone calls when they need it, or nothing at all (because the user can do it manually for now)?

**Then validate.**

> "Simplicity pass on my draft:
> - **Could cut (YAGNI)**: [list — each with rationale]
> - **Accidental complexity I'd remove if you agree**: [list]
> - **Smaller version that ships sooner**: [proposal if applicable]
> - **Abstractions with only one consumer**: [list]
>
> For each: agree to cut, agree to keep with reason, or push back. The default is to cut."

Capture the simplicity decisions in a **Simplicity Notes** section — what was cut, what was kept and why, what accidental complexity ships anyway and the reason.

### Step 7 — Pre-mortem (Klein, HBR 2007)

**Your task first.** Generate the pre-mortem yourself. Imagine it's six months from now and this feature is the most-complained-about part of the product. Write every *plausible* angry-user message you can defend — not a target count. Draw on:

- Edge cases the design handles awkwardly (from step 3).
- Load-bearing assumptions (from step 5) that could fail.
- Simplicity tradeoffs that may bite at scale (from step 6).
- Generic failure modes you know happen to this *kind* of feature.

For each candidate angry message, classify:
- **(a) Real risk** the design should mitigate now.
- **(b) Documented limitation** users sign up for.
- **(c) Misuse** outside the design's contract.

**Then validate.**

> "I drafted pre-mortem angry-user messages. For each, I propose a class (a/b/c). Confirm class or override; add ones I missed; tell me which (a)-class items should change the design now vs. become Open Questions.
>
> [list of angry messages with proposed class and rationale]"

Capture in the **Pre-Mortem** section. Class (a) items that change the design feed back into earlier sections (Extensions, Acceptance Criteria). Class (b) items become explicit Out of Behavior entries. Class (c) items get a sentence acknowledging they're known and out of scope.

### Step 8 — Tacit-knowledge sweep

**This step is user-driven** — the one exception to the agent-generates-first principle. The user has access to concrete past instances you can't fabricate from prior knowledge, and those instances are the tacit-knowledge safety net (see Working Principle #4). Your task here is to *ask* for the narrative, then *check the draft against what they say*.

**Verbatim prompts:**

> "Tell me about a real, specific time you (or a user) needed this. Not hypothetical — last week, or last month. Who, when, in what order — what actually happened?"

> "You said earlier [paraphrase rule]. Give me one concrete example that satisfies it, and one that violates it. Are both right?" (Specification by Example / Adzic + Example Mapping)

After the user replies: walk through their concrete narrative against your draft. Any mismatch (an actor you didn't model, a step that's missing, an edge you got wrong) → revise the doc. Real instances beat invented rules.

If the user replies "I don't have a real instance — this is for something new", the safety net's not available; record that explicitly as an Open Question ("design lacks a real-instance check — first user may surface specs we couldn't elicit").

## Output Format

Write the behavioral design to the plan file. Use this structure:

```
# Behavioral Design: [Name]

## Actors
- **[Actor 1]**: who they are, in what context
- **[Actor 2]**: ...

## Jobs and Scenarios

For each Job identified in step 1, repeat the Job Story + MSS + Extensions block.
At feature scale this is one block; at project / greenfield scale, one block per Job.

### Job 1: [short name]

**Job Story**: When [situation], I want [motivation], so I can [outcome].

**Main Success Scenario**:
1. [Step — observable action by named actor]
2. ...
9. [Final step]

**Extensions**:
- **Step N · [boundary / sad path / abuse / STPA / concurrency]**: [situation] → [intended behavior]
- ...

### Job 2: [short name]  *(if multiple Jobs)*
...

## Decision Table  *(only if warranted — see step 4; specify which Job it applies to, or "cross-Job")*

| Condition A | Condition B | Condition C | Action |
|---|---|---|---|
| ... | ... | ... | ... |

## State Diagram  *(only if warranted; specify which Job it models)*

States: [list]
Transitions:
- `[StateA] --(trigger, guard)--> [StateB]`
- ...

## Alternatives Considered

### Product-level *(project / greenfield scale only)*
- **Could this product exist as [different shape]?** — [analysis]
- **Could the user accomplish these Jobs without this product?** — [analysis]

### Design-level (per Job, or holistic)
- **Option A** (proposed): [one-line description]
- **Option B** (steelmanned minimal): [one-line description]
- **Option C** (if applicable): [one-line description]
- **Load-bearing assumptions**: [list — which confident, which guesses]
- **Why A over B/C**: [the specific dimension A wins on, named concretely]

## Simplicity Notes
- **Jobs cut** *(project scale only)*: [Jobs removed from scope, with reason]
- **Behaviors cut**: [behaviors removed within remaining Jobs, with reason]
- **Kept**: [what stays and the specific user/scenario justifying it]
- **Accidental complexity accepted**: [if anything ships that isn't essential, why]

## Pre-Mortem
Anticipated failure modes:
- **[Angry user message verbatim]** → class (a/b/c), mitigation if (a)
- ...

## Acceptance Criteria
Observable behaviors that define "done" from the user's perspective. Each item is a sentence a user could verify without looking at code.
1. [Criterion]
2. ...

## Out of Behavior
What this design explicitly does NOT govern. Where adjacent systems are responsible.
- ...

## Open Questions
Behaviors not yet decided that must be resolved before HOW-planning.
- ...
```

## Rules

- **No HOW.** Zero implementation language unless the subject IS the primitive (a hook, a CLI command). If you catch yourself writing "API", "database", "module", "endpoint", "state management", "file", you're in the wrong skill — stop and redirect wording back to user-observable behavior.
- **Generate, then validate.** Do the heavy thinking yourself; bring concrete candidates to the user for confirm/correct/reject/add. See Working Principle for the full rationale and the no-theater constraint. Step 8 (concrete past narrative) is the only exception.
- **Concrete > abstract.** When the user gives an abstract rule, ask for a concrete example that satisfies it and one that violates it. When they give a concrete example, derive the rule. Loop until both match.
- **Steelman before reject.** If you (or the user) are about to reject an alternative, make the strongest case *for* it first. If neither of you can, the rejection isn't grounded.
- **Honesty about uncertainty.** Anything you couldn't pin down — even after surfacing candidates — goes in **Open Questions**, not as a guess buried in the spec. Mark guesses as guesses; mark confident claims as confident.
- **Name the technique when used.** When the doc cites a Pre-Mortem finding, a WWHTBT assumption, a Decision Table, etc., name the technique. This makes the reasoning traceable and the doc auditable.
- **The doc is for the next skill, not for you.** `feature-planning` or `project-planning` will consume this. Write so an implementer-focused reader has every behavioral fact they need to design the HOW without coming back to ask.
