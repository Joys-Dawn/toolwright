---
name: rust-correctness-audit
description: Reviews Rust code for runtime correctness bugs the generic correctness audit misses — panics on realistic input, debug-panic/release-wrap overflow, Option/Result mishandling, ownership/Drop logic bugs, concurrency, async (tokio), and iterator/collection footguns. Use when reviewing Rust changes (.rs files, Cargo crates). For unsafe/UB/soundness use `agentwright:rust-security-audit`; for idioms, API design, and performance use `agentwright:rust-best-practices-audit`.
---

# Rust Correctness Audit

Perform a systematic review focused on **correctness** and **runtime concerns** specific to Rust: will this code work correctly under all realistic inputs, on every build profile, and under concurrency? The generic `agentwright:correctness-audit` covers cross-language logic bugs; this audit covers what is invisible to it — Rust's panic surface, integer overflow that *changes behavior between debug and release*, `Option`/`Result` discard paths, ownership/`Drop` timing, `async`/tokio, and iterator/collection semantics. Every finding must cite the file, line(s), dimension, and a concrete fix, and must name the specific Clippy lint (with its group and default level), rustc lint, or Reference/std clause that governs it.

For `unsafe`, undefined behavior, FFI, supply chain, and crypto, use `agentwright:rust-security-audit`. For idioms, trait/API design, and performance, use `agentwright:rust-best-practices-audit`.

**The master footgun: debug vs release.** Debug builds enable `-C debug-assertions` and `-C overflow-checks`; release builds (the default for shipped binaries) disable both. Many panics below become **silent wrong data in release**. A finding that "passes tests" in debug is not cleared for release — say so explicitly.

## Applicability

This audit applies only to Rust source. If no `.rs` files (and no `Cargo.toml`) are in scope, output exactly:

`**rust-correctness-audit: PASS** (no Rust code in scope)`

and stop. Do not invent findings for non-Rust code — the generic lens audits cover that.

## Scope

Determine what to review based on context:

- **Git diff mode** (default when no scope specified and changes exist): run `git diff` and `git diff --cached`; also `git ls-files --others --exclude-standard '*.rs'` for new untracked Rust files. Review only changed/added code and its immediate context.
- **File/directory mode**: review the `.rs` files or crate directories the user specifies.
- **Full review mode**: when the user asks for a full review, scan all crate source (skip `target/`, vendored crates, and generated code).

Read all in-scope code before producing findings. Note the crate's edition (`Cargo.toml` `edition = `) and, where it matters, the MSRV — several footguns below are edition- or version-pinned.

## Dimensions to Evaluate

Evaluate code against each dimension. Skip dimensions with no findings. See [REFERENCE.md](REFERENCE.md) for the failure mode, Rust-specific rationale, anti-pattern→fix code, exact tooling, and primary-source citation for every item.

### 1. Logic & Operator Bugs

- **`&`/`|` where `&&`/`||` was meant**: eager (non-short-circuiting) boolean operators evaluate both sides; a guard like `!v.is_empty() & (v[0] > 0)` still indexes an empty `Vec`. (`bad_bit_mask`/`ineffective_bit_mask` — Clippy correctness/deny — catch only bitmask-vs-comparison errors.)
- **`usize` subtraction underflow**: `a - b` with `b > a` panics in debug, wraps to a huge value in release (`len() - 1` on an empty `Vec`). Use `checked_sub`/`saturating_sub`.
- **Integer `/` truncates toward zero; `%` takes the sign of the dividend**: `-7 / 2 == -3`, `-7 % 3 == -1`. `% n` does not map negatives into `0..n` — use `rem_euclid`.
- **`..` vs `..=` off-by-one**: `0..=v.len()` indexes one past the end (panic); `1..n` silently drops the last element.
- **`match` arm shadowing**: an earlier broad pattern or guard makes a later specific arm dead (`c if c >= 0` before `404`). rustc `unreachable_patterns` (warn) catches structural, not guard-shadowed, cases.
- **`if let` with no `else`**: not exhaustive — a dropped `None`/`Err` branch is a silent no-op, not an error. Critical when it was the failure handler.
- **Accidental shadowing**: re-`let` of the same name in an inner block is a new binding; the outer value is unchanged when the block ends (`shadow_*` are restriction/allow — opt-in).
- **`==` on floats**: IEEE 754 rounding makes `0.1 + 0.2 != 0.3`; `NaN != NaN` so `x == x` is `false` for NaN. (`float_cmp` — Clippy pedantic/allow; `float_equality_without_abs` — suspicious/warn.)
- **Self-comparison / mistyped operand**: `a == a`, `x - x`, `x = x`. (`eq_op`, `self_assignment` — Clippy correctness/deny, curated false-positive-free.)

