---
name: write-tests-rust
description: Use when writing, reviewing, or fixing Rust tests (unit `#[cfg(test)]` modules, `tests/` integration crates, doctests, async/`#[tokio::test]`, proptest, snapshots, mocks, CLI tests), or auditing a Rust test suite for flakiness, false passes, and isolation bugs. The Rust-specific test skill — `agentwright:test-quality-audit` and `agentwright:write-tests` defer here for Rust. Triggers on parallel-execution flakes, `#[should_panic]` misuse, float `assert_eq!`, `HashMap`-order assertions, or `_test.rs` misrouting.
---

# Rust Test Writing

Write and review Rust tests using `cargo test`, the standard test attributes, and the established testing crates. Every recommendation is sourced from the Rust Book (ch. 11), the Rust Reference, the rustdoc/Cargo books, or official crate docs — see [REFERENCE.md](REFERENCE.md) for the per-claim citations.

## Scope

Determine what to do from the user request:

- **Write mode**: write new tests for the Rust code the user specifies
- **Review mode**: audit existing Rust test code for anti-patterns and false-pass / flakiness bugs
- **Fix mode**: fix failing, flawed, or flaky Rust tests

This skill covers Rust specifically — unit tests in `#[cfg(test)]` modules, integration tests under `tests/`, doctests, and the property/snapshot/mock/CLI test crates. For non-Rust code use `agentwright:write-tests` (or the Deno/frontend/pgTAP skills).

## Prerequisites

Before writing or reviewing, read:

1. **`Cargo.toml`** — the `edition` (2021 vs **2024** changes `set_var` safety and `static mut`), the MSRV (`rust-version`), and which test crates are deps/dev-deps (`tokio`, `proptest`, `rstest`, `insta`, `mockall`, `assert_cmd`, `serial_test`, `criterion`).
2. **2–3 existing test files** — adopt the project's module layout, naming, and assertion style.
3. **The code under test** — read the source (and whether logic lives in `src/lib.rs`; a binary-only crate cannot be integration-tested via `use`).

Do not introduce a new test crate without explicit user approval.

## Principles to Enforce

See [REFERENCE.md](REFERENCE.md) for the failure mechanism, anti-pattern→correct code, exact tooling, version gates, and source citation for each.

### 1. The `cargo test` execution model — parallel by default

`cargo test` runs every `#[test]` in one binary **on parallel threads by default**. Any shared mutable state — a `static`/`static mut`, `OnceLock`/`lazy_static!`, the process env, the cwd, a fixed TCP port, a fixed temp path, a shared DB — is a race/interference hazard producing nondeterministic false passes. Fix the design (inject inputs, ephemeral port `0`, `tempfile`); serialize an unavoidable global seam with `serial_test`'s `#[serial]`/`#[file_serial]`. `--test-threads=1` / `cargo nextest` mask the design flaw, not fix it. This is the #1 source of flaky Rust tests.

### 2. Test placement & the three kinds — Rust has **no `_test.rs` convention**

(a) **Unit** — `#[cfg(test)] mod tests { use super::*; }` in the same `src` file; can reach **private** items. (b) **Integration** — each file directly under `tests/` is its **own crate**, public API only; shared helpers go in `tests/common/mod.rs`, **never `tests/common.rs`** (which compiles as its own crate → spurious "running 0 tests"). (c) **Doctests** — `///` examples, compiled and run by `cargo test`. **There is no `*_test.rs` / `*.test.rs` filename convention** (unlike Go/JS). Locate Rust tests by `#[cfg(test)]`+`#[test]`, the `tests/` dir, and doc fences — never by filename.

### 3. `#[test]` and async / alternative attributes

Plain `#[test]` needs a zero-arg fn returning `()` or `Result<T, E: Debug>`. An `async fn` under plain `#[test]` **won't compile / does nothing** — use `#[tokio::test]` (default current-thread; `flavor = "multi_thread"` reintroduces intra-test concurrency), `#[async_std::test]`, or `#[sqlx::test]`. `#[bench]`/`#![feature(test)]` is **nightly-only** — a stable crate must use `criterion` (`[[bench]]` + `harness = false`).

### 4. `#[should_panic]` correctness

