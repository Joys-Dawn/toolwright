# Rust Test Writing — Reference

The failure mechanism, Rust-specific rationale, anti-pattern→correct code, exact tooling, severity (review mode), and primary-source citation for every principle in `SKILL.md`. Severity uses the test-skill family's tiers: **Critical** = can falsely pass / is flaky (masks regressions); **Warning** = weakens value or structure-couples; **Suggestion** = idiom/diagnostic improvement. Clippy lint groups/levels were verified against the official lint index (May 2026); the one research-dossier error (`should_panic_without_expect`) is corrected here against the rust-clippy `master` source.

**Two load-bearing facts, verified against primary sources:**

> **Parallel-by-default — VERIFIED.** *The Rust Book* ch. 11.2: *"by default they run in parallel using threads."* *Cargo Book → cargo test*: the harness runs `#[test]` functions "in multiple threads." **Nuance (also primary):** integration-test *files* are separate binaries run **serially relative to each other**; only the `#[test]` functions *within one binary* run on parallel threads; doc-test executables "run in parallel in separate processes."

> **`#[should_panic(expected = …)]` is a SUBSTRING match — VERIFIED.** *Reference → Testing attributes*: *"the given string must appear somewhere within the panic message for the test to pass."* *Book* ch. 11.1: *"the failure message contains the provided text."* Containment, not equality or regex.