### 2. Integer Overflow & Numeric Casts

- **Arithmetic overflow**: `+ - *` panic in debug, **two's-complement wrap in release** by default — silent data corruption. Pick `checked_`/`saturating_`/`wrapping_` explicitly. (`arithmetic_side_effects` — Clippy restriction/allow; rustc `arithmetic_overflow` deny is constants only.)
- **`as` integer cast truncates / reinterprets sign**: `1234u16 as u8 == 210`, `-1i8 as u8 == 255`. Use `TryFrom`/`try_into()`. (`cast_possible_truncation`/`cast_possible_wrap`/`cast_sign_loss` — Clippy pedantic/allow; enabling them *is* the mitigation.)
- **`f64 as iN` saturates, `NaN → 0`** (saturating behavior stabilized Rust 1.45): out-of-range floats clamp to int min/max silently; NaN becomes 0. Guard with `is_finite()` + range check.
- **`iN::MIN / -1`, `MIN % -1`, and any `/ 0` or `% 0` panic unconditionally** — even in release, even with `overflow-checks` off. Use `checked_div`/`checked_rem`.
- **Shift overflow**: `x << n` with `n >=` bit width panics in debug, wraps in release. Use `checked_shl`/`checked_shr`.

### 3. Panic Sources on Realistic Input

- **`unwrap()`/`expect()` on input-, I/O-, parse-, or env-derived `Option`/`Result`** — propagate with `?`. (`unwrap_used`/`expect_used` — Clippy restriction/allow; `panicking_unwrap` — correctness/deny for provably-always cases.)
- **Indexing/slicing out of bounds**: `a[i]`, `&a[x..y]` panic. Use `.get(..)` for input-derived indices. (`indexing_slicing` — restriction/allow; `out_of_bounds_indexing` — correctness/deny for known-len.)
- **`str` byte-slice off a `char` boundary**: `&s[..n]` panics on any multi-byte char (emoji, accented Latin, CJK). Slice by `char_indices`/`floor_char_boundary`, or take `chars()`.
- **`Vec::remove`/`swap_remove`/`insert`/`drain`/`split_off` out of range** — validate the index against the *current* `len()` (it changes between calls).
- **`RefCell` double-borrow** panics at runtime if a `Ref`/`RefMut` is held across re-entrant code that re-borrows. Use `try_borrow*` or shorten the borrow.
- **`Mutex`/`RwLock` poisoning**: `lock().unwrap()` panics if a prior holder panicked — one panic cascades process-wide. Decide recovery (`unwrap_or_else(|e| e.into_inner())`).
- **`unreachable!`/`todo!`/`unimplemented!`/`assert!` on live paths** — all expand to `panic!`. (`todo`/`unimplemented`/`unreachable`/`panic` — Clippy restriction/allow.)
- **Panic inside `Drop`** during unwind → double-panic → process **abort** (uncatchable). Treat `unwrap`/`expect`/indexing in a `Drop` impl as a red flag.

### 4. Option / Result Mishandling

- **Ignored `Result`** via `let _ = fallible()` or `.ok()` — silences `#[must_use]`/`unused_must_use` and drops the error; a failed write/flush/send looks successful. (`let_underscore_must_use` — restriction/allow; `unused_io_amount` — correctness/deny for ignored read/write byte counts.)
- **`.ok()` discarding the error** then `?` early-returns `None` with zero diagnostics.
- **Eager `unwrap_or`/`ok_or`/`map_or` argument**: a function-call fallback runs on the success path too (and can itself panic). Use the `_else` variant.
- **`map` vs `and_then` confusion** → `Option<Option<_>>`/`Option<Result<_>>`; the inner failure is swallowed.
- **`collect::<Result<Vec<_>,_>>()` short-circuits at the first `Err`** — later items (and their side effects) are not processed.
- **`Iterator::sum`/`product` overflow** — same debug-panic/release-wrap as any integer op; no checked variant.

### 5. Ownership / Lifetime Correctness (compile-clean, runtime-wrong)