Bare `#[should_panic]` passes on **any** panic — including an unintended one (a typo'd `unwrap` in setup), a classic false pass. Require `#[should_panic(expected = "substring")]` with a substring unique to the intended panic (it is a **containment** check, not equality), or for `Result` APIs assert `Err` instead. `#[should_panic]` is **incompatible with `-> Result` tests**. A `should_panic` test of a `debug_assert!` falsely *fails* under `--release` (the assert is compiled out).

### 5. Assertion quality

Prefer `assert_eq!`/`assert_ne!` (print both values) over `assert!(a == b)` (prints only "false"). **Never `assert_eq!` two floats** — rounding makes it flaky/brittle; use an epsilon or `approx`/`float_cmp`. **Never use `debug_assert!` as a test assertion** — it is a no-op under `cargo test --release` (false pass). Assert on error **variants** (`matches!`, `assert_eq!` on the `Err`), not on `format!("{:?}", internal)` strings (couples to a private `Debug` derive). `pretty_assertions` for large diffs.

### 6. `Result`-returning tests; `unwrap`/`expect` in tests is **fine**

`#[test] fn t() -> Result<(), E>` lets you use `?` instead of `unwrap` ladders (fails on `Err` or panic). **`.unwrap()`/`.expect("context")` in test code is idiomatic and acceptable — a panic *is* the failure signal. Do NOT flag test `unwrap`/`expect` as a bug** (that is a false finding); `.expect("why")` over bare `.unwrap()` is only a triage Suggestion. `unwrap` in *library* code is a different skill's concern.

### 7. Isolation & determinism (beyond Principle 1)

No reliance on test order (libtest order is unspecified). **Never assert on `HashMap`/`HashSet` iteration order** — the hasher is randomized per run (textbook flake). No wall-clock (`SystemTime::now`, `thread::sleep`-to-wait) — inject a clock or `#[tokio::test(start_paused = true)]` + `tokio::time::advance`. No real network/DNS in unit tests (`wiremock`/`httpmock`). Seed all RNG (`StdRng::seed_from_u64`). Filesystem via `tempfile`/`assert_fs` (mind `tempfile`'s early-drop pitfall). Init global loggers once (`Once`).

### 8. Property-based & fuzz testing

`proptest`: use `prop_assert!`/`prop_assert_eq!` (not `assert!`, which spams per shrink); the **`proptest-regressions/` file MUST be committed** (it replays discovered counterexamples — gitignoring it silently un-tests a known regression). Don't assert tautologies (`a+b == b+a` tests std, not your code) — assert a round-trip/invariant of *your* code. Keep strategies deterministic (shrinking/`fork` require it). `cargo-fuzz`/`libfuzzer-sys` for fuzzing.

### 9. Fixtures, parametrization & snapshots

A hand-rolled `for`-loop over cases is one `#[test]` — a failure reports a line, not *which input*. Use `rstest` `#[case]`/`#[values]`/`#[fixture]` or `test-case` (named generated tests). `insta`: `assert_*_snapshot!`, the `cargo insta review` workflow, **redactions for nondeterministic fields** (UUIDs/timestamps), commit `.snap` files. Never blanket `cargo insta accept` / `INSTA_UPDATE=always` (rubber-stamps regressions); never snapshot un-redacted random data (flaky → forces blind-accept).

### 10. Mocking & test doubles

Rust has no built-in mocking; the seam is a **trait** + DI. `mockall` (`#[automock]`/`mock!`, `.with`/`.times`/`.returning`/`Sequence`). An `expect_*` with **no `.times(..)` and no behavioral assertion verifies nothing** (default allows unlimited calls). `#[automock]` static/module/`*_context()` expectations are **global** — under the parallel default they race unless `#[serial]`. Don't over-mock (asserting the mock = testing nothing); `#[automock]` must precede `#[async_trait]`.

### 11. CLI / binary / filesystem integration testing

Use `assert_cmd::Command::cargo_bin("name")` — it runs the **freshly-built** binary (`CARGO_BIN_EXE_<name>`). `std::process::Command::new("mytool")` runs whatever is on `PATH` (stale code → silent false pass). `.assert().success()`/`.code(n)` is **not implicit** — a `Command` built without an exit/output assertion verifies nothing. `assert_fs`/`tempfile` for FS fixtures (never cwd-relative or fixed absolute paths).

### 12. Coverage, CI & maintenance hygiene

`cargo llvm-cov` (preferred) or `tarpaulin`. **Always run `cargo test --doc` in CI** — `cargo test --lib` skips doctests, so a broken public-API example goes uncaught. `ignore` on a doctest to silence a `?`-compile error makes the example **silently rot** — use a hidden `# fn main() -> Result<…> { … # Ok(()) # }`. `#[ignore]` must carry a reason and CI must run `--include-ignored` somewhere. Run a feature matrix (`--all-features` / `--no-default-features`) — a path only tested under default features is false confidence.

## Common Anti-Patterns

| Anti-Pattern | Why wrong | Fix |
|---|---|---|
| Shared `static`/`OnceLock`/global under parallel `#[test]`s | Data race / interference → nondeterministic false pass | Per-test isolated state; or `#[serial]` |
| `env::set_var`/`set_current_dir` in a test | Process-global; races other threads; **`unsafe` in edition 2024** | Inject config; RAII guard + `#[serial(env)]` if unavoidable |
| Fixed TCP port / shared `/tmp` path | Collision under parallel tests | Bind port `0`; `tempfile::tempdir()` |
| `tests/common.rs` for shared helpers | Compiled as its own crate → spurious "running 0 tests" | `tests/common/mod.rs` |
| Routing/locating Rust tests by `*_test.rs` | Rust has **no such convention** — misroutes every test | `#[cfg(test)]`+`#[test]`, `tests/`, doc fences |
| `async fn` under plain `#[test]` | No executor → won't compile / does nothing | `#[tokio::test]` / `#[sqlx::test]` |
| `#[bench]` / `#![feature(test)]` in a stable crate | Nightly-only; breaks `cargo +stable test` | `criterion` `[[bench]]` + `harness = false` |
| Bare `#[should_panic]` (no `expected`) | Passes on *any* panic, incl. unintended | `#[should_panic(expected = "…")]` or assert `Err` |
| `#[should_panic]` + `-> Result` test | Incompatible combination | Drop `should_panic`; `assert_eq!(v, Err(..))` |
| `debug_assert!` as a test assertion | No-op under `--release` → false pass | `assert!`/`assert_eq!` |
| `assert!(a == b)` | No values printed on failure | `assert_eq!(a, b)` |
| `assert_eq!` on `f64`/`f32` | Float rounding → flaky/brittle | Epsilon, `approx`/`float_cmp` |
| `assert_eq!(format!("{:?}", x), "…")` of internal type | Couples to private `Debug` derive | Assert the field/variant (`matches!`) |
| Asserting `HashMap`/`HashSet` order | Randomized hasher → differs every run | Compare as sets / sort / assert keys |
| `thread::sleep` to "wait for" async | Timing-dependent; fails under parallel load | `#[tokio::test(start_paused)]` + `advance`; await the handle |
| Real network/DNS / unseeded RNG in a unit test | Slow, flaky, offline-failing | `wiremock`/`httpmock`; `StdRng::seed_from_u64` |
| Flagging `unwrap()`/`expect()` in test code as a bug | It is idiomatic — a panic *is* the failure signal | Leave it; suggest `.expect("ctx")` only as triage |
| `proptest-regressions/` gitignored/absent | Known counterexample silently un-tested | Commit `proptest-regressions/` |
| Tautological property test; `assert!` in `proptest!` | Tests nothing / degrades shrink output | Property of *your* code; `prop_assert!` |
| `for`-loop over cases with `assert_eq!` | Failing case unidentifiable | `rstest` `#[case]` / `test-case` |
| `insta` snapshot of UUID/timestamp un-redacted; blanket `insta accept` | Flaky → blind-accept bakes in regressions | Redactions; `cargo insta review` each diff |
| Over-mock; `expect_*` with no `.times`/assertion | Tests the mock, verifies nothing | Mock only the boundary; assert behavior + `.times` |
| Unsynchronized `#[automock]` static/`*_context()` | Global expectations race in parallel | `#[serial]`; prefer instance mocks |
| `Command::new("installed-binary")` in tests | Runs stale code, not the build | `assert_cmd::Command::cargo_bin("name")` |
| `assert_cmd` `Command` without `.success()`/`.code()` | Exit status never asserted (not implicit) | Explicit `.assert().success()`/`.code(n)` |
| `ignore` on a doctest to hide a `?`/compile error | Public-API example silently rots | Hidden `# fn main() -> Result<…> {…# Ok(()) #}` |
| CI runs only `cargo test --lib` / one feature set | Doctests + feature-gated paths never run | Also `cargo test --doc`; `--all-features`/`--no-default-features` |

## Output Format (Review Mode)

Group findings by severity:

```
## Critical
Tests that can falsely pass or are flaky — they mask real regressions: shared state under parallel exec, bare `#[should_panic]`, float `assert_eq!`, `debug_assert!`-as-assertion, `HashMap`-order assertions, real sleep/network/unseeded RNG, gitignored `proptest-regressions/`, un-redacted nondeterministic snapshots, stale-binary CLI tests, `ignore`d-doctest rot.

### [PRINCIPLE N] Brief title
**File**: `path/to/file.rs` (lines X–Y)
**Principle**: What the rule requires.
**Violation**: What the test does wrong and the concrete impact (false pass / flake / masked regression).
**Fix**: Specific, actionable change (with the corrected snippet).
**Evidence**: Quote the offending line(s).

## Warning
Tests that weaken value or structure-couple but are unlikely to falsely pass alone: `assert!(a==b)`, `Debug`-string coupling, unnamed `for`-loop tables, needless `multi_thread`, repeated logger init, `#[ignore]` without a reason, `expect_*` without `.times`.

(same structure)

## Suggestion
Idiom/diagnostic improvements: `.expect("ctx")` over `.unwrap()` in tests, `rstest` over loops, `pretty_assertions`, `cargo llvm-cov`, doctest coverage.

(same structure)

## Summary
- Total findings: N (X critical, Y warning, Z suggestion)
- Test kinds in scope: unit / integration / doctests / bench
- Edition: 2021 / 2024 (affects `set_var` safety, `static mut`)
- Highest-risk principle (the dominant false-pass source)
- clippy: clean / not-run / N test-relevant lints (note: most are allow-by-default)
- Overall test-suite reliability: 1–2 sentences
```

## Rules

- **Match the project's conventions** — adopt existing module layout, naming, and assertion style before introducing anything new; never introduce a test crate without approval.
- **Rust has no `_test.rs` convention** — locate tests by `#[cfg(test)]`/`#[test]`, the `tests/` dir, and doc fences. A filename-based reviewer misroutes every Rust test.
- **`unwrap`/`expect` in tests is idiomatic — never flag it as a bug.** The relevant Clippy lints (`unwrap_used`/`expect_used`/`unwrap_in_result`) are `restriction`, allow-by-default, and `allow-unwrap-in-tests` defaults to `false` — so do not treat them as standard, and do not treat test `unwrap` as a finding.
- **Parallel-by-default is the master footgun** — judge every shared-state, env, port, path, and timing pattern against concurrent execution. State explicitly that "passes when run alone" does not clear it.
- **Cite the mechanism** — every Critical names *why* it falsely passes or flakes (the parallel race, the randomized hasher, the compiled-out `debug_assert!`, the stale binary), not just "bad test."
- **Verify version/edition-pinned claims** — check `Cargo.toml` edition/MSRV and the resolved crate versions before asserting `set_var`-unsafe (2024), `criterion::black_box` deprecation, `#[tokio::test]` features, or a Clippy lint's group/level. Clippy groups were verified against the official index (May 2026); `should_panic_without_expect` is **pedantic** (added clippy 1.74.0), allow-by-default — *not* restriction; bare `#[should_panic]` is still a Critical false-pass by Principle 4 regardless of the lint being off by default.
- **Stay in test code** — production-code bugs go to `agentwright:rust-correctness-audit`; missing tests go to `agentwright:test-coverage-audit`.
- **Only verified claims** — every recommendation traces to the Rust Book/Reference/Cargo book or an official crate doc cited in REFERENCE.md.
