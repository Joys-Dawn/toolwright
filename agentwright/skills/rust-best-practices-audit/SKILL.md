---
name: rust-best-practices-audit
description: Audits Rust code against the Rust API Guidelines (C-* IDs), the named idiom/anti-pattern catalog, and Clippy's style/perf/complexity groups — error-handling design, ownership idioms, trait/API design, naming conventions, performance, and module/crate hygiene. Use when reviewing Rust changes for idiomatic quality and design. For runtime bugs use `agentwright:rust-correctness-audit`; for unsafe/UB/supply-chain use `agentwright:rust-security-audit`.
---

# Rust Best Practices Audit

Audit Rust code against established Rust conventions: the **Rust API Guidelines** (the `C-*` checklist), the **named idiom/anti-pattern catalog** (rust-unofficial/patterns), and **Clippy's default-on groups**. Cite the specific guideline ID, named anti-pattern, or Clippy lint (with its group and default level) for every finding so the developer learns *which* convention applies and why. The generic `agentwright:best-practices-audit` covers cross-language principles (DRY/SOLID/KISS); this audit covers what is Rust-specific and invisible to it.

For runtime bugs (panics, overflow, races), use `agentwright:rust-correctness-audit`. For `unsafe`/UB, FFI, supply chain, and crypto, use `agentwright:rust-security-audit`.

## The Two Master Context Switches

These govern *every* finding's severity — apply them before reporting anything:

1. **Library vs binary.** `anyhow`/`Box<dyn Error>` in a public API, `unwrap` in `main`, missing `#[non_exhaustive]`, over-broad `pub`, C-STABLE, sealed traits, semver hazards — all flip severity (often **Critical in a published library → non-issue in a binary/prototype**). Determine which is under review (`[lib]`/`[[bin]]` in `Cargo.toml`, `lib.rs` vs `main.rs`) and condition findings on it. `unwrap`/`expect` in tests, examples, and prototypes is explicitly sanctioned by the Rust Book — never flag it there.
2. **Clippy group ≠ "must fix".** Only `style`, `perf`, `complexity`, `correctness`, `suspicious`, `deprecated` are warn/deny by default. `pedantic`, `nursery`, `restriction`, `cargo` are **allow** (opt-in) — they do not fire unless the crate enables them, and `restriction` lints deliberately contradict each other. For an allow-by-default lint, phrase the finding as **"consider enabling `clippy::X` (rationale)"**, never "this violates `clippy::X`". Only default-on lints may be asserted as violations.

## Applicability

This audit applies only to Rust source. If no `.rs` files (and no `Cargo.toml`) are in scope, output exactly:

`**rust-best-practices-audit: PASS** (no Rust code in scope)`

and stop.

## Scope

- **Git diff mode** (default when no scope specified and changes exist): `git diff` + `git diff --cached`; also `git ls-files --others --exclude-standard '*.rs'` for new untracked files.
- **File/directory mode**: the `.rs` files or crate directories specified.
- **Crate mode**: when asked for a full audit, scan the crate broadly (skip `target/`, vendored crates, generated code).

Read all in-scope code, plus `Cargo.toml` (crate type, edition, MSRV, features), before producing findings.

## Principles to Enforce

Evaluate against each dimension. Skip dimensions with no findings. See [REFERENCE.md](REFERENCE.md) for the rule, rationale, anti-pattern→idiomatic code, exact tooling, and primary-source citation for every item.

### 1. Error Handling Design

- **Library typed errors vs application `anyhow`/`eyre`** (C-GOOD-ERR): a published library returning `anyhow::Error`/`Box<dyn Error>` forces every caller into stringly recovery — Critical in a public API, *correct* in a binary.
- **Error types implement `std::error::Error` + `Display` + `Debug`** — never `Result<T, String>` or `()`; callers cannot branch on those.
- **Preserve the source chain** via `#[source]`/`#[from]`/`Error::source()`; the underlying error is returned by `source()` *or* rendered by `Display`, not both.
- **No `unwrap`/`expect`/`panic!` for recoverable conditions in library code** (Book ch.9.3) — return `Result`. Sanctioned in tests/examples/prototypes.
- **`expect` message states the precondition** ("expect-as-precondition"), not "failed to X".
- **`#[non_exhaustive]` on public error enums** — adding a variant is otherwise a breaking change.
- **No swallowed errors** (`let _ =`, `.ok()`); `main` may return `Result<(), Box<dyn Error>>` so `?` works at the top level.

