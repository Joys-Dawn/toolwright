# Rust Best Practices Audit — Reference

Rule/idiom, rationale, anti-pattern→idiomatic code, exact tooling, and primary-source citation for every dimension in `SKILL.md`. Sourced from the **Rust API Guidelines** (`C-*`), **The Rust Book/Reference/std/Edition Guide**, **Clippy**, and the semi-official **rust-unofficial/patterns** catalog.

**Two master switches govern every finding:**

- **Library vs binary** — `anyhow`/`Box<dyn Error>`, `unwrap` in `main`, `#[non_exhaustive]`, `pub` surface, C-STABLE, sealed traits flip severity (often Critical in a published library → non-issue in a binary/prototype/test).
- **Clippy group ≠ "must fix"** — `style`/`perf`/`complexity`/`correctness`/`suspicious`/`deprecated` are warn/deny by default; `pedantic`/`nursery`/`restriction`/`cargo` are **allow** (opt-in) and `restriction` lints contradict each other. Phrase opt-in lints as "consider enabling X", never "violates X".

> Every Clippy lint group/level below was re-verified against the canonical rust-clippy `master` source. The rendered Clippy index has known group/level errors (it mis-reports `ptr_arg`, `or_fun_call`, `redundant_clone`, etc.) — do not trust a single rendered fetch; re-verify against `rust-lang.github.io/rust-clippy/master/` or the rust-clippy source if regenerating this file.

---

## 1. Error Handling Design

### 1.1 Library typed errors; application `anyhow`/`eyre`

Libraries expose concrete typed errors (`thiserror`-derived enum implementing `std::error::Error`) so callers can `match` for recovery; applications use `anyhow`/`eyre` for ergonomic context. Nick Cameron's official error-docs qualifies it: use enums when "fine-grained recovery at some distance" is needed, trait objects when "there can be effectively no recovery … the intention is only to log."

