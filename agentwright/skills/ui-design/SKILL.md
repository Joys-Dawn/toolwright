---
name: ui-design
description: Designs the visual / spatial / interaction-surface layer of a feature, project, or idea — surfaces, layout, visual states, affordances, navigation, hierarchy, and accessibility constraints — without any component names, CSS, or framework specifics. Works at any scale: one surface for a small feature, many surfaces for a whole greenfield product. Consumes `behavioral-design.md` when available to key visual states off behavioral states. Use upstream of feature-planning / project-planning. Has a hard no-UI off-ramp: features with no human-facing surface (backend service, CLI tool, library, agent skill, scheduled job) get a 3-line stub and exit. Examples: "what surfaces does the dark-mode toggle live on" (feature), "how is the notes app organized across surfaces" (greenfield).
---

# UI Design

Before doing anything, enter plan mode. While in plan mode, first determine whether this thing has a UI surface at all (see **No-UI Off-Ramp** below). If yes, produce a complete, implementation-ready **UI design** specification covering surfaces, layout, visual states, affordances, navigation, hierarchy, and accessibility constraints. If no, write a 3-line stub and exit. This skill designs WHAT the user sees and HOW they move through it, not HOW it's built. The output is a `ui-design.md` artifact that downstream planning skills (`feature-planning`, `project-planning`) consume so they can focus on the implementation. The implementation-planning skill *will* pick the framework, the component library, the styling approach — none of that belongs here.

**Scale.** This skill works at any scale — a single feature, a primitive that surfaces something to a user, or an entire greenfield product. The techniques are the same; what changes is multiplicity. A small feature usually has **one or two surfaces**. A greenfield product has **many surfaces**, organized by the Job Stories from `behavioral-design.md` (one product surface inventory typically maps to 3–7 Jobs × 1–3 surfaces per Job; cap at the surfaces that earn their existence). Run the steps once per surface where appropriate; cross-surface sections (Navigation graph, Alternatives, Simplicity, Pre-Mortem, Acceptance) are holistic.

**This skill is downstream of `behavioral-design.md`.** When a workflow has produced one, read it first. The Job Stories tell you which surfaces are needed; the Main Success Scenarios tell you the user-action steps each surface must support; the behavioral states (loading, ready, error variants) anchor the visual states you'll specify in step 3. If no `behavioral-design.md` exists (standalone invocation), ask the user one question — "do you have a behavioral spec, or should I work from the request directly?" — then either consume the doc or proceed.

## Trigger

When this skill is invoked, **immediately enter plan mode** using the EnterPlanMode tool. All elicitation, exploration, and design work happens inside plan mode. The deliverable is the UI design document — no code, no component imports, no file paths.

## Scope

- **Idea / feature / project request**: Treat the request as a starting point. The UI spec is what *you* (the agent) construct from it (plus `behavioral-design.md` if present), then validate with the user.
- **Vague request**: That's expected — your job is to make it concrete using deep, critical thinking grounded in the named techniques below, then bring concrete proposals to the user.
- **Detailed request with mockups**: Validate it against the elicitation passes. Mockups under-specify states, accessibility, navigation graphs, and alternatives almost without exception. Run the passes anyway.

**What this skill does NOT cover:**
- Triggers, scenarios, edge cases, decisions, acceptance behaviors — those are `behavioral-design`.
- Framework choice, component library, styling system, file/module layout — `feature-planning` or `project-planning`.
- Implementation steps, blast radius, test sequencing — also planning's job.
- Brand-level visual style: exact colors, typography, illustration style, motion tokens — those are visual design / brand work, downstream of and orthogonal to this skill.

**The no-component-names rule.** Describe each surface in content + user-action vocabulary: regions, content nouns ("list of saved notes", "input field for note body", "row of recent edits"), and user verbs ("the user can confirm", "the user can revisit a prior entry"). Generic widget primitives (button, link, input, list, table, modal, sheet, drawer) are content-level vocabulary and are fine. **Banned:** framework-specific names (MaterialButton, ChakraModal, AntdSelect, Tailwind class names), CSS values (hex codes, exact pixel sizes outside accessibility minimums, named breakpoints), and any wording that pins implementation. If you catch yourself writing "use a `<Dialog>` component", you're in the wrong skill — restate as "a modal surface that confirms the destructive action".