> — [Book ch. 11.2](https://doc.rust-lang.org/book/ch11-02-running-tests.html) · [Cargo Book — cargo test](https://doc.rust-lang.org/cargo/commands/cargo-test.html) · [Reference — Testing attributes](https://doc.rust-lang.org/reference/attributes/testing.html)

---

## 1. The `cargo test` execution model & isolation footguns

`cargo test` builds a libtest binary that runs every `#[test]` **in parallel on multiple threads by default**. Any state shared across test functions in the same binary — a `static`/`static mut`, `lazy_static!`/`OnceLock`/`OnceCell`, the process environment, the cwd, a fixed network port, a fixed temp path, a shared DB — is a data race or interference hazard. Most languages default to single-threaded or fork-per-test runners; Rust's is shared-process multi-thread, so tests that "work alone" fail nondeterministically under parallel scheduling. The environment is the sharpest edge: per `std::env::set_var`'s Safety docs there is no thread-safe way to read the environment on non-Windows, and other threads (even DNS via `ToSocketAddrs`) may read it concurrently; `set_current_dir` is process-global and corrupts every other test resolving relative paths. **This is the #1 source of flaky Rust tests.**

**Anti-pattern → Correct:**
```rust
#[test]
fn parses_config() {
    std::env::set_var("APP_MODE", "test");          // BUG: process-global; edition 2024: unsafe
    std::env::set_current_dir("fixtures").unwrap(); // BUG: process-global, corrupts other tests
    assert_eq!(load_config().mode, "test");
}
// FIX: inject inputs
#[test]
fn parses_config() {
    let cfg = load_config_from(Path::new("tests/fixtures/app.toml"), "test");
    assert_eq!(cfg.mode, "test");
}
// FIX: if a global seam is unavoidable, isolate + serialize
#[test] #[serial(env)]
fn reads_app_mode() { let _g = TempEnv::set("APP_MODE", "test"); assert_eq!(detect_mode(), Mode::Test); }
```
**Severity:** Critical — shared mutable state / `set_var` / `set_current_dir` / fixed ports under parallel execution produce nondeterministic false passes that mask regressions.
**Tooling:** `cargo test -- --test-threads=N` (libtest arg, **after `--`**; `-j N` only parallelizes the *build*). `cargo nextest run` = process-per-test isolation. `serial_test` ≥ 3: `#[serial]`/`#[parallel]` (in-process), `#[file_serial]`/`#[file_parallel]` (cross-process file lock — needed for doctests/integration binaries). No Clippy lint catches this.
> — [Book ch. 11.2](https://doc.rust-lang.org/book/ch11-02-running-tests.html) · [std env::set_var (Safety)](https://doc.rust-lang.org/std/env/fn.set_var.html) · [cargo-nextest model](https://nexte.st/docs/design/how-it-works/) · [serial_test](https://docs.rs/serial_test/latest/serial_test/)

## 2. Test placement & the three kinds — Rust has **no `_test.rs` convention**

Three kinds: **(a) unit** — `#[cfg(test)] mod tests { use super::*; }` in the same `src` file; can test **private** items. **(b) integration** — each file directly under `tests/` is its **own crate**, black-box, public API only; *"Each file in the tests directory is a separate crate."* **(c) doctests** — `///`/`//!` examples, compiled and executed by `cargo test`. **Rust has no `*_test.rs` / `*.test.rs` filename convention** (unlike Go's `_test.go`, JS's `.test.ts`) — an auditor keying off filenames misroutes every Rust test. Shared integration helpers go in `tests/common/mod.rs`: *"Files in subdirectories of the tests directory don't get compiled as separate crates."* A `tests/common.rs` *is* compiled as a test crate → a spurious empty "running 0 tests". A binary-only crate (no `src/lib.rs`) cannot be integration-tested via `use` — extract logic to `src/lib.rs`.

**Anti-pattern → Correct:**
```rust
// BUG: tests/common.rs → its own test crate, emits "Running tests/common.rs … running 0 tests"
// FIX: tests/common/mod.rs → a shared module
// tests/common/mod.rs
pub fn setup() -> Db { Db::in_memory() }
// tests/api.rs
mod common;
#[test] fn lists_users() { let db = common::setup(); assert!(my_crate::list_users(&db).is_empty()); }
```
**Severity:** Warning — `tests/common.rs` and filename-based misrouting don't cause false passes but pollute output and indicate the model is misunderstood; an "integration" test reaching private items isn't truly black-box. (Filename-convention misrouting *in an audit tool* is a structural defect, not a per-test bug.)
**Tooling:** Correct locators — unit: `#[cfg(test)]` modules in `src/**/*.rs` containing `#[test]`; integration: files directly under `tests/` (not `tests/*/`); doctests: fenced blocks in `///`/`//!`/`#[doc]`. `cargo test --lib` / `--test <name>` / `--doc` target one kind.
> — [Book ch. 11.3](https://doc.rust-lang.org/book/ch11-03-test-organization.html) · [Cargo Book — integration tests](https://doc.rust-lang.org/cargo/reference/cargo-targets.html#integration-tests) · [Cargo Book — tests guide](https://doc.rust-lang.org/cargo/guide/tests.html)

## 3. `#[test]` and async / alternative test attributes

Plain `#[test]` requires a free, monomorphic, zero-arg function whose return type implements `Termination` (`()` or `Result<T, E: Debug>`). `#[test]` cannot run an `async fn` (no built-in executor) — a bare `async fn` test won't compile / does nothing useful. Async tests need a runtime attribute: `#[tokio::test]` (default **current-thread**, one runtime per test — itself an isolation feature; `flavor = "multi_thread"` needs `rt-multi-thread` and reintroduces intra-test concurrency; `start_paused = true` needs `test-util`), `#[async_std::test]`, `#[actix_rt::test]`, `#[sqlx::test]` (per-test isolated DB + migrations). `#[bench]`/`test::Bencher` is **unstable/nightly-only** (`#![feature(test)]`) — *"The internals of the `test` crate are unstable"* — so it won't compile on stable; stable benchmarking is `criterion` via `[[bench]]` + `harness = false`.

**Anti-pattern → Correct:**
```rust
#[test] async fn fetches() { let r = client.get().await; assert!(r.is_ok()); } // BUG: won't compile
#![feature(test)] #[bench] fn b(b: &mut test::Bencher){ b.iter(|| compute()); } // BUG: nightly-only
// FIX
#[tokio::test] async fn fetches() { let r = client.get().await; assert!(r.is_ok()); }
// benches/throughput.rs  ([[bench]] name="throughput" harness=false)
use criterion::{criterion_group, criterion_main, Criterion};
fn bench(c: &mut Criterion){ c.bench_function("compute", |b| b.iter(compute)); }
criterion_group!(benches, bench); criterion_main!(benches);
```
**Severity:** Critical for `#[bench]`/`#![feature(test)]` in a crate expected to build on stable (CI fails or the bench silently never runs as a test); Warning for needless `multi_thread` (reintroduces nondeterminism); Suggestion for not using `#[test_log::test]` to surface logs.
**Tooling:** `#[tokio::test(flavor = "multi_thread", worker_threads = N)]`, `#[tokio::test(start_paused = true)]` (tokio feature `test-util`). `cargo +nightly bench` for `#[bench]`. Criterion ≥ 0.5: `criterion::black_box` is **deprecated** — use `std::hint::black_box`. No specific Clippy lint.
> — [Reference — `#[test]`](https://doc.rust-lang.org/reference/attributes/testing.html#the-test-attribute) · [Unstable Book — `test`](https://doc.rust-lang.org/unstable-book/library-features/test.html) · [tokio::test](https://docs.rs/tokio/latest/tokio/attr.test.html) · [sqlx::test](https://docs.rs/sqlx/latest/sqlx/attr.test.html) · [criterion](https://docs.rs/criterion/latest/criterion/)

## 4. `#[should_panic]` correctness

`#[should_panic]` passes if the body panics for **any** reason; `#[should_panic(expected = "substr")]` passes only if the panic message **contains** `substr` (substring, verified). *"A `should_panic` test would pass even if the test panics for a different reason from the one we were expecting"* — so a too-loose or missing `expected` passes on an *unintended* panic (a typo'd `unwrap` in setup), masking a real bug. The substring semantics mean `expected = "index"` matches both `"index out of bounds"` and an unrelated `"reindexing failed"` — tighten to a message unique to the intended panic. `#[should_panic]` is **incompatible with `-> Result` tests**. `debug_assert!`-sourced panics do **not** fire under `--release`, so a `should_panic` test of a `debug_assert!` falsely *fails to panic* in release. For `Result` APIs, prefer asserting `Err`.

**Anti-pattern → Correct:**
```rust
#[test] #[should_panic]                              // BUG: passes on ANY panic
fn divide_by_zero() { let cfg = Config::load().unwrap(); divide(cfg.n, 0); } // a panicking unwrap "passes"
// FIX: pin the substring, or assert Err
#[test] #[should_panic(expected = "divide by zero")]
fn divide_by_zero() { divide(10, 0); }
#[test] fn divide_by_zero_is_err() { assert_eq!(checked_divide(10, 0), Err(MathError::DivByZero)); }
```
**Severity:** Critical — bare `#[should_panic]` and over-broad `expected` are classic false-pass bugs; `should_panic` on a `debug_assert!` is a release/debug-divergent false result.
**Tooling:** `#[should_panic]` cannot combine with `-> Result` tests — use `assert!(v.is_err())` / `assert_eq!(v, Err(..))`. **Clippy `should_panic_without_expect` is `pedantic`, allow-by-default (added clippy 1.74.0)** — *not* `restriction` (a research-dossier error, corrected against the rust-clippy `master` source). It is off by default, so "Clippy clean" proves nothing here — this skill flags bare `#[should_panic]` as Critical on its own merits regardless of the lint level.
> — [Book ch. 11.1](https://doc.rust-lang.org/book/ch11-01-writing-tests.html) · [Reference — `#[should_panic]`](https://doc.rust-lang.org/reference/attributes/testing.html#the-should_panic-attribute) · [Clippy: should_panic_without_expect](https://rust-lang.github.io/rust-clippy/master/index.html#should_panic_without_expect)

## 5. Assertion quality

Prefer `assert_eq!`/`assert_ne!` over `assert!(a == b)`: the former *"print the two values if the assertion fails"*; the latter *"only indicates that it got a `false` value … without printing the values."* Never compare floats with `assert_eq!` — rounding makes `assert_eq!(0.1 + 0.2, 0.3)` fail; this is a *correct but useless* test future authors "fix" by loosening (or a flaky pass). **Never use `debug_assert!` as a test assertion** — it is a silent no-op under `cargo test --release` (false pass). Asserting on `format!("{:?}", internal_struct)` couples the test to the private `Debug` derive — a behavior-preserving refactor breaks it. Add custom messages (forwarded to `format!`) for non-obvious invariants; `pretty_assertions` for large diffs; `matches!` for variant assertions.

**Anti-pattern → Correct:**
```rust
assert!(result == Expected { a: 1, b: 2 });                 // BUG: no diff on failure
assert_eq!(compute(), 0.3_f64);                              // BUG: float equality — flaky
debug_assert!(invariant_holds(&x));                          // BUG: no-op in --release
assert_eq!(format!("{:?}", parsed), "Ast { kind: Num, .. }"); // BUG: Debug-coupled
// FIX
assert_eq!(result, Expected { a: 1, b: 2 });
assert!((compute() - 0.3).abs() < 1e-9, "got {}", compute());
assert!(invariant_holds(&x), "invariant broken for {x:?}");
assert!(matches!(parsed.kind, AstKind::Num(3)));
```
**Severity:** Critical for float `assert_eq!` and `debug_assert!`-as-assertion (false pass / release-divergent); Warning for `assert!(a == b)` (weak diagnostics) and `Debug`-string structure-coupling; Suggestion for missing `pretty_assertions`.
**Tooling (verified):** `clippy::bool_assert_comparison` (**style, warn**) flags `assert_eq!(x, true)`; `clippy::assertions_on_constants` (**style, warn**) flags `assert!(true/false)`; `clippy::eq_op` (**correctness, deny**) flags `assert_eq!(x, x)`; `clippy::approx_constant` (**correctness, deny**) flags hand-written `3.14`. `clippy::float_cmp` is **pedantic, allow** and `clippy::float_cmp_const` is **restriction, allow** — float equality is **not** caught by default Clippy; the skill must flag it itself.
> — [Book ch. 11.1](https://doc.rust-lang.org/book/ch11-01-writing-tests.html) · [Clippy: float_cmp](https://rust-lang.github.io/rust-clippy/master/index.html#float_cmp) · [Clippy: eq_op](https://rust-lang.github.io/rust-clippy/master/index.html#eq_op) · [Clippy: bool_assert_comparison](https://rust-lang.github.io/rust-clippy/master/index.html#bool_assert_comparison)

## 6. `Result`-returning tests; `unwrap`/`expect` in tests is fine

`#[test] fn t() -> Result<(), E>` lets you use `?` instead of `.unwrap()` ladders — such a test passes when it returns `Ok(())` and fails on an `Err` (or a panic). **`.unwrap()`/`.expect("why")` in test code is idiomatic and acceptable** — a panic *is* the failure signal — but `.expect("descriptive context")` beats bare `.unwrap()` for triage. Distinguish sharply: `unwrap` in a **test** is fine; `unwrap` in **library** code is a correctness concern (a different skill's scope). **A reviewer must not blanket-flag `unwrap()` in tests — that is a false finding.** `#[should_panic]` cannot combine with `-> Result`.

**Anti-pattern → Correct:**
```rust
#[test] #[should_panic]                                    // BUG: incompatible with -> Result
fn round_trips() -> Result<(), Box<dyn std::error::Error>> {
    let v = parse(input).unwrap();                         // which unwrap blew up?
    assert_eq!(parse(&serialize(&v).unwrap()).unwrap(), v); Ok(())
}
// FIX
#[test] fn round_trips() -> Result<(), Box<dyn std::error::Error>> {
    let v = parse(input)?;                                 // ? gives a labeled Err
    assert_eq!(parse(&serialize(&v)?)?, v); Ok(())
}
let cfg = Config::load().expect("fixture tests/fixtures/app.toml must parse"); // expect w/ context
```
**Severity:** Suggestion for bare `.unwrap()` vs `.expect("…")` in tests (triage-only, *not* a false pass); Critical only if `#[should_panic]` is paired with a `-> Result` test (nonsensical / won't compile).
**Tooling (verified):** `clippy::unwrap_used`, `clippy::expect_used`, `clippy::unwrap_in_result` are all **restriction, allow** — *not* standard lints. The `allow-unwrap-in-tests` config option **defaults to `false`** (so even a project enabling `unwrap_used` still lints test `unwrap`s unless it opts in) — reinforcing that this skill must treat test `unwrap`/`expect` as idiomatic, never a finding.
> — [Book ch. 11.1](https://doc.rust-lang.org/book/ch11-01-writing-tests.html) · [Reference — `#[test]`](https://doc.rust-lang.org/reference/attributes/testing.html#the-test-attribute) · [Clippy: unwrap_used](https://rust-lang.github.io/rust-clippy/master/index.html#unwrap_used) · [Clippy lint config — allow-unwrap-in-tests](https://doc.rust-lang.org/clippy/lint_configuration.html#allow-unwrap-in-tests)

## 7. Test isolation & determinism (beyond Principle 1)

No reliance on test ordering (libtest ordering is unspecified). **Never assert on `HashMap`/`HashSet` iteration order** — the default hasher is randomized per `RandomState`, so order differs run-to-run *and* map-to-map; `assert_eq!(map.keys().collect::<Vec<_>>(), vec![…])` is a textbook flaky test. No wall-clock dependence — no `SystemTime::now()`/`Instant::now()`/`thread::sleep` for timing (sleep-based "wait for it" fails under the parallel scheduler's load); inject a clock or use `#[tokio::test(start_paused = true)]` + `tokio::time::advance`. No real network/DNS in unit tests (`wiremock`/`httpmock`/`mockito`). Seed all randomness (`StdRng::seed_from_u64`). Filesystem via `tempfile`/`assert_fs` — mind `tempfile`'s documented **early-drop pitfall** (`TempDir`/`NamedTempFile` dropped early in `AsRef<Path>` APIs → spurious "No such file"). Init global loggers/`tracing` exactly once (`std::sync::Once` or `#[test_log::test]`).

**Anti-pattern → Correct:**
```rust
assert_eq!(to_json(&user), r#"{"id":1,"name":"a"}"#);  // BUG: HashMap order randomized
spawn_job(); std::thread::sleep(Duration::from_millis(200)); assert!(Path::new("/tmp/out").exists()); // BUG
// FIX
let v: serde_json::Value = serde_json::from_str(&to_json(&user))?;
assert_eq!(v["id"], 1); assert_eq!(v["name"], "a");    // structural, order-free
#[tokio::test(start_paused = true)] async fn job() {
    let dir = tempfile::tempdir()?; let out = dir.path().join("out");
    let h = spawn_job(out.clone()); tokio::time::advance(Duration::from_millis(200)).await;
    h.await?; assert!(out.exists());
}
```
**Severity:** Critical — `HashMap`/`HashSet` order assertions, real `sleep`-for-timing, real network / unseeded RNG, and shared fixed FS paths are reproducible false-pass / flaky sources; Warning for repeated logger init without `Once`.
**Tooling:** `#[tokio::test(start_paused = true)]` + `tokio::time::advance` (feature `test-util`). `tempfile`/`assert_fs`. `wiremock`/`httpmock`. `cargo nextest run --partition` surfaces order coupling. No default Clippy lint.
> — [Book ch. 11.2](https://doc.rust-lang.org/book/ch11-02-running-tests.html) · [tempfile (early-drop pitfall)](https://docs.rs/tempfile/latest/tempfile/) · [tokio::test](https://docs.rs/tokio/latest/tokio/attr.test.html) · [wiremock](https://docs.rs/wiremock/latest/wiremock/) · [assert_fs](https://docs.rs/assert_fs/latest/assert_fs/)

## 8. Property-based & fuzz testing

`proptest`: define `Strategy`s, assert with `prop_assert!`/`prop_assert_eq!` (**not** `assert!`, which panics mid-shrink and spams output per shrink), automatic shrinking, configure via `ProptestConfig::with_cases(N)`. The **`proptest-regressions/` failure-persistence file MUST be committed** — default `failure_persistence = FileFailurePersistence::SourceParallel("proptest-regressions")` replays persisted counterexamples *before* random cases; gitignoring it means a known counterexample silently stops being tested (a regression-masking false pass). `quickcheck`: `Arbitrary` + shrinking. Fuzzing: `cargo-fuzz` + libFuzzer (`libfuzzer-sys`) with `arbitrary`. Anti-patterns: tautologies (`a + b == b + a` proves nothing about *your* code), non-deterministic/side-effecting strategies (break shrinking & `fork`), strategies too broad to hit the interesting region.

**Anti-pattern → Correct:**
```rust
proptest! { #[test] fn add_commutes(a in any::<i32>(), b in any::<i32>()) {
    assert_eq!(a.wrapping_add(b), b.wrapping_add(a)); }}        // BUG: tests std + panicking assert
// FIX: a round-trip property of OUR code, prop_assert!, commit regressions
proptest! { #![proptest_config(ProptestConfig::with_cases(1000))]
    #[test] fn parse_inverts_display(v in any::<Money>()) {
        prop_assert_eq!(v.to_string().parse::<Money>().unwrap(), v); }}
// git add proptest-regressions/   <-- MUST be committed
```
**Severity:** Critical — gitignored/missing `proptest-regressions/` (regression silently un-tested) and tautological property tests (false confidence); Warning for `assert!` instead of `prop_assert!` (degrades shrink output) and over-broad strategies.
**Tooling:** `ProptestConfig::with_cases` / `PROPTEST_CASES` / `failure_persistence`. quickcheck `QUICKCHECK_TESTS`. `cargo +nightly fuzz run <target>`. No Clippy lint.
> — [proptest book](https://altsysrq.github.io/proptest-book/proptest/getting-started.html) · [proptest Config](https://docs.rs/proptest/latest/proptest/test_runner/struct.Config.html) · [quickcheck](https://docs.rs/quickcheck/latest/quickcheck/) · [Rust Fuzz Book](https://rust-fuzz.github.io/book/cargo-fuzz.html)

## 9. Fixtures, parametrization & snapshots

libtest reports failures per `#[test]` function — a hand-rolled `for`-loop over cases is **one** function, so a panic on case 7 reports a line number, not *which input*; all N cases collapse into one failure. Use `rstest` `#[fixture]`/`#[case(...)]`/`#[values(...)]` (generates a distinct, named test per case) or `test-case`. `insta` snapshots: `assert_snapshot!`/`assert_debug_snapshot!`/`assert_yaml_snapshot!`, the `cargo insta review` workflow, **redactions for nondeterministic fields** (UUIDs, timestamps), commit the `.snap` files. Anti-pattern: snapshotting a fresh `Uuid::new_v4()`/`SystemTime` without redaction makes the snapshot fail every run, and the lazy "fix" — blanket `cargo insta accept` / `INSTA_UPDATE=always` — bakes the nondeterminism (or a real regression) in permanently.

**Anti-pattern → Correct:**
```rust
#[test] fn fib_cases() { for (i,e) in [(0,0),(10,55)] { assert_eq!(fib(i), e); } } // BUG: failing case unlabeled
#[test] fn user_snap() { insta::assert_yaml_snapshot!(make_user()); }              // BUG: .id is random UUID
// FIX
#[rstest] #[case(0,0)] #[case(10,55)]
fn fib(#[case] n: u32, #[case] expected: u64) { assert_eq!(fibonacci(n), expected); } // fib::case_2 fails by name
#[test] fn user_snap() { insta::assert_yaml_snapshot!(make_user(), { ".id" => "[uuid]", ".created" => "[ts]" }); }
```
**Severity:** Critical for `insta` snapshots of nondeterministic data without redactions (flaky → forces blind-accept); Warning for unnamed `for`-loop table tests (failing case unidentifiable) and unreviewed `.snap` churn; Suggestion for `rstest`/`test-case` over loops.
**Tooling:** `cargo insta review` (correct) vs blanket `cargo insta accept` (anti-pattern). insta `redactions` feature; `dynamic_redaction`/`sorted_redaction`/`rounded_redaction`. `rstest` `#[case]`/`#[values]`/`#[fixture]`. No Clippy lint.
> — [rstest](https://docs.rs/rstest/latest/rstest/) · [insta docs](https://insta.rs/docs/) · [insta redactions](https://insta.rs/docs/redactions/)

## 10. Mocking & test doubles

Rust has **no built-in mocking** — the idiomatic seam is a **trait** + generics/`dyn` + dependency injection. `mockall`: `#[automock]` (single-`impl` traits/structs) or `mock!` (multiple/inherited/external), `expect_*().with(pred).times(n).returning(..)`, `Sequence` for ordering, `checkpoint()`. mockall panics on accesses *"contrary to your expectations"* and verifies call counts **on drop** — but a default expectation allows *unlimited* calls, so an `expect_*` with **no `.times(..)` and no behavioral assertion verifies nothing** (only that the type compiles). mockall static-method/module mocks have **global** expectations (*"you must provide your own synchronization"*) — combined with Principle 1's parallel default, two tests touching the same mocked static race unless serialized. `#[automock]` must appear *before* `#[async_trait]` (wrong order silently produces a non-functional mock). Over-mocking (asserting the mock's programmed behavior) tests nothing real.

**Anti-pattern → Correct:**
```rust
#[test] fn gets_user() {
    let mut db = MockDb::new();
    db.expect_get().returning(|_| Ok(User::dummy())); // BUG: no .times → verifies nothing
    assert_eq!(Service::new(db).get_user(1).unwrap(), User::dummy()); // re-reads the mock
}
// FIX: mock only the boundary; assert real behavior + verify the interaction
#[test] fn caches_after_first_db_hit() {
    let mut db = MockDb::new();
    db.expect_get().with(predicate::eq(1)).times(1).returning(|_| Ok(User::named("ann")));
    let svc = Service::new(db);
    assert_eq!(svc.get_user(1).unwrap().name, "ann");
    assert_eq!(svc.get_user(1).unwrap().name, "ann"); // 2nd from cache; drop asserts get() called once
}
```
**Severity:** Critical for unsynchronized global (`#[automock]` static/module/`*_context()`) expectations under parallel tests (race → flaky); Warning for over-mocking / `expect_*` with no `.times` and no assertion and gratuitous `Sequence` order-coupling; Suggestion for mocking owned concrete types where a trait seam is cleaner.
**Tooling:** mockall ≥ 0.13: `#[automock]`, `mock!`, `Sequence`, `checkpoint()`, `*_context()` for statics (serialize with `serial_test`). `wiremock`/`httpmock` for HTTP boundaries. No Clippy lint.
> — [mockall](https://docs.rs/mockall/latest/mockall/) · [wiremock](https://docs.rs/wiremock/latest/wiremock/)

## 11. CLI / binary / filesystem integration testing

Test binaries with `assert_cmd`: `Command::cargo_bin("name")` resolves the binary **Cargo just compiled for this test run** (`CARGO_BIN_EXE_<name>` is set when an integration test is built), so the test exercises *current* code; `std::process::Command::new("mytool")` runs whatever is on `PATH` (stale code → silent false pass). `.assert()` then `.success()`/`.failure()`/`.code(n)`/`.stdout(pred)`/`.stderr(pred)` with `predicates`. The crate is explicit that *"`success()` is not implicit and requires being explicitly called"* — a `Command` built but missing `.success()`/`.code()` asserts nothing about exit status. Use `assert_fs`/`tempfile` for FS fixtures and assertions; never cwd-relative or fixed absolute fixture paths (Principle 1 collision).

**Anti-pattern → Correct:**
```rust
#[test] fn cli_runs() {
    let out = std::process::Command::new("mytool").arg("--version").output().unwrap(); // BUG: stale binary
    assert!(!out.stdout.is_empty());                                                    // success() unchecked
}
// FIX
use assert_cmd::Command; use predicates::prelude::*;
#[test] fn version_exits_zero_and_prints_semver() {
    Command::cargo_bin("mytool").unwrap().arg("--version")
        .assert().success()                                          // explicit — not implicit
        .stdout(predicate::str::is_match(r"\d+\.\d+\.\d+").unwrap());
}
```
**Severity:** Critical for shelling out to an installed/`PATH` binary instead of `cargo_bin` (tests stale code — silent false pass); Warning for a `Command` with no `.success()`/`.code()`/output assertion (verifies nothing) and cwd-relative fixtures.
**Tooling:** `assert_cmd` ≥ 2 `Command::cargo_bin`; `predicates` ≥ 3 `predicate::str::*`/`path::*`; `assert_fs` `TempDir::child(..).assert(..)`; `escargot` for fine build control. No Clippy lint.
> — [assert_cmd](https://docs.rs/assert_cmd/latest/assert_cmd/) · [predicates](https://docs.rs/predicates/latest/predicates/) · [assert_fs](https://docs.rs/assert_fs/latest/assert_fs/) · [Cargo Book — `CARGO_BIN_EXE_<name>`](https://doc.rust-lang.org/cargo/commands/cargo-test.html)

## 12. Coverage, CI & maintenance hygiene

Measure coverage with `cargo llvm-cov` (preferred; LLVM source-based) or `cargo tarpaulin`. **Always run `cargo test --doc` in CI** — doctests are real tests but `cargo test --lib` skips them entirely, so a broken public-API example goes uncaught (doctests exist precisely to keep examples *"up to date and working"*). rustdoc wraps a doctest body in `fn main() { … }`; a bare `?` then yields "mismatched types", and authors slap `ignore` on it — the example then **silently stops being compiled or run** (the doc rots into a lie). Use a hidden `# fn main() -> Result<…> { … # Ok(()) # }` (or trailing `# Ok::<(), E>(())`, Rust ≥ 1.34, no internal whitespace in `(())`). `#[ignore]` must carry a reason (`#[ignore = "needs DATABASE_URL"]`) and CI must run `cargo test -- --include-ignored` somewhere, or ignored tests rot. Run a feature matrix (`--all-features` / `--no-default-features`) — a path only tested under default features is false confidence; `no_run` (compile, don't execute) is correct for network examples, `ignore` *"is almost never what you want."*

**Anti-pattern → Correct:**
```rust
/// ```ignore
/// let cfg = my_crate::Config::load()?;   // BUG: never compiled or run — doc rots
/// ```
#[test] #[ignore] #[cfg(feature = "postgres")] fn pg() {}   // BUG: no reason; CI never builds the feature
// FIX
/// ```
/// # fn main() -> Result<(), Box<dyn std::error::Error>> {
/// let cfg = my_crate::Config::load()?;
/// assert_eq!(cfg.port, 8080);
/// # Ok(()) # }
/// ```
#[test] #[ignore = "requires DATABASE_URL; CI runs via --include-ignored"] #[cfg(feature = "postgres")] fn pg() {}
// CI: cargo test --all-features -- --include-ignored && cargo test --doc
```
**Severity:** Critical for `ignore` on a doctest masking a broken public-API example (doc rots, defeats doctests); Warning for `#[ignore]` with no reason and feature-gated tests never built in CI (silent rot); Suggestion for missing `--all-features`/`--no-default-features` matrix and `tarpaulin` where `llvm-cov` is more accurate.
**Tooling:** `cargo llvm-cov` (≥ 0.6; `--all-features`, `--doctests`). `cargo test --doc`. `cargo test -- --include-ignored`/`--ignored`. Doctest attrs per the rustdoc book. No Clippy lint.
> — [rustdoc book — documentation tests](https://doc.rust-lang.org/rustdoc/write-documentation/documentation-tests.html) · [Cargo Book — tests guide](https://doc.rust-lang.org/cargo/guide/tests.html) · [Cargo Book — cargo test](https://doc.rust-lang.org/cargo/commands/cargo-test.html) · [cargo-llvm-cov](https://docs.rs/cargo-llvm-cov/latest/cargo_llvm_cov/)

---

## Version / Edition-Sensitive Items

- **Rust 2024 edition:** `std::env::set_var` / `remove_var` are now **`unsafe fn`** (*"It can be unsound to call … in a multithreaded program"*); pre-2024 code compiles them as safe, 2024 requires `unsafe {}`. `std::os::unix::process::CommandExt::before_exec` also became unsafe (use `pre_exec`). — [Edition Guide — newly unsafe functions](https://doc.rust-lang.org/edition-guide/rust-2024/newly-unsafe-functions.html)
- **`#[bench]` / `test::Bencher`:** nightly-only behind `#![feature(test)]`; no stabilization. Stable replacement: `criterion`. — [Unstable Book — `test`](https://doc.rust-lang.org/unstable-book/library-features/test.html)
- **`#[ignore = "reason"]`:** the `MetaNameValueStr` reason form is current rustc; older code shows bare `#[ignore]`. — [Reference — Testing attributes](https://doc.rust-lang.org/reference/attributes/testing.html)
- **Doctest `?` ergonomics:** the `# Ok::<(), E>(())` implicit-`Result`-main form requires **Rust ≥ 1.34.0**; `(())` must have no internal whitespace. — [rustdoc book](https://doc.rust-lang.org/rustdoc/write-documentation/documentation-tests.html)
- **`#[tokio::test]` defaults:** default flavor **current-thread** (one runtime per test); `multi_thread` needs `rt-multi-thread`; `start_paused`/`tokio::time::pause` need `test-util`. (tokio ≥ 1.x.) — [tokio::test](https://docs.rs/tokio/latest/tokio/attr.test.html)
- **`criterion::black_box`** is **deprecated** (criterion ≥ 0.5) — use `std::hint::black_box`. — [criterion](https://docs.rs/criterion/latest/criterion/)
- **proptest 1.x:** `ProptestConfig` `cases` default 256, `PROPTEST_CASES` override; default `failure_persistence = FileFailurePersistence::SourceParallel("proptest-regressions")`. **insta** redactions need the opt-in `redactions` feature. Crate floors: `mockall` ≥ 0.12/0.13, `assert_cmd` ≥ 2, `predicates` ≥ 3, `serial_test` ≥ 3, `wiremock` 0.5–0.6.
- **Clippy lint groups (verified against the official index, May 2026; one dossier error corrected against rust-clippy `master` source):** `unwrap_used` / `expect_used` / `unwrap_in_result` / `float_cmp_const` → **restriction, allow**; `float_cmp` / `used_underscore_binding` → **pedantic, allow**; **`should_panic_without_expect` → pedantic, allow (added clippy 1.74.0)** — *not* restriction as the research dossier stated; `bool_assert_comparison` / `assertions_on_constants` → **style, warn**; `eq_op` / `approx_constant` → **correctness, deny**. The skill must **not** present `unwrap_used`/`expect_used`/`unwrap_in_result`/`should_panic_without_expect` as standard lints — they are allow-by-default and off unless explicitly enabled; `allow-unwrap-in-tests` defaults to `false`. Practical guidance is unchanged by the `should_panic_without_expect` correction: still recommend `expected=` as an improvement and flag bare `#[should_panic]` as a Critical false-pass on its own merits — not because a default lint fires.

---

## Sources

**Primary — The Rust Book** — [ch. 11.1 Writing Tests](https://doc.rust-lang.org/book/ch11-01-writing-tests.html) · [ch. 11.2 Running Tests](https://doc.rust-lang.org/book/ch11-02-running-tests.html) · [ch. 11.3 Test Organization](https://doc.rust-lang.org/book/ch11-03-test-organization.html)

**Primary — rustdoc / Reference / Cargo / Edition** — [rustdoc — documentation tests](https://doc.rust-lang.org/rustdoc/write-documentation/documentation-tests.html) · [Reference — Testing attributes](https://doc.rust-lang.org/reference/attributes/testing.html) · [Cargo Book — tests guide](https://doc.rust-lang.org/cargo/guide/tests.html) · [Cargo Book — cargo test](https://doc.rust-lang.org/cargo/commands/cargo-test.html) · [Cargo Book — Cargo targets (integration/`harness`/`[[bench]]`)](https://doc.rust-lang.org/cargo/reference/cargo-targets.html) · [Edition Guide — Rust 2024 newly unsafe functions](https://doc.rust-lang.org/edition-guide/rust-2024/newly-unsafe-functions.html) · [std env::set_var (Safety)](https://doc.rust-lang.org/std/env/fn.set_var.html) · [Unstable Book — `test` feature](https://doc.rust-lang.org/unstable-book/library-features/test.html) · [Rust Fuzz Book — cargo-fuzz](https://rust-fuzz.github.io/book/cargo-fuzz.html)

**Primary — Clippy (per-lint group/level verified)** — [Clippy lint index](https://rust-lang.github.io/rust-clippy/master/index.html) · [Clippy lint configuration (`allow-unwrap-in-tests` default `false`)](https://doc.rust-lang.org/clippy/lint_configuration.html). `should_panic_without_expect = pedantic` corrected against the rust-clippy `master` source (`clippy_lints/src/attrs/mod.rs`; added clippy 1.74.0), overriding the research dossier's "restriction" classification.

**Official crate documentation** — [proptest](https://docs.rs/proptest/latest/proptest/) ([book](https://altsysrq.github.io/proptest-book/), [Config](https://docs.rs/proptest/latest/proptest/test_runner/struct.Config.html)) · [quickcheck](https://docs.rs/quickcheck/latest/quickcheck/) · [rstest](https://docs.rs/rstest/latest/rstest/) · [insta](https://insta.rs/docs/) ([redactions](https://insta.rs/docs/redactions/)) · [criterion](https://docs.rs/criterion/latest/criterion/) · [mockall](https://docs.rs/mockall/latest/mockall/) · [serial_test](https://docs.rs/serial_test/latest/serial_test/) · [assert_cmd](https://docs.rs/assert_cmd/latest/assert_cmd/) · [predicates](https://docs.rs/predicates/latest/predicates/) · [tempfile](https://docs.rs/tempfile/latest/tempfile/) · [assert_fs](https://docs.rs/assert_fs/latest/assert_fs/) · [wiremock](https://docs.rs/wiremock/latest/wiremock/) · [cargo-nextest](https://nexte.st/docs/design/how-it-works/) · [cargo-llvm-cov](https://docs.rs/cargo-llvm-cov/latest/cargo_llvm_cov/) · [tokio::test](https://docs.rs/tokio/latest/tokio/attr.test.html) · [sqlx::test](https://docs.rs/sqlx/latest/sqlx/attr.test.html)

**Secondary** — none relied on for any behavioral claim; the parallel-execution model and `#[should_panic]` substring semantics are both anchored to the Book + Reference + Cargo Book quoted above.