- **`let _ = mutex.lock()`** drops the guard at the end of the statement — the "critical section" runs **unlocked**. Bind to a named `_guard`. (`let_underscore_lock` — Clippy correctness/deny.)
- **Drop order**: variables drop in reverse declaration order; struct fields in declaration order. Lock/guard ordering bugs and **edition-sensitive** `if let` temporary scope (Rust 2024 narrowed it) cause re-entrant deadlock or use-after-release.
- **`mem::take`/`replace` then early `?`**: the source is left as `Default`/placeholder if a later fallible step returns before restoring it — silent state corruption on the error path.
- **Cached index/len across a `Vec` mutation**: `push` may reallocate; `insert`/`remove` shift elements. The borrow checker cannot catch it (no live reference) — the index now points elsewhere or out of bounds.

### 6. Drop, Leaks & Resource Correctness

- **`BufWriter` not explicitly `flush()`ed before drop**: drop-flush errors are **silently ignored** — a disk-full/broken-pipe tail loss reports success. Call and check `flush()`.
- **`Rc`/`Arc` reference cycle** → memory never freed (Rust does not guarantee leak-freedom). Break back-edges with `Weak`.
- **`mem::forget`/`ManuallyDrop`/`Box::leak`** skip the destructor — a forgotten `File`/`MutexGuard`/`TcpStream` leaks the OS handle or never releases the lock; fatal in a hot path. (`mem_forget` — Clippy restriction/allow; `undropped_manually_drops` — rustc deny-by-default, uplifted from Clippy.)
- **`process::exit`/`panic = "abort"`/`process::abort`** run **no destructors** on any stack — `BufWriter`s don't flush, temp files leak. Flush/clean up explicitly before the exit path.

### 7. Concurrency Correctness (safe Rust)

- **Re-entrant `std::sync::Mutex` lock**: behavior is unspecified and "will not return on the second call (it might panic or deadlock)" — phrase findings that way, not "guaranteed deadlock."
- **Lock-ordering deadlock**: `lock(A); lock(B)` in one place and `lock(B); lock(A)` in another. The type system does not prevent it. Define one global lock order.
- **`Condvar` without a predicate loop**: spurious wakeups mean a bare `if cv.wait(..)` proceeds on a false condition. Use `while !predicate` or `wait_while`.
- **Atomic `Ordering` too weak**: `Relaxed` gives no cross-variable ordering — a `Relaxed` publish flag lets a reader see the flag before the data on ARM/AArch64 (passes x86 testing, fails on ARM). Use `Release`/`Acquire` to publish/consume. (rustc `invalid_atomic_ordering` deny catches *invalid*, not *too-weak*, orderings.)
- **`compare_exchange_weak` outside a retry loop**: spurious failure is treated as a real mismatch — wrong one-shot logic.
- **Channel `recv()`/`send()` unwrapped**: returns `Err` when the other half hangs up (normal shutdown) — `recv().unwrap()` in a loop panics on clean exit. Zero-capacity `sync_channel(0)` is a rendezvous — mismatched counts deadlock.
- **Unjoined `thread::spawn`**: a detached thread's panic is swallowed and its result lost; the program proceeds as if it succeeded. Prefer `thread::scope` (joins + propagates, Rust 1.63+).

### 8. Async Correctness (tokio / futures)

- **Holding a `std::sync::MutexGuard` / `RefCell` ref / non-`Send` value across `.await`**: won't compile in `tokio::spawn` (requires `Send`), and even single-threaded it serializes the runtime / deadlocks. Scope the std guard, or use `tokio::sync::Mutex`. (`await_holding_lock`/`await_holding_refcell_ref` — Clippy suspicious/warn.)
- **Blocking the runtime**: `std::thread::sleep`, blocking `std::fs`/`std::net`, or heavy CPU in a task stalls every task on that worker. Use `tokio::time::sleep`, async I/O, or `spawn_blocking`/`block_in_place`.
- **Future built but never `.await`ed**: futures are lazy; `let _ = client.send(req)` never sends. (`let_underscore_future` — suspicious/warn; `async_yields_async` — correctness/deny.)
- **`tokio::select!` cancels the losing branches** at their suspension point — a not-cancellation-safe op (`read_exact`, `write_all`, `Mutex::lock`) loses partial progress every loop iteration.
- **`select!` loser side effects discarded**: only the completed branch's future is polled; effects expected from the other branch never happen.
- **`block_on` inside an async context** panics. **tokio primitive without a tokio runtime** panics ("no reactor running").
- **`tokio::spawn` panic is isolated**: it does not crash the runtime; if the `JoinHandle` is dropped/never awaited the panic is silently lost, and on runtime shutdown in-flight detached tasks are cancelled mid-await (lost work). Observe the `JoinError`.