## No-UI Off-Ramp

**Run this check first, before the 8-step process.** A feature has no UI surface when:

1. **No human-in-the-loop on the input side.** All inputs originate from another machine (webhook, scheduled job, API call from another service, queue message, file system event). A human never types, clicks, or speaks into this thing.
2. **No human-in-the-loop on the output side.** All outputs go to another machine (logs consumed by a log shipper, metrics consumed by a dashboard *built elsewhere*, downstream API, queue, file). A human never reads the output directly during operation.
3. **No persona / scenario can be drawn without collapsing to "the developer runs the command".** (Cooper's "no users, no design" principle.) If the only "user" is the engineer at install time or the operator at debug time, that's not a product UI.

If all three apply, write the 3-line stub:

```
# UI Design: <Name>

No UI surface — this feature is a [backend service / CLI tool / library / agent skill / hook / scheduled job] with no visual or spatial component. Inputs come from [named machine consumer / event source]; outputs go to [named machine consumer]. No human persona interacts with this surface during operation.

(Off-ramp triggered after running the three-question check from `ui-design` SKILL.md.)
```

…then exit cleanly via ExitPlanMode and advance.

**Edges that do NOT off-ramp** (these have UI even if it looks small):
- An admin/operator configures the thing through a screen, even if end-users don't see it. The admin is a persona; the config screen is a surface.
- The thing surfaces logs/metrics in a *new* dashboard built as part of this work. (If it writes to an existing dashboard owned by another product, no UI.)
- The thing emits notifications a human reads — email, in-app, push, Discord. Those are surfaces.
- A CLI tool a human invokes from a terminal — the terminal output (its layout, its states, its error messages) IS a surface. Don't off-ramp CLI tools; design their terminal surface.
- An agent skill humans invoke and read responses from — the response is a surface. Don't off-ramp agent skills that surface text to a user.

**Disguised "no UI"** — guard against:
- "I haven't thought about the UI yet" disguised as "no UI". Force a positive statement of *which machine* consumes inputs and outputs; if you can't name the consumer, the answer isn't no-UI, it's "not yet designed".
- A feature that COULD have a UI but the user didn't ask for one. That's a design decision worth surfacing as an Alternative Considered ("could ship as CLI only; alternative is a small web surface"), not an off-ramp.

## What this skill produces

A `ui-design.md` file containing: Surface inventory, per-surface (Layout, Visual States, Affordances, Hierarchy, Accessibility notes), Navigation Graph, Alternatives Considered, Simplicity Notes, Pre-Mortem, Acceptance Criteria, Out of Scope, and Open Questions. No HOW content.

## Working principle: agent generates, user validates

**You — the agent running this skill — are the one doing the design thinking.** Don't push the work back to the user with blank-canvas questions. They're busy, they don't have your breadth across UI techniques, and they will miss things you wouldn't. Their role is to provide domain context, brand constraints, comparable-product references, priorities, and corrections — not to invent every surface, every state, and every navigation edge from scratch.

For every step in the process below:

1. **Reason through it yourself first.** Use the named technique, your domain knowledge, `behavioral-design.md` if available, and your understanding of how this kind of UI typically works. Generate concrete candidates — a drafted surface inventory, a drafted layout per surface as prose or ASCII, an exhaustive list of visual states keyed to behavioral states, named alternatives with their tradeoffs, candidate failure modes. Think deeply and critically; produce specifics, not vague gestures.

2. **Present your candidates as a concrete strawman.** Bring the user a *proposal*, not a *question*. "I drafted these 4 surfaces with these layouts — here they are. Confirm, correct, or add what I missed." Concrete proposals provoke specific reactions; blank questions provoke vague agreement or fatigue.

3. **Take the user's input as the signal that grounds your work.** They know things you don't — their real users, brand constraints, comparable products they like, history of UI choices that didn't work. They will:
   - **Confirm** items where you got it right (record the confirmation).
   - **Correct** items where domain context shifts the answer (revise the doc).
   - **Reject** items that don't apply to their reality (drop and explain why).
   - **Add** items you couldn't have known (rare but valuable — capture verbatim).

4. **Polanyi's principle applies — "we can know more than we can tell."** A user asked "what surfaces do you need?" tends to surface 1–2 and stop. A user shown "here are 4 candidate surfaces I generated; tell me which are real, mark inapplicable, or add ones I missed" reliably produces a much fuller spec. The cognitive move from *generate* to *recognize* is the unlock.

5. **Realistic candidates only — no theater.** "Generate" means surface every *plausible, defensible* candidate from genuine reasoning. It does NOT mean manufacture surfaces that don't earn their existence, invent visual states that don't realistically apply, fabricate "navigation alternatives" nobody would actually consider, or write strawman failure modes just to look thorough. If a lens turns up nothing real for a given surface, say so — empty is better than fake. A user pruning 12 real states to 5 is collaboration; a user pruning 12 fake states to 0 is wasted time. When in doubt about a candidate: include it but mark your uncertainty ("this state may not apply because…") so the user can decide quickly.

**What this looks like across the 8 steps.** For each step, you do real work in the language of the named technique before opening your mouth to the user. The "Verbatim prompts" below are validation prompts, not delegation prompts.

**The one exception is Step 8** (tacit-knowledge sweep), where the user has access to concrete past UI instances and comparable-product references you genuinely can't generate. There you ask for the narrative; you don't draft it.

## Process

8 steps grounded in named, established practice from interaction design, information architecture, and accessibility standards. Run them in order. Skip a step only if it genuinely doesn't apply — and say so explicitly in the doc. Calibrate ceremony to the scale: a single-surface feature does not need a 10-edge navigation graph or three layout alternatives per surface.

### Step 1 — Surface inventory

**Your task first.** Identify the distinct surfaces this thing needs. A **surface** is a discrete view / screen / page / mode / channel where a user perceives or acts. Use Carroll's scenario-based decomposition (Rosson & Carroll, *Usability Engineering: Scenario-Based Development of HCI*, 2002) combined with Hierarchical Task Analysis (Annett & Duncan, 1967; Diaper & Stanton, *Handbook of Task Analysis for HCI*, 2003): walk the Main Success Scenario(s) from `behavioral-design.md` (or the request) step by step; every time the user pauses, decides, waits, or transitions, that's a candidate surface boundary.

Garrett's *The Elements of User Experience* (2002/2011) names this the **Structure plane** (interaction design + information architecture). This skill works at Structure + Skeleton (interface, navigation, information design), not Surface (visual style / brand).

- **Feature / primitive scale**: usually 1–3 surfaces (e.g., a settings toggle: 1 surface — the settings panel row).
- **Project / greenfield scale**: many surfaces, one cluster per Job from `behavioral-design.md`. Resist inflating to one surface per minor action — a surface earns its existence when (a) the user perceives a distinct context, (b) the affordances differ meaningfully from adjacent surfaces, or (c) the navigation model would degrade if it were merged.

For each candidate surface, draft: a short name, the Job Story / MSS step(s) it supports, and the persona who lands here. Mark any surface where you're unsure whether it should exist or be merged.

**Then validate.**

> "I identified [N] surfaces:
> 1. **[Name]** — supports [Job / MSS step]; persona: [who lands here]
> 2. …
>
> For each: confirm, merge, split, drop, or rename. Tell me if I missed a surface or invented one that shouldn't exist."

If a surface is dropped or merged, update the count and proceed with the survivors. Each subsequent step (layout, states, affordances, hierarchy, accessibility) runs once per surviving surface.

### Step 2 — Layout per surface

**Your task first.** For each surface, draft the layout at *appropriate fidelity* — Buxton's principle (*Sketching User Experiences*, 2007): "there is no high or low fidelity, only appropriate fidelity." For a markdown spec, the sweet spot is **regions + their relative position + the content nouns inside them**, expressed in prose or ASCII. Wodtke & Govella's *Information Architecture: Blueprints for the Web* (2nd ed., 2009) calls this the blueprint level: document *intent*, not chrome.

For each surface, write:

- **Regions** (top-level): named areas of the surface. e.g., "header (top, spans full width)", "primary content (center, dominant)", "secondary panel (right rail, optional)", "footer actions (bottom, fixed)".
- **Content in each region**: nouns, not widgets where possible. e.g., "list of saved notes, most-recent first" — not "FlatList of NoteCard components". Generic widget primitives (button, input, list) are fine; framework names are not.
- **Approximate position**: prose ("primary content occupies the left two-thirds; secondary panel the right third") or a small ASCII sketch. Don't pixel-pin.

When ASCII helps (typically dashboards, multi-region screens, terminal UIs), use it:

```
+----------------------------+
|  header: app name | search |
+----------------------------+
|              |  recent     |
|   note body  |  notes      |
|   (editing)  |  list       |
|              |             |
+----------------------------+
|  save | cancel             |
+----------------------------+
```

Do NOT specify exact dimensions, fonts, colors, or class names. Avoid drawing 10 surfaces with identical ASCII frames — duplication is a tell that prose would carry the load.

**Then validate, per surface.**

> "For surface **[Name]**, I drafted this layout: [prose / ASCII]. Confirm, correct positions, add missing regions, drop regions that don't earn space, or rename anything. Flag if I named a component or pinned a framework — that's out of scope."

### Step 3 — Visual states per surface

**Your task first.** Every surface has multiple visual states. Use Scott Hurff's **UI Stack** (2015, *Designing Products People Love*, 2016) as the base: every non-trivial surface should be considered against five states.

- **Ideal** — the surface as designed, with realistic complete content.
- **Empty** — no data yet (first-time use, user cleared everything, no search results).
- **Error** — something went wrong (invalid input, failed save, network error, permission denied).
- **Partial** — sparse data, guiding the user toward completeness.
- **Loading** — fetching, waiting, transitioning.

For each surface, enumerate which of the 5 apply and what each looks like (one or two sentences each). A static surface might only have Ideal + Error. A data-heavy surface needs all 5. **Realistic-only: do not invent states that wouldn't happen** — e.g., a settings checkbox row has no Loading state if the value is local; saying it does is theater.

**Key visual states to behavioral states.** Where `behavioral-design.md` lists behavioral states (e.g., "saved", "saving", "save failed", "unsaved changes"), each behavioral state needs a corresponding visual state on this surface. Cross-reference explicitly: "Visual state **Saving** corresponds to behavioral state `BD §States.saving`". If a behavioral state has no visual manifestation on this surface, say so — it lives elsewhere or the user doesn't perceive it.

For surfaces whose state space is non-trivial (a multi-step flow, a mode-switching screen, a real-time updating view), draft a **statechart-style enumeration** (Harel, "Statecharts: A Visual Formalism for Complex Systems", *Science of Computer Programming*, 1987; Horrocks, *Constructing the User Interface with Statecharts*, 1999): states + transitions + triggers + guards. If you can't enumerate the states, the spec is incomplete; use hierarchical / nested states to avoid combinatorial blow-up.

**Then validate, per surface.**

> "For surface **[Name]**, the 5 UI Stack states apply as follows: [list]. States I think don't apply: [list, with reason]. Keyed to behavioral states: [mapping]. Confirm, correct, mark inapplicable, or add states I missed (often there's a feature-specific one — 'success acknowledgement', 'destructive-confirm', 'background-syncing')."

### Step 4 — Affordances per surface

**Your task first.** For each surface in each relevant state, enumerate what the user **can do** — in user-action language, not widget language. Norman's *Design of Everyday Things* (rev. ed., 2013) distinguishes **affordance** (what action is possible) from **signifier** (the perceptible signal that communicates it). The spec describes affordances ("the user can dismiss the notification", "the user can promote a draft to a saved note") and *secondarily* the signifier ("a one-tap action in the upper-right of the row, visible without scrolling").

Cooper et al.'s *About Face* (4th ed., 2014) goal-directed framing: specify the **goal** (end condition) above the **task** (intermediate steps). "Submit the form" is a task; "publish the entry so others can read it" is a goal. The doc states goals; the user infers tasks.

For each surface state, list affordances as: `[Verb] [object]` → `[user-visible result]`. Cap at the affordances that actually exist on that surface in that state; do not invent.

**The Norman trap to avoid.** Don't write "this affords clicking" or "the button affords being pressed" — Norman explicitly calls this misuse. Write what the user *accomplishes*. "The user can dismiss the alert" — not "the dismiss button affords a click".

**Then validate, per surface.**

> "Affordances on **[Name]** in state **[state]**:
> - [user action] → [user-visible result]
> - …
>
> Confirm, correct, drop affordances that shouldn't exist here, or add ones I missed. Flag anything that's a task ('click submit') rather than a goal ('publish the entry')."

### Step 5 — Navigation across surfaces

**Your task first.** Build the navigation graph: nodes are surfaces, edges are user-initiated transitions (and any system-initiated ones, marked separately). For each edge, name the **trigger** (the affordance from step 4 that fires it) and the **destination state** (which UI Stack state of the destination surface is the user landing in).

Use Tidwell, Brewer & Valencia's *Designing Interfaces* (3rd ed., 2020) pattern catalog as a shortlist:
- **Clear entry points** — a small set of obvious starting surfaces.
- **Menu page / hub-and-spoke** — one central surface that dispatches to siblings.
- **Pyramid / sequence map** — linear flows with progress visible.
- **Modal panel** — focused interruption that returns to the prior surface.
- **Breadcrumbs** — visible parent trail for deep hierarchies.

Match the pattern by Tidwell's "use when" clauses, not surface similarity. Reject the pattern if it doesn't fit; don't shoehorn.

**Graph integrity checks (do these yourself):**
- Every surface has at least one **back edge** — no dead ends. Even terminal "success" surfaces need a way out (back to a hub, dismiss, start-over).
- Every surface has at least one **entry edge** — no orphans (otherwise the user can't get there).
- Cycles are fine; cycles without escape paths are bugs.
- For non-trivial graphs (>4 surfaces), draft an ASCII or prose graph showing edges. For trivial graphs, prose listing edges is enough.

**Then validate.**

> "Navigation graph: [N] surfaces, [M] edges. Pattern: [Tidwell name]. Drafted edges:
> - [Surface A] —(trigger: [affordance])→ [Surface B, state: …]
> - …
>
> Integrity: [dead-end check result], [orphan check result]. Confirm, correct edges, add missing ones, flag wrong-pattern."

### Step 6 — Visual hierarchy + Accessibility constraints

**Your task first — two passes per surface.**

**6a. Visual hierarchy.** For each surface, articulate priority in three to five tiers (more is noise). Don't say "use H1 here" — that's framework. Say what's **primary** (the dominant element the user notices first), what's **secondary** (supporting context), what's **tertiary** (utility / chrome). Cap at 3–5 levels per Krug's scannability principle (*Don't Make Me Think, Revisited*, 3rd ed., 2014).

Apply **Gestalt grouping** (Wertheimer, 1923; modern UI summaries widely cited): name groupings that should read as a unit due to proximity, similarity, or common region. e.g., "the save and cancel actions form one group, separated from the delete action by space and position".

Apply **Tufte's data-ink principle** (*The Visual Display of Quantitative Information*, 1983/2001): every element on the surface must earn its presence. Flag elements you drafted in step 2 that don't carry information; propose cutting them. (Tufte caveat: signifiers — Norman — are not chartjunk even though they aren't "data". Keep affordances visible.)

**6b. Accessibility design constraints.** State the design-level WCAG 2.2 constraints (W3C Recommendation, 12 December 2024) the surface must satisfy. Implementation belongs to planning; the design constraints belong here:

- **SC 1.4.1 Use of Color (Level A)** — color is never the sole carrier of meaning. If the surface uses color to communicate status (success / error / warning), require a second carrier (icon, label, position). State this per surface as a constraint, not as an ARIA attribute.
- **SC 2.4.3 Focus Order (Level A)** — specify the **logical reading and focus order** on each surface (top-left → bottom-right is the default; deviate only with reason). For non-linear surfaces (a dashboard with sidebars), state the focus order explicitly.
- **SC 2.5.8 Target Size Minimum (Level AA in 2.2)** — interactive targets at least **24×24 CSS pixels** unless an exception applies. Note this for any surface with small touch targets you've drafted; flag for size review.
- **Color independence in general** — colorblind and low-vision personas. Where you used color in the layout, name a redundant non-color signal.

For surfaces with motion, transient messages, or media: surface those (SC 2.2.x, 1.4.13, etc.) as Open Questions if the design isn't yet clear.

**Then validate.**

> "Hierarchy + accessibility pass on **[Name]**:
>
> Primary: [element], Secondary: [list], Tertiary: [list]. Gestalt groupings: [list]. Elements I'd cut for not earning ink: [list].
>
> Accessibility design constraints: color-independence handled by [redundant signal], focus order [stated], target-size flags [list], color use [described].
>
> Confirm, correct, override priority, or add constraints I missed."

### Step 7 — Alternatives + Simplicity pass

**Your task first.** Don't manufacture three options to look thorough. Generate alternatives where there are genuine forks; collapse pseudo-alternatives that no one would choose. Buxton's **design funnel** (2007): generate many low-cost candidates, then converge.

**7a. Surface-count alternatives.** Could two surfaces collapse into one (single-surface alternative)? Could one surface split into two (multi-surface alternative)? Cooper's rule: one surface preferred when one user goal, one decision point, ≤1 mode switch; otherwise split. A "mode" hidden inside one surface is a surface in disguise — call it out.

**7b. Layout alternatives per non-trivial surface.** For surfaces where layout matters (anything beyond a single row in a list), draft 1–2 genuine alternatives. e.g., for a notes app's primary surface: (A) list-detail split, (B) full-screen list with detail as modal, (C) inbox-style stacked cards. Each with one-line trade-off naming the dimension it wins / loses on.

**7c. Navigation pattern alternatives.** If you chose hub-and-spoke in step 5, what if it were a linear sequence? If you chose breadcrumbs, what if it were a flat tab bar? Steelman the alternative on one specific dimension. Then justify why you stuck with the original.

**7d. Nielsen heuristic prune** (10 Usability Heuristics, Nielsen, 1994, NN/g revisions). Score the draft against the 10 — especially #1 visibility of system status, #3 user control & freedom, #5 error prevention, #6 recognition over recall, #8 aesthetic-minimalist. Each heuristic flag is a candidate cut or fix. Don't weaponize #8 against necessary affordances; balance with #5.

**7e. Simplicity pass.**

- **YAGNI**: surfaces / regions / affordances that exist for a future case with no named current user. List for cutting.
- **Brooks essential vs accidental** (*No Silver Bullet*, 1986): for each piece of complexity in the UI, classify. Accidental complexity is negotiable; cut it.
- **Gall's Law** (*Systemantics*, 1975): is there a smaller surface set that does *anything* useful first?
- **Whole-surface cuts** (project scale): the biggest project-scale simplicity win is usually "does this product really need a [marketing landing page / onboarding tour / settings panel] at v1?" Surface those.

**Then validate.**

> "Alternatives + simplicity pass:
>
> Surface-count alternative: [if applicable]. Layout alternatives on non-trivial surfaces: [list]. Navigation pattern alternative: [steelman]. Why I stuck with the original: [reason on a specific dimension].
>
> Nielsen heuristic flags: [list — each as a candidate cut or fix].
>
> Could cut (YAGNI / Brooks accidental / whole-surface): [list, each with rationale].
>
> For each: agree to cut, agree to keep with reason, or push back. Default is to cut."

Capture in **Alternatives Considered** and **Simplicity Notes** sections.

### Step 8 — Pre-mortem + Tacit-knowledge sweep

**8a. Pre-mortem** (Klein, "Performing a Project Premortem", *HBR*, 2007).

**Your task first.** Imagine it's six months from now and this UI is the most-complained-about part of the product. Draft every *plausible* angry-user message you can defend — not a target count. Draw on:

- Visual states drafted thinly (a "loading" state with no spinner placement specified is a future bug).
- Affordances buried out of sight (a destructive action with the same prominence as a safe one).
- Navigation gaps (a state with no back edge that turns out to be reachable).
- Accessibility shortcuts (color-only status that fails for a colorblind user).
- Hierarchy violations (the primary action visually competing with three secondaries).
- Surface count miscalls (a hidden mode that should have been its own surface).

For each candidate angry message, classify (a) real risk to mitigate now, (b) documented limitation users sign up for, (c) misuse outside the design's contract.

**8b. Tacit-knowledge sweep** — the user-driven step. Three named techniques; pick the ones that fit the user's evident depth.

- **Berkun intent-first design critique** ("How to Run a Design Critique", 2002). Force the user to state their intent for each surface before they critique your draft. Unstated preferences become statable.
- **Comparable-product reference** (Hall, *Just Enough Research*, 2nd ed., 2019). "Name three products that get *this kind of surface* right, and one that gets it wrong. For each, what specifically?" Capture the **property** (not the visual): "fast keyboard-first navigation", "the destructive action is far from the primary action", not "looks like Linear's sidebar".
- **Critical Incident Technique** (Flanagan, *Psychological Bulletin* 51(4), 1954). "Tell me about a specific past moment when a UI like this delighted or frustrated you. Recent, and one that stuck with you." Concrete incidents surface tacit rules the user couldn't state on demand. Ask for both recent and memorable to dodge recall bias.

**Verbatim prompts (Step 8).**

> "Pre-mortem: I drafted [N] angry-user messages I think this UI is most likely to generate at 6 months. For each, I propose a class (a/b/c). Confirm, override, add ones I missed, flag (a)-class items that should change the design now.
>
> [list]"

> "Tacit-knowledge: tell me three products that handle [this kind of surface / this kind of navigation] in a way you respect, and one that handles it badly. For each, what specifically — what property, not which colors?"

> "Critical incident: one specific time a UI like this delighted you, and one specific time it frustrated you. Doesn't matter how recent."

Walk the user's responses against the draft; any mismatch (a property you violated, an incident your design would re-cause) → revise. Class (a) pre-mortem items feed back into earlier steps. Class (b) becomes Out of Scope. Class (c) becomes a noted assumption.

## Output Format

Write the UI design to the plan file. Use this structure:

```
# UI Design: [Name]

## Off-Ramp Check
- Input human-in-the-loop: [yes / no — named consumer if no]
- Output human-in-the-loop: [yes / no — named consumer if no]
- Persona drawable: [yes — named persona / no — collapses to developer/operator]
- Result: [UI design proceeds / no-UI stub]

(If "no-UI stub", end the document with the 3-line stub from SKILL.md and stop.)

## Surfaces

### Surface 1: [short name]
- **Supports**: [Job / MSS step from behavioral-design.md, or request]
- **Persona**: [who lands here]
- **Layout**: [prose, or ASCII sketch]
- **Visual States** (UI Stack + feature-specific):
  - **Ideal**: [description]
  - **Empty**: [description, or "not applicable because …"]
  - **Error**: [description]
  - **Partial**: [description, or "not applicable because …"]
  - **Loading**: [description, or "not applicable because …"]
  - **[Feature-specific state]**: [description] — corresponds to behavioral state `BD §…`
- **Affordances** (per state where relevant):
  - In state [state]: [user action] → [user-visible result]
  - …
- **Hierarchy**:
  - Primary: [element]
  - Secondary: [list]
  - Tertiary: [list]
  - Gestalt groupings: [list]
- **Accessibility constraints**:
  - Color independence: [redundant signal for each color-coded meaning]
  - Focus order: [stated explicitly]
  - Target size: [flagged where applicable]
  - Other (motion, media, transient messages): [as needed]

### Surface 2: [short name]
…

## Navigation Graph
- Pattern: [Tidwell name]
- Edges:
  - [Surface A] —(trigger)→ [Surface B, state: …]
  - …
- Integrity: no dead ends ✓ / orphans ✓ (or list violations)

## Alternatives Considered
- **Surface-count alternative**: [if applicable] — why kept / dropped
- **Layout alternatives** (per non-trivial surface):
  - Surface [Name]: Option A (drafted), Option B (steelman), Option C (if applicable) — chosen on [dimension]
- **Navigation pattern alternative**: [steelman] — chosen on [dimension]

## Simplicity Notes
- **Surfaces cut** (project scale): [list with reason]
- **Regions / affordances cut**: [list with reason]
- **Kept**: [what stays and the specific user/scenario justifying it]
- **Accidental complexity accepted**: [if anything ships that isn't essential, why]

## Pre-Mortem
- **[Angry user message verbatim]** → class (a/b/c), mitigation if (a)
- …

## Acceptance Criteria
Observable UI behaviors that define "done" from the user's perspective. Each item is a sentence a user could verify by looking at the surface, without looking at code.
1. [Criterion]
2. …

## Out of Scope
Surfaces / states / accessibility cases this design explicitly does NOT cover. Where adjacent design work lives.
- …

## Open Questions
UI decisions not yet resolved that must be answered before HOW-planning.
- …
```

## Rules

- **No HOW.** No component names from any framework; no CSS values; no exact dimensions outside accessibility minimums; no file paths. Generic widget primitives (button, link, list, modal, input) are allowed as content nouns; framework-specific names are not.
- **No theater.** Surfaces, states, affordances, and alternatives must be realistic. Don't pad to look thorough. Empty is better than fake — see Working Principle #5.
- **Generate, then validate.** Do the design thinking yourself; bring concrete strawmen to the user. Step 8b (tacit-knowledge) is the only step where the user generates first.
- **Concrete > abstract.** When the user gives an abstract preference, ask for a comparable product or a concrete past incident. When they give a concrete reference, derive the property. Loop until both match.
- **Key visual states to behavioral states.** When `behavioral-design.md` exists, every behavioral state that's user-perceivable on a given surface must have a corresponding visual state. Cross-reference explicitly. If a behavioral state has no visual manifestation here, say so.
- **No dead ends, no orphans.** Every surface has a back-edge and an entry-edge. Cycles are fine; cycles without escape paths are bugs. Check in step 5; record in Navigation Graph.
- **Accessibility is design-level, not implementation-level.** State design constraints (color independence, focus order, target size, content structure). Don't drift into ARIA attributes or DOM semantics — those are planning's job.
- **Off-ramp is operational, not aspirational.** If you off-ramp, you must positively name the machine consumer of inputs and outputs and verify no persona collapses to "developer/operator at install/debug time". "I don't know yet" is not no-UI; it's not-yet-designed.
- **Steelman before reject.** If you (or the user) are about to reject an alternative layout / pattern / surface count, make the strongest case *for* it first. If neither of you can, the rejection isn't grounded.
- **Honesty about uncertainty.** Anything you couldn't pin down — even after surfacing candidates — goes in **Open Questions**, not a guess buried in the spec.
- **Name the technique when used.** UI Stack, Tidwell pattern, WCAG SC, Nielsen heuristic, Berkun critique, Critical Incident — name it. Auditable reasoning beats unattributed assertion.
- **The doc is for the next skill.** `feature-planning` or `project-planning` will consume this. Write so an implementer-focused reader has every UI fact they need to design the HOW without coming back to ask.