### 2. Ownership & Borrowing Idioms

- **Borrowed parameter types**: `&str`/`&[T]`/`&Path`, not `&String`/`&Vec<T>`/`&PathBuf` (`clippy::ptr_arg` — style, **warn/default-on**). C-GENERIC.
- **`.clone()` to satisfy the borrow checker** — the named anti-pattern; restructure scope or use `mem::take`/`replace` (`clippy::clone_on_copy` — complexity, warn; `redundant_clone` — nursery, allow).
- **`mem::take`/`mem::replace`** to move an owned value out of `&mut` without cloning.
- **`Cow<'_, str>`/caller-controls-placement** (C-CALLER-CONTROL): take ownership only if you need it; borrow otherwise; `Cow` for usually-borrowed-sometimes-owned.
- **Needless lifetime annotations** where elision applies (`clippy::needless_lifetimes` — complexity, warn).
- **`Rc<RefCell<T>>`/`Arc<Mutex<T>>` as the default** shared-state tool without justification — trades compile-time guarantees for runtime panics (the runtime-panic facet is `rust-correctness-audit`'s).

### 3. Trait & Type Design (API Guidelines)

- **Eagerly implement common traits** (C-COMMON-TRAITS): `Debug`(C-DEBUG), `Clone`, `PartialEq`, etc. — the orphan rule means downstream can never add them.
- **Conversion traits** (C-CONV-TRAITS): implement `From`/`TryFrom`/`FromStr`/`AsRef`, never `Into`/`TryInto`; `From` must be infallible and non-panicking (use `TryFrom`).
- **Newtype pattern** for units/IDs/invariants (C-NEWTYPE, C-CUSTOM-TYPE): primitive obsession lets `f64`/`bool` flow into the wrong slot.
- **Dispatch choice** (C-GENERIC vs C-OBJECT): generics → monomorphization/code-size; `Box<dyn>` → heterogeneity/vtable. Decide object-safety upfront.
- **Sealed trait pattern** (C-SEALED) for non-downstream-implementable traits — otherwise adding a method is breaking.
- **`Deref` only for smart pointers** (C-DEREF): "Deref polymorphism" to fake inheritance is a Critical surprising-resolution anti-pattern.
- **`#[must_use]`** on builders, `Result`-like, and pure-query types.
- **Unsurprising operator overloads** (C-OVERLOAD); implement `Default` where a sensible empty exists (`clippy::new_without_default`, `should_implement_trait` — style, warn).

### 4. API Conventions (C-*)

- **Naming**: C-CASE (acronyms = one word: `Uuid`), C-GETTER (`fn name()` not `get_name()`), C-CONV (`as_`/`to_`/`into_` cost semantics), C-ITER, C-WORD-ORDER (`clippy::wrong_self_convention`, `enum_variant_names` — style, **warn/default-on**; rustc `non_snake_case` etc.).
- **Constructors static & inherent** (C-CTOR); **builders** for many-arg/optional construction (C-BUILDER).
- **Private fields + validated constructor** (C-STRUCT-PRIVATE) where an invariant must hold; no out-params (C-NO-OUT); don't duplicate derivable bounds (C-STRUCT-BOUNDS).
- **`#[non_exhaustive]` on growable public structs/enums**; stable public deps (C-STABLE).
- **Doc conventions**: `# Examples`/`# Panics`/`# Errors`/`# Safety` (C-EXAMPLE, C-FAILURE; `clippy::missing_safety_doc` — style, **warn/default-on**; `missing_errors_doc`/`missing_panics_doc` — pedantic, allow).
- **Visibility minimization**: `pub(crate)` over `pub`; don't leak private types in public signatures (rustc `private_interfaces` — default warn).

### 5. Idiomatic Constructs & Clippy style/complexity

- **Iterators/adaptors over manual index loops** (`clippy::needless_range_loop` — style, warn/default-on).
- **`if let`/`let else`/`matches!`/combinators over verbose `match`** (`single_match`, `match_like_matches_macro`, `redundant_pattern_matching` — style, warn/default-on). **Contested:** heavy combinator chaining vs `match` — flag only egregious cases, present both views.
- **`.is_empty()` not `.len() == 0`**; inline format args `format!("{x}")` (Rust 1.58+); `#[derive]` over hand-impl (`len_zero`, `redundant_field_names` — style, warn/default-on; `uninlined_format_args` — pedantic, allow — consider enabling).
- **No needless `return`/`&`/`clone`/`collect`** (`needless_return`, `needless_borrow`, `let_and_return` — style, warn/default-on; `needless_collect`/`redundant_clone` — nursery, allow).
- **`entry` API for maps** instead of `contains_key` + `insert` (`clippy::map_entry` — perf, warn/default-on).

### 6. Performance Best-Practices

- **Avoidable heap allocation**: `Box<Vec<T>>`/`Vec<Box<T>>`/`Rc<Box<T>>`; `String` built with `+` in a loop (`box_collection`/`redundant_allocation` — perf, warn/default-on; `vec_box` — complexity, warn/default-on).
- **Preallocate when size known**: `Vec::with_capacity`/`reserve` (`slow_vector_initialization` — perf, warn/default-on; general case is std-guidance + judgment).
- **Avoid intermediate `collect()`; lazy `unwrap_or_else`; needless `to_owned`/`to_string`** (`unnecessary_to_owned` — perf, warn/default-on; `or_fun_call`/`needless_collect` — nursery, allow).
- **Dispatch & monomorphization bloat; `#[inline]` cargo-culting** — **contested/heuristic**, present as judgment, not a rule.
- **`HashMap` SipHash vs FxHash/aHash for trusted internal maps** — **contested**; FxHash has collision pathologies and "should never be used as a default"; untrusted-input DoS is `rust-security-audit`'s.
- **`OnceLock`/`LazyLock` over per-call recompute** (version-pinned: `OnceLock` 1.70, `LazyLock` 1.80; `once_cell` below that).
- **Small-buffer optimization** (`SmallVec`/`arrayvec`) — **evidence-gated only; UNVERIFIED by a primary source; not a rule**. Speculative use is itself the over-engineering anti-pattern.

### 7. Module, Crate & Project Structure

- **`lib.rs`/`main.rs` split**: logic in the library (testable/reusable), `main.rs` a thin shell.
- **Visibility minimization**: `pub(crate)` for non-API; don't leak private types. `mod.rs`-vs-path-as-file is **contested style — do not flag either**.
- **`#![warn(...)]` not `#![deny(warnings)]` in source** (named anti-pattern: opts out of Rust's stability); `RUSTFLAGS="-D warnings"` in CI instead. `#![forbid(unsafe_code)]` where applicable is fine.
- **Additive feature flags** (C-FEATURE: name `abc` not `no-abc`/`with-abc`); edition currency (version-pinned idiom shifts).

### 8. Common Named Anti-Patterns

The REFERENCE.md table enumerates 18 named anti-patterns with their idiomatic alternative, severity, and source (Clone-to-satisfy-borrowck, Deref polymorphism, stringly-typed errors, primitive obsession, `as`-instead-of-`TryFrom`, god module, speculative generality, blanket `#[allow]`, re-inventing std, `Box<dyn Error>` from a library, `mem::uninitialized`, `Rc<RefCell>` graph soup, …). Items mapping to opt-in lints must be phrased "consider enabling"; the `unsafe`/UB facets belong to the security/correctness skills — flag only the *design* facet here.

## Output Format

Group findings by severity. Each finding MUST name the specific guideline/anti-pattern/lint and (for Clippy) its group + default level.

```
## Critical
Violations that cause bugs, unmaintainable public API, or semver hazards in a published library.

### [GUIDELINE/PATTERN/LINT] Brief title
**File**: `path/to/file.rs` (lines X–Y)
**Context**: library | binary | test/example (the master switch — state it).
**Principle**: The C-* ID, named anti-pattern, or Clippy lint (group, default level) and a one-line statement of what it requires.
**Violation**: What the code does wrong and the concrete impact.
**Fix**: Specific, actionable change. For an allow-by-default lint, phrase as "consider enabling `clippy::X`".

## Warning
Violations that degrade ergonomics, maintainability, or performance.

(same structure)

## Suggestion
Idiom alignment, including "consider enabling Clippy lint X". Present contested items with both views.

(same structure)

## Summary
- Total findings: N (X critical, Y warning, Z suggestion)
- Crate context: library | binary | workspace; edition; MSRV (if found)
- Guidelines/patterns most frequently violated: top 2–3
- Clippy: clean / N default-on issues; opt-in lints recommended: list
- Overall assessment: 1–2 sentence verdict on idiomatic quality
```

## Linter Tools

Before producing findings, **run available Rust tooling** and fold its output into findings.

### Clippy

```bash
cargo clippy --all-targets                        # default-on groups
cargo clippy --all-targets -- -W clippy::pedantic # surface opt-in pedantic (report as "consider enabling")
```

Map each hit to its dimension. **Default-on group hit** (`style`/`perf`/`complexity`/`correctness`/`suspicious`) → assert as a violation at the severity its impact warrants. **Opt-in group hit** (`pedantic`/`nursery`/`restriction`/`cargo`, only visible when explicitly enabled) → report as "consider enabling, rationale", never as a standing violation. Never claim a lint exists unless it is in REFERENCE.md's verified list; never assert the wrong group/level (the rendered Clippy index has known group/level errors — REFERENCE.md's values were re-verified against the canonical source).

### rustc & rustdoc

`non_snake_case`/`non_camel_case_types`/`non_upper_case_globals` (default warn) enforce C-CASE; `private_interfaces`/`private_bounds` (default warn) catch leaked private types; `unreachable_pub` (allow, opt-in) flags over-`pub`. `cargo doc` + `rustdoc::broken_intra_doc_links` for C-LINK. `cargo fmt --check` for formatting consistency.

### How to use tool output

1. Map each finding to its dimension and the C-* guideline / named pattern it relates to.
2. Default-on lint errors that indicate real design problems → **Warning**/**Critical** per the master switches; pure style → **Suggestion**.
3. Note "clippy: clean (default groups)" in the Summary, and list which opt-in lints you recommend enabling.

## Verification Pass

Before finalizing, verify every finding:

1. **Re-read in context (±20 lines)**: is it actually a violation, or the established crate convention / an intentional choice with a `// ` rationale / a `#[allow]` with justification? Drop misreads.
2. **Apply the master switches**: is this a library or a binary/test/example? Re-rate (often Critical→non-issue). Is the cited Clippy lint default-on or opt-in? Re-phrase opt-in ones as recommendations.
3. **Verify against primary sources**: confirm the C-* ID, named anti-pattern, and every Clippy lint name + group + default level against REFERENCE.md (or look it up — do not guess, and do not trust the rendered Clippy index's group/level).
4. **Gate version-pinned idioms on MSRV/edition**: inline format args (1.58), `let else` (1.65), `OnceLock` (1.70), `LazyLock` (1.80), edition-2021/2024 idiom shifts. Check `Cargo.toml` before recommending.
5. **Filter by confidence and pragmatism**: a violation is only worth flagging if fixing it provides real value. Drop pedantic noise. Contested items (combinator-vs-`match`, `#[inline]`, `mod.rs`-vs-path, FxHash) → present both sides as Suggestion, never assert. Plausible-but-unconfirmed → "Worth Investigating", not a formal finding.

## Rules

- **Name the convention**: every finding cites a C-* ID, a named anti-pattern, or a Clippy lint with group + default level. This is the core value of this skill.
- **Apply the master switches first**: library-vs-binary and default-on-vs-opt-in change severity and phrasing for most findings.
- **Never present an opt-in lint as a violation**: `pedantic`/`nursery`/`restriction`/`cargo` are "consider enabling X (rationale)". `restriction` lints contradict each other — never blanket-recommend the group.
- **Never invent or mis-classify a lint**: use only REFERENCE.md's verified names/groups/levels.
- **Present contested items honestly**: combinator-chaining vs `match`, `#[inline]` placement, `mod.rs` vs path-as-file, FxHash vs SipHash — show both views; do not assert. Do not flag `mod.rs`-vs-path at all.
- **Be specific and actionable**: file:line + concrete idiomatic rewrite.
- **Pragmatism over dogma**: skip trivial/pedantic violations that add noise; consider crate scale and existing conventions.
- **Don't duplicate other skills**: idioms/design/perf-as-best-practice only. Runtime bugs → `agentwright:rust-correctness-audit`; `unsafe`/UB/supply-chain/crypto → `agentwright:rust-security-audit`; test code → routed via `agentwright:test-quality-audit`. For dual-facet anti-patterns (Deref polymorphism, `mem::uninitialized`, `Rc<RefCell>` soup), flag only the design facet and reference the other skill for the UB/runtime facet.