### 9. Iterator & Collection Correctness

- **`zip` truncates to the shorter iterator** — the tail of the longer is silently dropped. Assert equal lengths or use `itertools::zip_eq`.
- **`Vec::dedup` removes only *consecutive* duplicates** — `sort()` first for set-like uniqueness.
- **`chunks`/`windows`/`chunks_exact`**: `chunks(n)` yields a short final chunk; `chunks_exact(n)` silently drops the remainder; all panic if `n == 0`.
- **Sorting floats with `partial_cmp().unwrap()`** panics on any NaN. Use `total_cmp` (Rust 1.62+).
- **`HashMap`/`HashSet` iteration order is non-deterministic** (randomized SipHash) — never feed it into a hash, checksum, serialized output, or test assertion. Use `BTreeMap`/`BTreeSet` or sort.
- **`sort` (stable) vs `sort_unstable` (not stable)**: switching to unstable for speed scrambles the secondary order in multi-key sorts.
- **`retain` keeps where the predicate is `true`** — the inverted-predicate bug deletes the wrong half.
- **Combinator order/init**: `take(m).skip(n)` ≠ `skip(n).take(m)`; `step_by(0)` panics (`iterator_step_by_zero` — correctness/deny); `fold(0, *)`/`fold(1, +)` silently biases the result.

## Static Analysis Tools

Before producing findings, **run available Rust tooling** on in-scope code and fold its output into findings.

### Clippy

```bash
cargo clippy --all-targets -- -W clippy::pedantic
```

**Lint-group model — this is essential to reporting accurately:**

- **`correctness`** (Clippy) is **deny-by-default** and curated to be false-positive-free — "if you see a `correctness` lint, the code is outright wrong." Treat any `correctness` hit as **Critical**.
- **`suspicious`** is **warn-by-default**. Treat as **Warning** unless clearly benign.
- **`pedantic`, `restriction`, `nursery`, `cargo`** are **allow-by-default** — they do **not** fire unless explicitly enabled. The highest-value correctness lints for this audit (`unwrap_used`, `expect_used`, `indexing_slicing`, `arithmetic_side_effects`, `float_cmp`, `cast_possible_truncation`) live here. **A project that has not enabled them is not "clean" — recommending the relevant lint be enabled is itself a valid audit action**, but phrase it as "enable `clippy::indexing_slicing`", never "Clippy already flags this."
- Never claim a Clippy lint exists unless it is in REFERENCE.md's verified list. Several footguns here have **no lint** and are marked "manual" — say "no lint; manual review" rather than inventing one.

### Build profiles

```bash
cargo build           # debug: overflow-checks + debug-assertions ON
cargo build --release # release: both OFF by default
RUSTFLAGS="-C overflow-checks=on" cargo build --release  # forces overflow panic in release
```

For any Dimension 1/2 overflow finding, state the debug-vs-release split explicitly: tests passing in debug do not clear release.

### rustc built-in lints (already on — lean on these)

`arithmetic_overflow`, `unconditional_panic`, `overflowing_literals`, `invalid_atomic_ordering` (Rust 1.56+) are **deny-by-default** but fire only on **provably constant** cases. `unused_must_use`, `unconditional_recursion` are **warn-by-default**. The runtime variants of all of these are the audit's job, not the compiler's.

### Miri / tests

`cargo miri test` and `cargo test` (run both debug and `--release`) surface UB and overflow that constants-only lints miss. Miri is primarily a `agentwright:rust-security-audit` tool; cite it here only for runtime-overflow confirmation.

### How to use tool output

1. Map each tool finding to its dimension (e.g., `await_holding_lock` → Dimension 8).
2. `correctness`-group and rustc deny hits → **Critical**; `suspicious` → **Warning**; everything from allow-by-default groups → the severity its *runtime impact* warrants, with the enable recommendation noted.
3. Note "clippy: clean" / "miri: clean" in the Summary if applicable, and always state the build profile assumption.

## Output Format

