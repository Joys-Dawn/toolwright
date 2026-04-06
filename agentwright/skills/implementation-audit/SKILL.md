---
name: implementation-audit
description: Reviews whether the implementation approach itself is sound — not just correct or clean, but the right way to solve the problem. Catches roundabout solutions, unnecessary complexity, reinvented wheels, and naive designs that ignore established patterns. Use before correctness and best-practices audits, or when code works but feels wrong.
---

# Implementation Audit

Review whether the implementation is the **right approach**, not just whether it works or follows coding standards. Code can be bug-free and well-structured yet still be a poor implementation — overly complex, roundabout, or ignorant of established solutions.

The core questions for every piece of code: **"Is this how a senior engineer with domain experience would solve this?"** and **Is this industry standard?**

## Scope

Determine what to review based on context:

- **Git diff mode** (default when no scope specified and changes exist): run `git diff` and `git diff --cached` to review only changed/added code
- **File/directory mode**: review the files or directories the user specifies
- **Full review mode**: when the user asks for a full review, scan all source code (skip vendor/node_modules/build artifacts)

Read all in-scope code before producing findings. For each file, also read enough surrounding context (imports, callers, data model) to understand what problem the code is actually solving.

## Dimensions

Evaluate code against each dimension. Skip dimensions with no findings.

### 1. Unnecessary Indirection

Code that takes a roundabout path to a simple goal. Extra layers, wrappers, or transformations that add no value. **Ask**: "If I delete this intermediate step, does anything break?"

### 2. Reinventing the Wheel

Ignoring established tools, APIs, patterns, or language features that already solve the problem. **Ask**: "Does a well-known solution already exist for this?" Verify via web search or docs when unsure — don't flag something as reinvented unless you can name the established alternative and confirm it works for this case.

### 3. Naive Design

An approach that works but shows lack of domain understanding. The kind of solution someone writes when they haven't worked with the technology or problem space before. **Ask**: "Would someone experienced in this domain do it this way?"

### 4. Disproportionate Complexity

The implementation cost doesn't match the problem's actual difficulty. Too many lines, files, abstractions, or dependencies for what the code actually does. **Ask**: "Is the solution proportional to the problem?"

### 5. Other

Anything else that makes the implementation poor but doesn't fit the above dimensions. **Ask**: "Is there something fundamentally off about this approach that I can concretely articulate and fix?"

## Verification Pass

Before finalizing, verify every finding:

1. **Confirm the simpler alternative works**: Don't just say "this is too complex" — name the simpler approach and confirm it handles the same cases. If you can't name a concrete alternative, drop the finding.
2. **Check for hidden requirements**: Is the complexity justified by requirements you might not see? (backwards compatibility, performance constraints, API limitations). Read git blame or commit messages if something looks unnecessarily complex — there may be a reason.
3. **Verify the "established solution" exists**: When claiming something reinvents the wheel, confirm the alternative exists in the project's language/framework version. Don't suggest APIs that were added in a newer version than the project uses.
4. **Web search when uncertain**: If you're not sure whether a simpler approach exists or handles edge cases, look it up. Don't guess.

## Output

**Only report issues.** Do not list dimensions that passed — silence means no problems found.

If the audit is clean: `**Implementation audit: PASS** (no issues found)`

If issues exist:

```
**Implementation audit: <filename>**
- [Dimension]: [file:line] — [what's wrong]. **Instead**: [the concrete simpler/standard approach].
```

Every finding MUST include a concrete alternative — "this is too complex" without naming the simpler way is not a valid finding.