**Anti → Idiomatic (library):**
```rust
// Anti: pub fn parse(s:&str) -> anyhow::Result<Config>
#[derive(Debug, thiserror::Error)]
#[non_exhaustive]
pub enum ParseError {
    #[error("missing field {0}")] Missing(&'static str),
    #[error(transparent)] Io(#[from] std::io::Error),
}
```
**Severity:** Critical for a published library returning `anyhow::Error`/`Box<dyn Error>` in its public API; in a binary `anyhow` is the *correct* idiom, not a smell.
**Tooling:** No Clippy lint (design judgment). `cargo doc` for the `# Errors` section. C-GOOD-ERR.
> — [API Guidelines: C-GOOD-ERR](https://rust-lang.github.io/api-guidelines/interoperability.html#error-types-are-meaningful-and-well-behaved-c-good-err) · [nrc error-docs: error type design](https://nrc.github.io/error-docs/error-design/error-type-design.html)

### 1.2 Error types implement `Error` + `Display` + `Debug`; never `()`/`String`

Any `E` in a public `Result<T, E>` must implement `std::error::Error` (so `Debug + Display`) and should be `Send + Sync + 'static`. `Result<T, String>`/`()` are unrecoverable for callers and break `?` composition. Error messages: "concise lowercase sentences without trailing punctuation."

**Anti → Idiomatic:** `fn load() -> Result<Data, String>` → `fn load() -> Result<Data, LoadError>` (`LoadError: Error + Display + Debug`).
**Severity:** Critical in a public library API; Warning internally.
**Tooling:** No single default lint. `Error::description()` is deprecated — do not implement it. C-GOOD-ERR.
> — [std::error::Error](https://doc.rust-lang.org/std/error/trait.Error.html) · [API Guidelines: C-GOOD-ERR](https://rust-lang.github.io/api-guidelines/interoperability.html#error-types-are-meaningful-and-well-behaved-c-good-err)

### 1.3 Preserve the source chain

Wrapping errors must expose the cause via `Error::source()` (or `thiserror` `#[source]`/`#[from]`/`#[error(transparent)]`). std rule: the underlying error is "either returned by the outer error's `Error::source()`, or rendered by the outer error's `Display` … but not both."

**Anti → Idiomatic:** `.map_err(|_| MyError::Io)` (cause discarded) → `#[error("read failed")] Io(#[from] std::io::Error)`.
**Severity:** Warning (debuggability loss).
**Tooling:** No default lint. `?` auto-calls `From::from`, so `#[from]` enables idiomatic propagation.
> — [std::error::Error](https://doc.rust-lang.org/std/error/trait.Error.html) · [Book ch.9.2](https://doc.rust-lang.org/book/ch09-02-recoverable-errors-with-result.html)

### 1.4 No `unwrap`/`expect`/`panic!` for recoverable conditions in library code

Book ch.9.3: reserve `panic!`/`unwrap`/`expect` for unrecoverable bugs/contract violations; return `Result` when "failure is expected." A library that panics on caller input removes the caller's ability to handle it.

**Anti → Idiomatic (lib):** `let v = parse(s).unwrap();` → `let v = parse(s)?;`
**Severity:** Critical in library code on caller-supplied input. **Explicitly sanctioned in tests/examples/prototypes** ("in tests, calling `unwrap`/`expect` is exactly what should happen") — never flag it there.
**Tooling:** `clippy::unwrap_used`, `expect_used`, `panic`, `indexing_slicing` — all **restriction, allow** (opt-in). Phrase as "consider enabling" only.
> — [Book: To panic! or Not to panic!](https://doc.rust-lang.org/book/ch09-03-to-panic-or-not-to-panic.html) · [Clippy index](https://rust-lang.github.io/rust-clippy/master/index.html)

### 1.5 `expect` message states the precondition

"expect-as-precondition": the message says *why the author believes it cannot fail* (`.expect("hardcoded IP address should be valid")`), not `.expect("failed to parse")`.
**Severity:** Suggestion. **Tooling:** No lint enforces message content; documented convention.
> — [Book: To panic! or Not to panic!](https://doc.rust-lang.org/book/ch09-03-to-panic-or-not-to-panic.html)

### 1.6 `#[non_exhaustive]` on public error enums

Error-docs: "you probably should mark all your enums as `#[non_exhaustive]` so that you can add variants backwards compatibly." Otherwise adding a variant breaks every downstream exhaustive `match`.

**Anti → Idiomatic:** `pub enum E { A, B }` → `#[non_exhaustive] pub enum E { A, B }`
**Severity:** Warning for a published library error enum; N/A for binary-internal enums.
**Tooling:** `clippy::manual_non_exhaustive` — **style, warn** (detects the old private-variant hack). `clippy::exhaustive_enums` — restriction, allow (the inverse).
> — [nrc error-docs](https://nrc.github.io/error-docs/error-design/error-type-design.html) · [Reference: type_system attributes](https://doc.rust-lang.org/reference/attributes/type_system.html)

### 1.7 No swallowed errors; `?` in `main`

Don't discard a `Result` with `let _ =`/`.ok()` unless intentional; `main` may return `Result<(), Box<dyn Error>>`.

**Anti → Idiomatic:** `fn main() { let _ = run(); }` → `fn main() -> Result<(), Box<dyn Error>> { run()?; Ok(()) }`
**Severity:** Warning (`let _ =` on a `Result` hides failures); Suggestion for the `?`-in-`main` style.
**Tooling:** `clippy::let_underscore_must_use` — **restriction, allow** (opt-in). `let_underscore_lock` — **correctness, deny** — but that is the concurrency-bug variant (dropping a lock guard); defer hard cases to `rust-correctness-audit`. C-QUESTION-MARK.
> — [Book ch.9.2](https://doc.rust-lang.org/book/ch09-02-recoverable-errors-with-result.html) · [API Guidelines: C-QUESTION-MARK](https://rust-lang.github.io/api-guidelines/documentation.html#examples-use--not-try-not-unwrap-c-question-mark)

---

## 2. Ownership & Borrowing Idioms

### 2.1 Borrowed parameter types: `&str`/`&[T]`/`&Path`

Patterns book: `&String` "creates two layers" of indirection and rejects `str` literals/slices that `&str` accepts. C-GENERIC: minimize assumptions.

**Anti → Idiomatic:** `fn f(s: &String)` → `fn f(s: &str)`; `fn g(v: &Vec<i32>)` → `fn g(v: &[i32])`
**Severity:** Warning (API ergonomics); Critical if a widely-called public API forces allocation at every call site.
**Tooling:** `clippy::ptr_arg` — **style, warn (default-on)**. C-GENERIC.
> — [patterns: coercion-arguments](https://rust-unofficial.github.io/patterns/idioms/coercion-arguments.html) · [API Guidelines: C-GENERIC](https://rust-lang.github.io/api-guidelines/flexibility.html#functions-minimize-assumptions-about-parameters-by-using-generics-c-generic)

### 2.2 `.clone()` to satisfy the borrow checker

Named anti-pattern: "If a clone is used to make a borrow checker error disappear, that's a good indication this anti-pattern may be in use." Hidden alloc; the two values silently desync. Book notes it is *acceptable* in prototypes/hackathons.

**Anti → Idiomatic:** `let y = &mut x.clone();` → restructure scope, or `mem::take`/`replace` to move the owned value out.
**Severity:** Warning (perf + correctness-of-intent smell); Suggestion in a prototype.
**Tooling:** `clippy::clone_on_copy` — **complexity, warn (default-on)** (cloning a `Copy` type). `redundant_clone` — **nursery, allow** (opt-in). `implicit_clone` — pedantic, allow.
> — [patterns: borrow_clone](https://rust-unofficial.github.io/patterns/anti_patterns/borrow_clone.html)

### 2.3 `mem::take`/`mem::replace` instead of clone

Named idiom: move an owned value out of a borrowed struct/enum without cloning (`mem::take` leaves an allocation-free `Default`).

**Anti → Idiomatic:** `*e = B { name: name.clone() }` → `*e = B { name: mem::take(name) }`
**Severity:** Suggestion → Warning where the clone is in a hot path.
**Tooling:** No default lint suggests it; `redundant_clone` (nursery, allow) sometimes catches the inverse.
> — [patterns: mem-replace](https://rust-unofficial.github.io/patterns/idioms/mem-replace.html)

### 2.4 Caller controls placement; `Cow<'_, str>`

C-CALLER-CONTROL: "If a function requires ownership … take ownership … rather than borrowing and cloning." `Cow` when usually-borrowed-sometimes-owned. "`Copy` … should only be used as a bound when absolutely needed."

**Anti → Idiomatic:** `fn f(s: &str) -> String { s.to_owned() }` (always allocates) → `fn f(s: &str) -> Cow<'_, str>` when often unchanged.
**Severity:** Warning (ergonomics/perf); context-dependent.
**Tooling:** `clippy::needless_pass_by_value`, `trivially_copy_pass_by_ref` — **pedantic, allow** (opt-in). C-CALLER-CONTROL.
> — [API Guidelines: C-CALLER-CONTROL](https://rust-lang.github.io/api-guidelines/flexibility.html#caller-decides-where-to-copy-and-place-data-c-caller-control)

### 2.5 Needless lifetime annotations

Use elision; don't write `fn f<'a>(x: &'a T) -> &'a T` when elision infers it.
**Anti → Idiomatic:** `fn first<'a>(s: &'a str) -> &'a str` → `fn first(s: &str) -> &str`
**Severity:** Suggestion. **Tooling:** `clippy::needless_lifetimes` — **complexity, warn (default-on)**.
> — [Reference: lifetime elision](https://doc.rust-lang.org/reference/lifetime-elision.html)

### 2.6 `Rc<RefCell<T>>`/`Arc<Mutex<T>>` as a default

Reaching for it to model a graph/shared state instead of restructuring to single ownership / arena + indices. Trades compile-time guarantees for runtime panics.
**Severity:** Warning when used as the *default* without justification; context-dependent (genuinely shared cyclic ownership is legitimate).
**Tooling:** No Clippy lint (design). The runtime-panic facet of `RefCell` misuse is `rust-correctness-audit`'s.
> — [std RefCell](https://doc.rust-lang.org/std/cell/struct.RefCell.html) · [patterns: borrow_clone](https://rust-unofficial.github.io/patterns/anti_patterns/borrow_clone.html)

---

## 3. Trait & Type Design (API Guidelines)

### 3.1 Eagerly implement common traits (C-COMMON-TRAITS)

"Crates that define new types should eagerly implement all applicable, common traits" — `Copy, Clone, Eq, PartialEq, Ord, PartialOrd, Hash, Debug, Display, Default`. The orphan rule means downstream cannot add them later.

**Anti → Idiomatic:** `pub struct Id(u64);` → `#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)] pub struct Id(u64);`
**Severity:** Warning generally; Critical for missing `Debug` on a public type (C-DEBUG: "All public types implement `Debug`").
**Tooling:** `missing_debug_implementations` is a **rustc** lint (allow, opt-in). `clippy::derive_partial_eq_without_eq` — **nursery, allow**. C-COMMON-TRAITS, C-DEBUG.
> — [API Guidelines: C-COMMON-TRAITS](https://rust-lang.github.io/api-guidelines/interoperability.html#types-eagerly-implement-common-traits-c-common-traits) · [API Guidelines: debuggability](https://rust-lang.github.io/api-guidelines/debuggability.html)

### 3.2 Conversion traits: `From`/`TryFrom`/`FromStr`/`AsRef`, never `Into`/`TryInto`

C-CONV-TRAITS: implement `From`, `TryFrom`, `AsRef`, `AsMut`; never `Into`/`TryInto` (blanket impl from `From`). `From` is infallible — fallible conversions use `TryFrom`; conversions must not panic.

**Anti → Idiomatic:** `fn from_str_or_panic(s:&str)->Foo` → `impl FromStr for Foo { type Err = FooErr; … }`
**Severity:** Warning; Critical if a panicking `From`/`as` is on a public boundary.
**Tooling:** `clippy::useless_conversion` — **complexity, warn (default-on)**. C-CONV-TRAITS, C-CONV-SPECIFIC.
> — [API Guidelines: C-CONV-TRAITS](https://rust-lang.github.io/api-guidelines/interoperability.html#conversions-use-the-standard-traits-from-asref-asmut-c-conv-traits)

### 3.3 Newtype pattern (C-NEWTYPE, C-CUSTOM-TYPE)

"Newtypes provide static distinctions" (`Miles(f64)` vs `Kilometers`); "Arguments convey meaning through types, not `bool` or `Option`." Primitive obsession lets `f64`/`bool` flow into the wrong slot.

**Anti → Idiomatic:** `Widget::new(true, false)` → `Widget::new(Small, Round)`; `fn pay(cents: u64)` → `fn pay(amount: Money)`
**Severity:** Warning; Critical when distinct units/IDs share a primitive in a public API.
**Tooling:** No direct lint (design). `clippy::struct_excessive_bools`, `fn_params_excessive_bools` — **pedantic, allow** (bool-obsession proxy). C-NEWTYPE, C-CUSTOM-TYPE.
> — [API Guidelines: type-safety](https://rust-lang.github.io/api-guidelines/type-safety.html)

### 3.4 Static vs dynamic dispatch (C-GENERIC vs C-OBJECT)

Generics → monomorphization, code-size bloat, inline layout; trait objects → heterogeneity, smaller code, vtable indirection, "No `Self`". Decide object-safety upfront (`where Self: Sized` to exclude generic methods from the vtable).

**Anti → Idiomatic:** `Vec<Box<dyn Fn()>>` is right for heterogeneity; `fn map<F: Fn(i32)->i32>(f: F)` is right for a single monomorphizable call.
**Severity:** Warning (perf/ergonomics tradeoff); Suggestion when both are reasonable.
**Tooling:** No lint enforces the choice. C-GENERIC, C-OBJECT.
> — [API Guidelines: C-OBJECT](https://rust-lang.github.io/api-guidelines/flexibility.html#traits-are-object-safe-if-they-may-be-useful-as-a-trait-object-c-object)

### 3.5 Sealed trait pattern (C-SEALED)

For traits not meant to be implemented downstream, add a private `Sealed` supertrait. Without sealing, adding a method is a breaking change for all downstream impls.

**Anti → Idiomatic:** `pub trait T { fn a(&self); }` → `pub trait T: private::Sealed { fn a(&self); }`
**Severity:** Warning for a public extension-point trait that should be sealed; context-dependent (intentionally-open traits must NOT be sealed).
**Tooling:** No lint. C-SEALED.
> — [API Guidelines: C-SEALED](https://rust-lang.github.io/api-guidelines/future-proofing.html#sealed-traits-protect-against-downstream-implementations-c-sealed)

### 3.6 `Deref` only for smart pointers (C-DEREF) — "Deref polymorphism"

C-DEREF: "Only smart pointers implement `Deref` and `DerefMut`." Misusing `Deref` to fake inheritance is "a surprising idiom … the mechanism here is completely implicit … interacts badly with bounds checking." It does not create subtyping.

**Anti → Idiomatic:** `impl Deref for Bar { type Target = Foo; … }` for method reuse → composition + explicit delegation, or a shared trait.
**Severity:** Critical (silent surprising method resolution; breaks generics) when used for inheritance emulation on a public type.
**Tooling:** No lint detects intent. C-DEREF, C-SMART-PTR.
> — [patterns: deref](https://rust-unofficial.github.io/patterns/anti_patterns/deref.html) · [API Guidelines: C-DEREF](https://rust-lang.github.io/api-guidelines/predictability.html#only-smart-pointers-implement-deref-and-derefmut-c-deref)

### 3.7 `#[must_use]` on builders / `Result`-like / pure-query types

`#[must_use]` "issue[s] a diagnostic warning when a value is not used." Idiomatic on builders and pure functions whose result is the only effect.

**Anti → Idiomatic:** `pub fn validate(&self) -> bool` → `#[must_use] pub fn validate(&self) -> bool`
**Severity:** Suggestion → Warning for a builder/`Result`-like public API lacking it.
**Tooling:** `clippy::must_use_candidate`, `return_self_not_must_use` — **pedantic, allow** (opt-in). rustc `unused_must_use` (warn) fires *on* `#[must_use]` types.
> — [Reference: must_use](https://doc.rust-lang.org/reference/attributes/diagnostics.html#the-must_use-attribute)

### 3.8 Unsurprising operator overloads (C-OVERLOAD); `Default`

Implement `Mul` only for multiplication-like ops, etc. Implement `Default` where a sensible empty exists; "common … for types to implement both `Default` and an empty `new`."

**Anti → Idiomatic:** element-wise `impl Add for Matrix` where `*` is expected matrix-mul → match math convention; `Foo::empty()` → `impl Default for Foo`.
**Severity:** Warning (C-OVERLOAD logic-bug risk); Suggestion for missing `Default`.
**Tooling:** `clippy::should_implement_trait` — **style, warn (default-on)**; `new_without_default` — **style, warn (default-on)**.
> — [API Guidelines: C-OVERLOAD](https://rust-lang.github.io/api-guidelines/predictability.html#operator-overloads-are-unsurprising-c-overload)

---

## 4. API Conventions (C-*)

### 4.1 Naming (C-CASE, C-GETTER, C-CONV, C-ITER, C-WORD-ORDER)

C-CASE: `UpperCamelCase` types, `snake_case` fns, `SCREAMING_SNAKE_CASE` consts; acronyms = one word (`Uuid` not `UUID`). C-GETTER: `fn first()` not `fn get_first()`. C-CONV: `as_` (free), `to_` (expensive), `into_` (consuming). C-ITER: `iter`/`iter_mut`/`into_iter`.

**Anti → Idiomatic:** `fn get_name(&self) -> &str` → `fn name(&self) -> &str`; `fn as_string(&self) -> String` (allocates) → `fn to_string()`.
**Severity:** Warning (C-GETTER/C-CONV cost-mislabeling misleads perf decisions); Suggestion for pure casing in non-public code.
**Tooling:** rustc `non_camel_case_types`/`non_snake_case`/`non_upper_case_globals` (default warn). `clippy::wrong_self_convention` — **style, warn (default-on)**; `enum_variant_names` — **style, warn (default-on)**.
> — [API Guidelines: naming](https://rust-lang.github.io/api-guidelines/naming.html)

### 4.2 Constructors (C-CTOR); builders (C-BUILDER)

Constructors are static inherent methods; `new` primary, `with_*`/`from_*` secondary; if `Default` exists it must match `new`. Many-arg/optional construction → a builder.

**Anti → Idiomatic:** `Server::new(addr, true, 30, None, false)` → `Server::builder().addr(addr).tls(true).timeout(30).build()`
**Severity:** Warning for a public type with a 5+-arg or many-`Option` constructor; Suggestion otherwise.
**Tooling:** `clippy::new_without_default` — **style, warn (default-on)**. `fn_params_excessive_bools`/`struct_excessive_bools` — pedantic, allow. C-CTOR, C-BUILDER.
> — [API Guidelines: C-CTOR](https://rust-lang.github.io/api-guidelines/predictability.html#constructors-are-static-inherent-methods-c-ctor) · [C-BUILDER](https://rust-lang.github.io/api-guidelines/type-safety.html#builders-enable-construction-of-complex-values-c-builder)

### 4.3 Private fields & future-proofing (C-STRUCT-PRIVATE, C-STRUCT-BOUNDS, C-NO-OUT)

"Making a field public is a strong commitment … prevents the type from maintaining any invariants." Don't duplicate derivable bounds on the struct. Return tuples/structs, don't take `&mut out` params.

**Anti → Idiomatic:** `pub struct Range { pub lo: u32, pub hi: u32 }` (invariant `lo≤hi` unenforceable) → private fields + validated constructor + getters.
**Severity:** Critical for `pub` fields where an invariant must hold; Warning for C-STRUCT-BOUNDS/C-NO-OUT.
**Tooling:** No direct default lint (design). C-STRUCT-PRIVATE, C-STRUCT-BOUNDS, C-NO-OUT, C-VALIDATE.
> — [API Guidelines: future-proofing](https://rust-lang.github.io/api-guidelines/future-proofing.html) · [C-NO-OUT](https://rust-lang.github.io/api-guidelines/predictability.html#functions-do-not-take-out-parameters-c-no-out)

### 4.4 `#[non_exhaustive]` on growable public types; stable public deps (C-STABLE)

`#[non_exhaustive]` on public structs/enums whose shape may grow. C-STABLE: "A crate cannot be stable (>=1.0.0) without all of its public dependencies being stable" — including types leaking via `From` impls.

**Anti → Idiomatic:** `pub struct Config { pub a: u8 }` → `#[non_exhaustive] pub struct Config { pub a: u8 }`; keep dep types out of public signatures or wrap them.
**Severity:** Warning (semver hazard) for libraries; N/A for binaries.
**Tooling:** `clippy::exhaustive_structs`/`exhaustive_enums` — restriction, allow (opt-in). C-STABLE.
> — [Reference: type_system attributes](https://doc.rust-lang.org/reference/attributes/type_system.html) · [API Guidelines: C-STABLE](https://rust-lang.github.io/api-guidelines/necessities.html#public-dependencies-of-a-stable-crate-are-stable-c-stable)

### 4.5 Doc conventions (C-EXAMPLE, C-FAILURE, C-QUESTION-MARK, C-LINK)

Every public item has a rustdoc example using `?` (not `unwrap`); document errors under `# Errors`, panics under `# Panics`, `unsafe` invariants under `# Safety`. `Cargo.toml` has `description`/`license`/`repository`/`keywords`/`categories` (C-METADATA).

**Anti → Idiomatic:** a public `fn divide(a,b)` that panics on `b==0` with no `# Panics` → add a `# Panics` section.
**Severity:** Warning for a public library missing `# Panics`/`# Errors`/`# Safety`; Suggestion for missing examples.
**Tooling:** `clippy::missing_safety_doc` — **style, warn (default-on)** (`unsafe` fn without `# Safety`). `missing_errors_doc`/`missing_panics_doc` — **pedantic, allow** (opt-in). `rustdoc::broken_intra_doc_links` for C-LINK.
> — [API Guidelines: documentation](https://rust-lang.github.io/api-guidelines/documentation.html)

### 4.6 Module organization & visibility minimization

C-HIDDEN: "Rustdoc … nothing more"; use `pub(crate)`/`#[doc(hidden)]`; flatten public API with `pub use`; don't leak private types in public signatures.

**Anti → Idiomatic:** `pub mod internal;` everywhere → `pub(crate) mod internal;` + `pub use crate::internal::PublicThing;`
**Severity:** Warning (semver surface + usability); Critical if a private type appears in a public fn signature.
**Tooling:** `clippy::module_name_repetitions` — **restriction, allow** (opt-in; `foo::FooError`). rustc `unreachable_pub` (allow, opt-in); `private_interfaces`/`private_bounds` (**default warn**) catch leaked private types.
> — [API Guidelines: C-HIDDEN](https://rust-lang.github.io/api-guidelines/documentation.html#rustdoc-does-not-show-unhelpful-implementation-details-c-hidden)

---

## 5. Idiomatic Constructs & Clippy style/complexity

### 5.1 Iterators/adaptors over manual index loops

`for x in &v` / adaptors over `for i in 0..v.len() { v[i] }` — index loops reintroduce bounds checks and off-by-one bugs.
**Anti → Idiomatic:** `for i in 0..v.len() { sum += v[i]; }` → `let sum: i32 = v.iter().sum();`
**Severity:** Warning (readability + bounds-check elision); Suggestion in trivial cases.
**Tooling:** `clippy::needless_range_loop` — **style, warn (default-on)**. `explicit_iter_loop` — pedantic, allow.
> — [Clippy index](https://rust-lang.github.io/rust-clippy/master/index.html)

### 5.2 `if let`/`let else`/`matches!`/combinators over verbose `match`

Reduces `match { Some(x)=>x, None=>return }` boilerplate. **Genuinely contested:** heavy combinator chaining is idiomatic to some, opaque to others — flag only egregious cases, present both views.
**Anti → Idiomatic:** `match opt { Some(x) => x, None => return }` → `let Some(x) = opt else { return };` (Rust 1.65+)
**Severity:** Suggestion (style); the combinator-vs-`match` choice is contested.
**Tooling:** `single_match`, `match_like_matches_macro`, `redundant_pattern_matching`, `manual_map`/`manual_filter`/`manual_unwrap_or` — **style/complexity, warn (default-on)**. `manual_let_else`, `map_unwrap_or` — **pedantic, allow** (opt-in; needs 1.65+). `option_if_let_else` — **nursery, allow** (the combinator-favoring lint, itself contested).
> — [Clippy index](https://rust-lang.github.io/rust-clippy/master/index.html) · [let-else (1.65)](https://doc.rust-lang.org/rust-by-example/flow_control/let_else.html) · [RFC 2795 inline format args (1.58)](https://rust-lang.github.io/rfcs/2795-format-args-implicit-identifiers.html)

### 5.3 `.is_empty()`; inline format args; `derive` over hand-impl

`.is_empty()` over `.len() == 0`; `format!("{x}")` over `format!("{}", x)` (Rust 1.58+); `#[derive]` over hand-written trivial impls.
**Severity:** Suggestion.
**Tooling:** `clippy::len_zero`, `redundant_field_names` — **style, warn (default-on)**. `uninlined_format_args` — **pedantic, allow** (opt-in; "consider enabling"; also version-sensitive — requires 1.58+/edition). `expl_impl_clone_on_copy` — pedantic, allow.
> — [Clippy index](https://rust-lang.github.io/rust-clippy/master/index.html)

### 5.4 No needless `return`/`&`/`clone`/`collect`

Tail `return` is noise; needless borrows/clones obscure ownership and may allocate.
**Anti → Idiomatic:** `fn f() -> i32 { return 1; }` → `fn f() -> i32 { 1 }`; `let v: Vec<_> = it.collect(); for x in v {}` → `for x in it {}`
**Severity:** Suggestion; Warning if the needless `collect`/`clone` is in a hot path.
**Tooling:** `needless_return`, `needless_borrow`, `let_and_return` — **style, warn (default-on)**. `needless_collect`, `redundant_clone` — **nursery, allow** (opt-in).
> — [Clippy index](https://rust-lang.github.io/rust-clippy/master/index.html)

### 5.5 `entry` API for maps; pedantic/nursery noise

`HashMap::entry().or_insert_with()` instead of `contains_key` + `insert` (double lookup). Clippy docs: `pedantic` "you can expect to sprinkle multiple `#[allow(..)]`"; `nursery` "cherry-pick"; `restriction` lints "will even contradict other lints" — never blanket-enable.
**Anti → Idiomatic:** `if !m.contains_key(&k) { m.insert(k, v); }` → `m.entry(k).or_insert(v);`
**Severity:** Suggestion → Warning (the entry double-lookup is a perf smell). Meta-rule: label `pedantic`/`nursery`/`restriction` findings as opt-in, not violations.
**Tooling:** `clippy::map_entry` — **perf, warn (default-on)**.
> — [Clippy index](https://rust-lang.github.io/rust-clippy/master/index.html) · [Clippy: lint groups](https://doc.rust-lang.org/clippy/lints.html) · [Clippy: usage](https://doc.rust-lang.org/clippy/usage.html)

---

## 6. Performance Best-Practices

### 6.1 Avoidable heap allocation

Don't `Box` a collection (`Box<Vec<T>>`), `Vec<Box<T>>` when `Vec<T>` works, `Rc<Box<T>>`/`&Box<T>`; don't build a `String` with `+` in a loop.
**Anti → Idiomatic:** `fn f(v: Box<Vec<u8>>)` → `fn f(v: Vec<u8>)`; `s = s + w;` in a loop → `s.push_str(w);`
**Severity:** Warning (perf); Critical only on a documented hot path with measured impact.
**Tooling:** `clippy::box_collection` — **perf, warn (default-on)**; `redundant_allocation`, `boxed_local` — **perf, warn (default-on)**; `vec_box` — **complexity, warn (default-on)**; `useless_format` — **complexity, warn (default-on)**; `format_in_format_args` — **perf, warn (default-on)**.
> — [Clippy index](https://rust-lang.github.io/rust-clippy/master/index.html)

### 6.2 Preallocate when size known

std: "use `Vec::with_capacity` whenever possible"; `push`/`insert` "*will* (re)allocate if `len == capacity`."
**Anti → Idiomatic:** `let mut v = Vec::new(); for i in 0..n { v.push(i); }` → `Vec::with_capacity(n)`
**Severity:** Suggestion → Warning when `n` is known and the collection is large/hot.
**Tooling:** `clippy::slow_vector_initialization` — **perf, warn (default-on)**. No default lint forces `with_capacity` generally.
> — [std Vec capacity & reallocation](https://doc.rust-lang.org/std/vec/struct.Vec.html#capacity-and-reallocation)

### 6.3 Avoid intermediate `collect()`; lazy eval; needless `to_owned`/`to_string`

Don't `collect()` then iterate; use the `_else`/`_default` lazy form for `unwrap_or`/`or`/`ok_or`; don't `.to_owned()`/`.to_string()` then borrow again.
**Anti → Idiomatic:** `opt.unwrap_or(expensive())` → `opt.unwrap_or_else(expensive)`; `s.to_string().len()` → `s.len()`
**Severity:** Warning (perf); context-dependent.
**Tooling:** `clippy::unnecessary_to_owned` — **perf, warn (default-on)**. `or_fun_call`, `needless_collect`, `redundant_clone` — **nursery, allow** (opt-in). `inefficient_to_string` — **pedantic, allow**.
> — [Clippy index](https://rust-lang.github.io/rust-clippy/master/index.html)

### 6.4 Dispatch & monomorphization bloat; `#[inline]` cargo-culting

Generics → code-size duplication; `Box<dyn>` → vtable cost. `#[inline]` is a cross-crate hint that increases compile time/code size; within a crate the compiler already inlines. **Contested/heuristic — present as judgment, not a rule.**
**Severity:** Suggestion (contested).
**Tooling:** No lint endorses/forbids `#[inline]` placement. `clippy::missing_inline_in_public_items` — restriction, allow (itself debated). C-GENERIC.
> — [API Guidelines: C-GENERIC](https://rust-lang.github.io/api-guidelines/flexibility.html#functions-minimize-assumptions-about-parameters-by-using-generics-c-generic) · [secondary: Nethercote](https://nnethercote.github.io/2021/12/08/a-brutally-effective-hash-function-in-rust.html)

### 6.5 `HashMap` SipHash vs FxHash/aHash

std: "default … SipHash 1-3 … other hashing algorithms will outperform it for small keys … those algorithms will typically not protect against … HashDoS." **Contested/important caveat:** FxHash "should never be used as a default" (collision pathologies on low-entropy keys); aHash is DoS-resistant *and* faster. Only swap when keys are trusted *or* the hasher is DoS-resistant. Untrusted-input DoS analysis is `rust-security-audit`'s.
**Anti → Idiomatic:** `HashMap<u32, V>` in a hot internal cache → `HashMap<u32, V, FxBuildHasher>` (trusted keys) or aHash.
**Severity:** Suggestion → Warning on a measured hot internal map. Never apply to untrusted-key maps without a DoS-resistant hasher.
**Tooling:** No Clippy lint. std documents `with_hasher`.
> — [std HashMap default hasher](https://doc.rust-lang.org/std/collections/hash_map/struct.HashMap.html) · [secondary: aHash comparison](https://github.com/tkaitchuck/aHash/blob/master/compare/readme.md)

### 6.6 Expensive statics: `OnceLock`/`LazyLock`

`OnceLock` is "a thread-safe `OnceCell` … can be used in statics"; `LazyLock` for the simple deref. **Version-pinned:** `OnceLock` 1.70, `LazyLock` 1.80 — below those use `once_cell`/`lazy_static`.
**Anti → Idiomatic:** `fn re() -> Regex { Regex::new(PAT).unwrap() }` per call → `static RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(PAT).unwrap());`
**Severity:** Warning when an expensive value is rebuilt per call in a hot path; Suggestion otherwise.
**Tooling:** No default lint. Version-gate the suggestion against MSRV.
> — [std OnceLock](https://doc.rust-lang.org/std/sync/struct.OnceLock.html)

### 6.7 Small-buffer optimization (`SmallVec`/`arrayvec`)

Stack/inline buffer for usually-tiny hot collections. **UNVERIFIED by any primary Rust-project source — present as an evidence-gated, context-dependent optimization, not a rule.** Speculative use is itself the over-engineering anti-pattern (Dim 8).
**Severity:** Suggestion (must be evidence-backed).
**Tooling:** No lint (third-party crate; design judgment).
> — secondary/community crate docs only; **flagged unverified.**

---

## 7. Module, Crate & Project Structure

### 7.1 `lib.rs`/`main.rs` split

Book: keep `main.rs` a thin shell calling into the library crate; logic in `main.rs` is not testable/reusable.
**Anti → Idiomatic:** all logic in `main.rs` → `lib.rs` exports the API; `fn main() -> Result<(),E> { mycrate::run(args)?; Ok(()) }`
**Severity:** Warning for a non-trivial binary with all logic in `main.rs`; Suggestion for tiny tools.
**Tooling:** No lint. Book convention.
> — [Book ch.7.1: packages and crates](https://doc.rust-lang.org/book/ch07-01-packages-and-crates.html)

### 7.2 Module tree; visibility minimization

Edition 2018+ allows `foo.rs` + `foo/` or `foo/mod.rs` — both valid; **contested style — do not flag either.** Minimize visibility: `pub(crate)` over `pub` for non-API; don't leak private types.
**Severity:** Warning (semver/encapsulation) for leaked-private-type/over-`pub` in a library; do **not** flag `mod.rs`-vs-path.
**Tooling:** rustc `unreachable_pub` (allow, opt-in); `private_interfaces`/`private_bounds` (**default warn**). No Clippy default for `mod.rs` style (non-issue).
> — [Edition Guide: 2018 path changes](https://doc.rust-lang.org/edition-guide/rust-2018/path-changes.html) · [API Guidelines: C-HIDDEN](https://rust-lang.github.io/api-guidelines/documentation.html#rustdoc-does-not-show-unhelpful-implementation-details-c-hidden)

### 7.3 `#![warn(...)]` not `#![deny(warnings)]` in source

Named anti-pattern: `#![deny(warnings)]` "opts out of Rust's famed stability" — a new rustc lint breaks every published-crate build. Use `RUSTFLAGS="-D warnings"` in CI. `#![forbid(unsafe_code)]` where safe-only is fine.
**Anti → Idiomatic:** `#![deny(warnings)]` in `lib.rs` → CI `RUSTFLAGS="-D warnings"`.
**Severity:** Warning for `#![deny(warnings)]` in a published crate's source; Suggestion in a binary/CI-pinned context.
**Tooling:** No lint (named anti-pattern only). `clippy.toml` for per-crate config.
> — [patterns: deny-warnings](https://rust-unofficial.github.io/patterns/anti_patterns/deny-warnings.html)

### 7.4 Additive feature flags; edition currency

C-FEATURE: features must be additive; "a feature named negatively like `no-abc` is practically never correct." Edition idiom shifts are version-pinned (array `IntoIterator` by value / disjoint closure captures / `panic!` consistency = 2021; RPIT `use<>` + `if let` temporary scope = 2024 / Rust 1.85).
**Anti → Idiomatic:** `[features] no-std = []` → `[features] std = []` with `default = ["std"]`.
**Severity:** Warning for non-additive features in a library (unification breakage); Suggestion for edition currency.
**Tooling:** No lint for additivity. `cargo fix --edition` + `rust-202x-compatibility` lint groups for migration. C-FEATURE.
> — [API Guidelines: C-FEATURE](https://rust-lang.github.io/api-guidelines/naming.html#feature-names-are-free-of-placeholder-words-c-feature) · [Edition Guide: 2024 RPIT lifetime capture](https://doc.rust-lang.org/edition-guide/rust-2024/rpit-lifetime-capture.html) · [Rust 1.85 / Edition 2024](https://blog.rust-lang.org/2025/02/20/Rust-1.85.0/)

---

## 8. Common Named Anti-Patterns

| # | Anti-pattern | Idiomatic alternative | Severity | Source / lint |
|---|---|---|---|---|
| 1 | Clone to satisfy the borrow checker | Restructure scope; `mem::take`/`replace` | Warning (Suggestion in prototype) | patterns: borrow_clone |
| 2 | Deref polymorphism (`impl Deref` to fake inheritance) | Composition + delegation, or a trait | **Critical** (silent surprising resolution) | patterns: deref ; C-DEREF |
| 3 | `#[deny(warnings)]` in source | `RUSTFLAGS="-D warnings"` in CI | Warning (library build-stability) | patterns: deny-warnings |
| 4 | Stringly-typed errors (`Result<T, String>`) / `()` error | Typed enum impl `Error`+`Display` | **Critical** in public API | C-GOOD-ERR |
| 5 | `unwrap()`/`expect()` everywhere in lib code | `?` + typed errors | Critical on caller input (non-issue in tests/prototypes) | Book ch.9.3 ; `unwrap_used` (restriction, allow) |
| 6 | `&Vec<T>`/`&String`/`&PathBuf` params | `&[T]`/`&str`/`&Path` | Warning (Critical if hot public API) | `clippy::ptr_arg` (style, **warn**) |
| 7 | `bool`/positional-`Option` params (primitive obsession) | enums / newtypes / builder | Warning (Critical for bug-prone units) | C-CUSTOM-TYPE, C-NEWTYPE |
| 8 | `as` casts instead of `TryFrom` | `TryFrom` / checked conversion | Warning (correctness-of-intent) | `as_conversions` (restriction, allow); `cast_possible_truncation` (pedantic, allow) |
| 9 | `match` boilerplate instead of combinators / `if let` | combinators / `if let` / `let else` (don't over-chain) | Suggestion (contested) | `clippy::single_match` (style, **warn**) |
| 10 | `pub` everything / god module | `pub(crate)`; split; `pub use` facade | Warning (Critical if private type leaks into public sig) | C-HIDDEN |
| 11 | Over-generic single-impl trait (speculative generality / YAGNI) | Concrete type until a second impl exists | Warning (maintainability) | YAGNI (general principle) |
| 12 | Blanket `#[allow(...)]` suppression | Targeted `#[allow]` + justification at the site | Warning (hides real issues) | Clippy usage docs |
| 13 | Re-inventing std (`Iterator`/`From`/`Default` by hand) | `#[derive]` / impl the std trait | Suggestion → Warning | C-COMMON-TRAITS |
| 14 | `Box<dyn Error>` from a library's public API | Typed `thiserror` enum (or document the choice) | Warning → Critical for a published library | nrc error-docs |
| 15 | Mutex-guarding a single `Copy` field instead of an atomic | `AtomicUsize`/`AtomicBool` etc. | Warning (perf/contention) | `clippy::mutex_atomic` (restriction, allow) |
| 16 | `Box<Vec<T>>`/`Vec<Box<T>>`/`Rc<Box<T>>` (redundant alloc) | `Vec<T>`/`Vec<T>`/`Rc<T>` | Warning (perf) | `box_collection`/`redundant_allocation` (perf, **warn**), `vec_box` (complexity, **warn**) |
| 17 | `mem::uninitialized` (deprecated 1.39/unsound) | `MaybeUninit` (UB facet → security skill) / `Default` | **Critical** | std docs (deprecated) |
| 18 | `Rc<RefCell<T>>` graph soup as default | Restructure ownership / arena + indices | Warning (compile→runtime safety trade) | std `RefCell` docs |

> Items 5, 8, 9, 12, 15 map to **opt-in** lints — phrase as "consider enabling X" or rely on the named-anti-pattern rationale, never assert a default-lint violation. Items 6, 16 map to **default-on** lints and may be asserted directly. The `unsafe`/UB facets of items 2, 17, 18 are owned by the security/correctness skills — flag only the *design* facet here.

---

## Cross-Cutting Guidance

- **Library vs binary is the master context switch.** `anyhow`/`Box<dyn Error>`, `unwrap` in `main`, missing `#[non_exhaustive]`, `pub` surface, C-STABLE, sealed traits, semver hazards all flip severity (often Critical→non-issue) between a published crate and a binary/prototype. Always condition findings on which is being reviewed; never flag `unwrap`/`expect` in tests/examples/prototypes.
- **Clippy group ≠ "must fix".** Only `style`, `perf`, `complexity`, `correctness`, `suspicious`, `deprecated` are warn/deny by default. `pedantic`, `nursery`, `restriction`, `cargo` are **allow** (opt-in) and `restriction` lints can contradict each other — present as "consider enabling, with this rationale," never as violations.
- **Genuinely contested (present both sides, don't assert):** combinator-chaining vs `match` (5.2); `#[inline]` placement (6.4); `mod.rs` vs path-as-file (7.2 — do not flag either); FxHash vs aHash vs default SipHash (6.5, untrusted-key DoS is the security skill's).
- **Version-pinned idioms — gate on MSRV/edition:** inline format args (1.58), `let else` (1.65), `OnceLock` (1.70), `LazyLock` (1.80); array `IntoIterator`/disjoint closure captures/`panic!` consistency (edition 2021); RPIT `use<>` + `if let` temporary scope (edition 2024 / Rust 1.85).
- **Unverified item flagged honestly:** 6.7 (SmallVec/arrayvec SBO) has no primary Rust-project source — evidence-gated optimization, not a rule.
- **Clippy data caveat (methodology):** the rendered Clippy index returned several wrong group/level values (e.g. `ptr_arg`=pedantic/allow when it is `style`/warn; `or_fun_call`=perf/warn when it is `nursery`/allow; `redundant_clone`=perf/warn when it is `nursery`/allow). Every group/level here was re-verified against the canonical rust-clippy `master` source. Any regeneration must re-verify, not trust a single rendered fetch.

---

## Sources

**Rust API Guidelines (the C-* spine)** — [checklist (all IDs)](https://rust-lang.github.io/api-guidelines/checklist.html) · [naming](https://rust-lang.github.io/api-guidelines/naming.html) · [interoperability](https://rust-lang.github.io/api-guidelines/interoperability.html) · [type-safety](https://rust-lang.github.io/api-guidelines/type-safety.html) · [predictability](https://rust-lang.github.io/api-guidelines/predictability.html) · [flexibility](https://rust-lang.github.io/api-guidelines/flexibility.html) · [future-proofing](https://rust-lang.github.io/api-guidelines/future-proofing.html) · [dependability](https://rust-lang.github.io/api-guidelines/dependability.html) · [debuggability](https://rust-lang.github.io/api-guidelines/debuggability.html) · [documentation](https://rust-lang.github.io/api-guidelines/documentation.html) · [necessities](https://rust-lang.github.io/api-guidelines/necessities.html)

**The Rust Book / Reference / std / Edition Guide** — [error handling (ch.9.0)](https://doc.rust-lang.org/book/ch09-00-error-handling.html) · [recoverable errors & `?` (ch.9.2)](https://doc.rust-lang.org/book/ch09-02-recoverable-errors-with-result.html) · [to panic or not (ch.9.3)](https://doc.rust-lang.org/book/ch09-03-to-panic-or-not-to-panic.html) · [packages and crates (ch.7.1)](https://doc.rust-lang.org/book/ch07-01-packages-and-crates.html) · [std::error::Error](https://doc.rust-lang.org/std/error/trait.Error.html) · [`#[must_use]`](https://doc.rust-lang.org/reference/attributes/diagnostics.html#the-must_use-attribute) · [`#[non_exhaustive]`](https://doc.rust-lang.org/reference/attributes/type_system.html) · [Vec capacity](https://doc.rust-lang.org/std/vec/struct.Vec.html#capacity-and-reallocation) · [OnceLock/LazyLock](https://doc.rust-lang.org/std/sync/struct.OnceLock.html) · [HashMap default hasher](https://doc.rust-lang.org/std/collections/hash_map/struct.HashMap.html) · [Edition 2021 disjoint captures](https://doc.rust-lang.org/edition-guide/rust-2021/disjoint-capture-in-closures.html) · [Edition 2018 path changes](https://doc.rust-lang.org/edition-guide/rust-2018/path-changes.html) · [Edition 2024 RPIT capture](https://doc.rust-lang.org/edition-guide/rust-2024/rpit-lifetime-capture.html) · [Rust 1.85 / Edition 2024](https://blog.rust-lang.org/2025/02/20/Rust-1.85.0/) · [let-else (1.65)](https://doc.rust-lang.org/rust-by-example/flow_control/let_else.html) · [RFC 2795 inline format args (1.58)](https://rust-lang.github.io/rfcs/2795-format-args-implicit-identifiers.html)

**Clippy (every lint group/level re-verified against the canonical DB)** — [lint list](https://rust-lang.github.io/rust-clippy/master/index.html) · [lint-group semantics](https://doc.rust-lang.org/clippy/lints.html) · [usage (restriction/pedantic caveats)](https://doc.rust-lang.org/clippy/usage.html)

**Semi-official — rust-unofficial/patterns** — [TOC](https://rust-unofficial.github.io/patterns/) · [borrow_clone](https://rust-unofficial.github.io/patterns/anti_patterns/borrow_clone.html) · [deref](https://rust-unofficial.github.io/patterns/anti_patterns/deref.html) · [deny-warnings](https://rust-unofficial.github.io/patterns/anti_patterns/deny-warnings.html) · [coercion-arguments](https://rust-unofficial.github.io/patterns/idioms/coercion-arguments.html) · [mem-replace](https://rust-unofficial.github.io/patterns/idioms/mem-replace.html)

**Secondary (naming/illustration only — no behavioral/version claim rests on these)** — [nrc error-docs](https://nrc.github.io/error-docs/error-design/error-type-design.html) · [thiserror](https://docs.rs/thiserror) / [anyhow](https://docs.rs/anyhow) · [Nethercote: brutally effective hash](https://nnethercote.github.io/2021/12/08/a-brutally-effective-hash-function-in-rust.html) · [aHash comparison](https://github.com/tkaitchuck/aHash/blob/master/compare/readme.md)

**One unverified item, flagged:** §6.7 (SmallVec/arrayvec small-buffer optimization) — no primary Rust-project source; evidence-gated optimization, not an asserted rule.