Group findings by severity, not by dimension. Each finding must name its dimension and cite the governing lint/clause.

```
## Critical
Issues that cause incorrect behavior, data loss, panics, or deadlock on realistic input or in release builds.

### [Dimension] Brief title
**File**: `path/to/file.rs` (lines X–Y)
**Dimension**: Full dimension name — one-line statement of what correct Rust requires here.
**Problem**: What the code does wrong and the concrete runtime impact — which input triggers it, what the symptom is, and (for Dim 1/2) the debug-vs-release behavior.
**Rule**: The Clippy lint (group, default level), rustc lint, or Reference/std/Nomicon clause that governs this.
**Fix**: Specific, actionable code change.

## Warning
Issues likely to cause bugs under realistic inputs/load, or that break on a different edition, architecture, or build profile.

(same structure)

## Suggestion
Robustness improvements — including "enable Clippy lint X" for an allow-by-default lint that would catch a class of latent bugs here.

(same structure)

## Summary
- Total findings: N (X critical, Y warning, Z suggestion)
- Dimensions most frequently violated: top 2–3
- Tooling: clippy: clean / N issues; miri: clean / not run; build profile assumed: debug|release
- Edition/MSRV notes: any finding whose behavior is edition- or version-pinned
- Overall assessment: 1–2 sentence verdict on runtime correctness
```

## Verification Pass

Before finalizing, verify every finding:

1. **Re-read the code in context (±20 lines)**: Is the panic actually reachable with realistic input, or is the index/length provably bounded upstream? Is the `unwrap` on a value that genuinely can be `None`/`Err` here? Is the borrow/lock actually held across the await/re-entry? Drop misreads.
2. **Check for existing mitigations**: a `checked_*` already used, a validation guard earlier in the function, `#![deny(clippy::...)]` already in the crate, an `assert!` that makes the index safe, `overflow-checks = true` in the release profile (`Cargo.toml`). If mitigated, drop the finding.
3. **Verify against primary sources**: confirm every cited std/Reference/Nomicon behavior and every Clippy lint name + group + default level against REFERENCE.md (or look it up — do not guess). If you cannot confirm a lint exists, say "manual review; no lint."
4. **Pin the profile and edition**: for Dimension 1/2 findings, state debug vs release. For drop-order/`if let` temporary findings, state the edition (2021 vs 2024). For version-pinned behavior (float-cast saturation 1.45, `total_cmp` 1.62, `thread::scope` 1.63, `invalid_atomic_ordering` 1.56), check the crate's MSRV before asserting.
5. **Filter by confidence**: certain false positive → drop entirely. Plausible but unconfirmed → list once under "Worth Investigating", not as a formal finding.

## Rules

- **Be specific**: always cite file paths and line numbers.
- **Be actionable**: concrete fix, not "handle the error" — show the `?`/`checked_*`/`.get()`/`total_cmp` change.
- **Model the failure**: every Critical must describe the triggering input and the symptom, and for arithmetic, the release-vs-debug divergence.
- **Cite the governing rule**: every finding names a Clippy lint (with group + default level), a rustc lint, or a Reference/std/Nomicon clause. No uncited correctness claims.
- **Never invent a lint**: if REFERENCE.md marks an item "no lint; manual," report it as manual. Do not attribute behavior to a Clippy lint that does not exist.
- **Allow-by-default ≠ not-a-bug**: a real runtime bug that only a `restriction`/`pedantic` lint would catch is still a finding; recommend enabling that lint as the fix, phrased as a recommendation.
- **Use the unspecified-behavior wording**: `std::sync::Mutex` re-entrancy is "unspecified; will not return on the second call (may panic or deadlock)" — do not assert "guaranteed deadlock."
- **Severity by real-world impact**: release-build silent corruption and reachable panics on user input are Critical; behavior that is merely non-idiomatic is out of scope (that is `agentwright:rust-best-practices-audit`).
- **No fluff**: skip dimensions with no findings; do not praise merely-acceptable code.
- **Respect scope**: in diff mode, only flag changed lines and immediate context.
- **Don't duplicate other skills**: runtime correctness only. `unsafe`/UB/soundness/FFI/crypto → `agentwright:rust-security-audit`; idioms/API design/perf → `agentwright:rust-best-practices-audit`; test code → routed via `agentwright:test-quality-audit`. A bug that is also a security issue: flag it here for correctness and reference the security audit for that angle.
