# Rust Correctness Audit — Reference

Failure mode, Rust-specific rationale, anti-pattern→fix, exact tooling, and primary-source citation for every dimension in `SKILL.md`. Clippy lint names, groups, and default levels were verified against the rust-clippy `master` source (the rendered Clippy index is JS-rendered and has known group/level errors — do not trust a single rendered fetch). Lints attributed to **rustc** are built-in compiler lints, not Clippy — including `undropped_manually_drops`, which originated in Clippy but was uplifted to a rustc deny-by-default lint.

**Master distinction:** debug builds enable `-C debug-assertions`/`-C overflow-checks`; release builds (default) disable them. Many panics below become **silent wrong data in release**.

---

## 1. Logic & Operator Bugs

### 1.1 Bitwise `&`/`|` used where logical `&&`/`||` was meant

`&&`/`||` are lazy (short-circuiting); `&`/`|` on `bool` compile and yield `bool` but evaluate **both** operands. A guard whose RHS indexes or panics still runs even when the LHS already decided the result.

**Violation → Fix:**
```rust
if !v.is_empty() & (v[0] > 0) { … }   // BUG: indexes v even when empty → panic
if !v.is_empty() && v[0] > 0 { … }    // FIX: short-circuits
```
**Tooling:** No lint for `&`/`|`-vs-`&&`/`||` intent. `bad_bit_mask`, `ineffective_bit_mask` (Clippy **correctness**, deny) catch only comparison-vs-bitmask errors like `x & 1 == 2`. `nonminimal_bool` (Clippy **pedantic**, allow). Otherwise manual.
> — [Reference: Lazy boolean operators](https://doc.rust-lang.org/reference/expressions/operator-expr.html#lazy-boolean-operators) · [Clippy: bad_bit_mask](https://rust-lang.github.io/rust-clippy/master/index.html#bad_bit_mask)

### 1.2 `usize` subtraction underflow

Unsigned underflow is arithmetic overflow: **panic in debug, wrap to a huge value in release**. `len() - 1` on an empty `Vec`, `i - 1` at loop start.

**Violation → Fix:**
```rust
let prev = idx - 1;            // BUG: idx==0 → panic (debug) / usize::MAX (release)
let prev = idx.checked_sub(1); // FIX: Option<usize>
```
**Tooling:** `arithmetic_side_effects` (Clippy **restriction**, allow), `implicit_saturating_sub` (Clippy **style**, warn). rustc `unconditional_panic` (deny) is constants only.
> — [Reference: overflow](https://doc.rust-lang.org/reference/expressions/operator-expr.html#overflow) · [Clippy: implicit_saturating_sub](https://rust-lang.github.io/rust-clippy/master/index.html#implicit_saturating_sub)

### 1.3 Integer `/` truncates toward zero; `%` sign follows the dividend

`-7 / 2 == -3` (not `-4`); `-7 % 3 == -1` (not `2`). `% n` does not map negatives into `0..n`.

**Violation → Fix:**
```rust
let bucket = (h % n) as usize;         // BUG: h<0 → negative → cast wraps
let bucket = h.rem_euclid(n) as usize; // FIX: always 0..n
```
**Tooling:** `modulo_arithmetic` (Clippy **restriction**, allow), `modulo_one` (Clippy **correctness**, deny — the `% 1` no-op). Sign-of-remainder logic: manual.
> — [Reference: arithmetic operators](https://doc.rust-lang.org/reference/expressions/operator-expr.html#arithmetic-and-logical-binary-operators)

### 1.4 `..` vs `..=` range off-by-one

`a..b` excludes `b`; `a..=b` includes it. `0..=v.len()` indexes one past the end (panic); `1..n` for `1..=n` drops the last element.

**Violation → Fix:**
```rust
for i in 0..=v.len() { sum += v[i]; }  // BUG: i == v.len() → out of bounds panic
for i in 0..v.len()  { sum += v[i]; }  // FIX
```
**Tooling:** `reversed_empty_ranges` (Clippy **correctness**, deny), `range_plus_one`/`range_minus_one` (Clippy **pedantic**, allow), `almost_complete_range` (Clippy **suspicious**, warn). General off-by-one: manual.
> — [Reference: range expressions](https://doc.rust-lang.org/reference/expressions/range-expr.html)

### 1.5 `match` arm shadowing / unreachable arms

Arms match top-to-bottom; an earlier broad pattern or guard makes a later arm dead.

**Violation → Fix:**
```rust
match code { c if c >= 0 => "ok", 404 => "nf", _ => "?" }  // BUG: 404 unreachable
match code { 404 => "nf", c if c >= 0 => "ok", _ => "?" }  // FIX: specific arm first
```
**Tooling:** `match_overlapping_arm` (Clippy **style**, warn — overlapping integer ranges), `match_same_arms` (Clippy **pedantic**, allow). rustc `unreachable_patterns` (warn) catches structurally-unreachable arms but **not** guard-shadowed ones — manual for guards.
> — [Reference: match expressions](https://doc.rust-lang.org/reference/expressions/match-expr.html)

### 1.6 `if let` with no `else` silently does nothing on the other arm

`if let` is not exhaustive; a missing `else` is a no-op, not an error.

**Violation → Fix:**
```rust
if let Ok(cfg) = load() { apply(cfg); }                    // BUG: load() failure ignored
match load() { Ok(cfg) => apply(cfg), Err(e) => bail!(e) } // FIX (or let-else)
```
**Tooling:** No lint (it is valid). Manual.
> — [Reference: if let expressions](https://doc.rust-lang.org/reference/expressions/if-expr.html#if-let-expressions)

### 1.7 Accidental shadowing → silent wrong reads

`let x = …; let x = …;` is a new binding. An accidental inner shadow leaves the outer variable unchanged when the block ends.

**Violation → Fix:**
```rust
let mut total = 0;
for r in rows { let total = r.amount; sum += total; } // BUG: inner shadows; outer stays 0
for r in rows { total += r.amount; }                  // FIX
```
**Tooling:** `shadow_unrelated`, `shadow_same`, `shadow_reuse` (all Clippy **restriction**, allow — opt-in).
> — [Book: shadowing](https://doc.rust-lang.org/book/ch03-01-variables-and-mutability.html#shadowing)

### 1.8 `==` on floating-point

`f32`/`f64` use IEEE 754 `PartialEq`: rounding makes `0.1 + 0.2 != 0.3`, and **`NaN != NaN`** (so `x == x` is `false` for NaN). Floats deliberately do not implement `Eq`/`Ord`; `total_cmp` gives a total order.

**Violation → Fix:**
```rust
if price == 0.3 { … }                       // BUG: float rounding; never true
if (price - 0.3).abs() < f64::EPSILON { … } // FIX (domain-appropriate epsilon)
```
**Tooling:** `float_cmp` (Clippy **pedantic**, allow), `float_cmp_const` (Clippy **restriction**, allow), `float_equality_without_abs` (Clippy **suspicious**, warn).
> — [std::primitive.f64 (NaN / total_cmp)](https://doc.rust-lang.org/std/primitive.f64.html) · [Clippy: float_cmp](https://rust-lang.github.io/rust-clippy/master/index.html#float_cmp)

### 1.9 Self-comparison / mistyped operands

`a == a`, `a & a`, `a - a`, `x = x` are almost always typos.

**Violation → Fix:** `if width == width { … }` → likely `width == height`.

**Tooling:** `eq_op` (Clippy **correctness**, deny — "free of false positives"), `self_assignment` (Clippy **correctness**, deny).
> — [Clippy: eq_op](https://rust-lang.github.io/rust-clippy/master/index.html#eq_op) · [Clippy: self_assignment](https://rust-lang.github.io/rust-clippy/master/index.html#self_assignment)

---

## 2. Integer Overflow & Numeric Casts

### 2.1 Debug-panic vs release-wrap for arithmetic overflow

Reference: integer overflow **panics in debug**, performs **two's-complement wrapping in release** (default `overflow-checks` follows `debug-assertions`). One source, two behaviors → passes tests in debug, corrupts data in release.

**Violation → Fix:**
```rust
let total = a + b;                              // BUG: silent wrap in release
let total = a.checked_add(b).ok_or(Overflow)?;  // FIX
```
**Tooling:** rustc `arithmetic_overflow` (**deny**) — constants only. Clippy `arithmetic_side_effects` (**restriction**, allow). Mitigation flag: `[profile.release] overflow-checks = true` or `RUSTFLAGS=-Coverflow-checks=on`. Behavior stable since 1.0; not edition-sensitive.
> — [Reference: overflow](https://doc.rust-lang.org/reference/expressions/operator-expr.html#overflow) · [rustc deny-by-default lints](https://doc.rust-lang.org/rustc/lints/listing/deny-by-default.html)

### 2.2 `as` integer cast silently truncates / reinterprets sign

Larger→smaller `as` truncates (`1234u16 as u8 == 210`); same-size `as` reinterprets (`-1i8 as u8 == 255`, `255u8 as i8 == -1`). No panic, no error.

**Violation → Fix:**
```rust
let port = big_u32 as u16;            // BUG: truncates high bits
let port: u16 = big_u32.try_into()?;  // FIX: errors if out of range
```
**Tooling:** `cast_possible_truncation`, `cast_possible_wrap`, `cast_sign_loss` (all Clippy **pedantic**, allow), `cast_enum_truncation` (Clippy **suspicious**, warn), `as_conversions` (Clippy **restriction**, allow). Enabling the pedantic casts *is* the mitigation.
> — [Reference: numeric cast](https://doc.rust-lang.org/reference/expressions/operator-expr.html#numeric-cast) · [Clippy: cast_possible_truncation](https://rust-lang.github.io/rust-clippy/master/index.html#cast_possible_truncation)

### 2.3 `f64 as iN` saturates; `NaN → 0` (version-pinned: Rust 1.45)

Float→int `as` rounds toward zero, saturates at the integer's min/max, and maps `NaN → 0`. Saturating semantics were **stabilized in Rust 1.45** (pre-1.45 it was UB). Modern behavior silently clamps instead of erroring.

**Violation → Fix:**
```rust
let n = (ratio * 1e9_f64) as i32;  // BUG: huge ratio clamps to i32::MAX; NaN→0
// FIX: validate range / is_finite() before the cast.
```
**Tooling:** `cast_nan_to_int` (Clippy **suspicious**, warn — constant NaN only), `cast_precision_loss` (Clippy **pedantic**, allow). Runtime range/NaN: manual `is_finite()`.
> — [Reference: numeric cast](https://doc.rust-lang.org/reference/expressions/operator-expr.html#numeric-cast) · [Rust 1.45 release notes — float-cast saturation](https://blog.rust-lang.org/2020/07/16/Rust-1.45.0.html)

### 2.4 `iN::MIN / -1`, `MIN % -1`, division/`%` by zero panic unconditionally

Reference: `/` or `%` with LHS = the signed type's minimum and RHS = `-1` panics **even when `-C overflow-checks` is disabled**. Division/`%` by **zero** also always panics. These panic in **release too**.

**Violation → Fix:**
```rust
let q = a / b;                               // BUG: a==i32::MIN,b==-1 → panic (even release); b==0 → panic
let q = a.checked_div(b).ok_or(BadDivisor)?; // FIX
```
**Tooling:** rustc `unconditional_panic` (**deny**) for constant `x / 0`. `integer_division` (Clippy **restriction**, allow). Runtime: manual `checked_div`/`checked_rem`.
> — [Reference: arithmetic operators](https://doc.rust-lang.org/reference/expressions/operator-expr.html#arithmetic-and-logical-binary-operators) · [rustc deny-by-default lints](https://doc.rust-lang.org/rustc/lints/listing/deny-by-default.html)

### 2.5 Shift overflow

`x << n` with `n >=` the type's bit width (or negative) → **panic in debug, wrap in release**. `1u32 << 32` is not `0`.

**Violation → Fix:**
```rust
let mask = 1u32 << shift;                            // BUG: shift>=32 → panic/wrong in release
let mask = 1u32.checked_shl(shift).ok_or(BadShift)?; // FIX
```
**Tooling:** rustc `arithmetic_overflow`/`unconditional_panic` (deny) for constant shifts. Runtime: manual `checked_shl`/`checked_shr`. (There is **no** Clippy lint named `unbounded_shift` — do not cite one.)
> — [Reference: overflow](https://doc.rust-lang.org/reference/expressions/operator-expr.html#overflow) · [std u32::checked_shl](https://doc.rust-lang.org/std/primitive.u32.html#method.checked_shl)

---

## 3. Panic Sources on Realistic Input

### 3.1 `unwrap()` / `expect()` on `Option`/`Result`

`Option::unwrap` panics on `None`; `Result::unwrap` panics on `Err`. On realistic failure (missing key, bad parse, closed socket) this aborts the thread/process.

**Violation → Fix:**
```rust
let n: u32 = s.parse().unwrap(); // BUG: any non-numeric input panics
let n: u32 = s.parse()?;         // FIX
```
**Tooling:** `unwrap_used`, `expect_used` (Clippy **restriction**, allow), `panic_in_result_fn` (Clippy **restriction**, allow), `unnecessary_unwrap` (Clippy **complexity**, warn), `panicking_unwrap` (Clippy **correctness**, deny — provably-always-panics).
> — [std Option::unwrap](https://doc.rust-lang.org/std/option/enum.Option.html#method.unwrap) · [std Result::unwrap](https://doc.rust-lang.org/std/result/enum.Result.html#method.unwrap) · [Clippy: unwrap_used](https://rust-lang.github.io/rust-clippy/master/index.html#unwrap_used)

### 3.2 Indexing / slicing out of bounds

`Index for [T]` panics out of bounds; `&a[x..y]` panics if `x > y` or `y > len`. Safe Rust has no silent UB here, but the panic crashes the thread.

**Violation → Fix:**
```rust
let first = parts[1];                     // BUG: split() may yield <2 → panic
let first = parts.get(1).ok_or(Missing)?; // FIX
```
**Tooling:** rustc `unconditional_panic` (**deny**) for constant OOB. Clippy `out_of_bounds_indexing` (**correctness**, deny — known-len), `indexing_slicing` (**restriction**, allow — flags all `[]`).
> — [std slice Index](https://doc.rust-lang.org/std/primitive.slice.html#impl-Index%3CI%3E-for-%5BT%5D) · [Clippy: out_of_bounds_indexing](https://rust-lang.github.io/rust-clippy/master/index.html#out_of_bounds_indexing)

### 3.3 `str` byte-slice not on a `char` boundary

`&s[a..b]` panics if `b` is not a UTF-8 code-point boundary or past the end. `String` has no `Index<usize>`, so people reach for `&s[..n]` and hit this on the first non-ASCII input.

**Violation → Fix:**
```rust
let head = &name[..10];                              // BUG: panics if byte 10 splits a char
let head: String = name.chars().take(10).collect();  // FIX (or floor_char_boundary)
```
**Tooling:** `char_indices_as_byte_indices` (Clippy **correctness**, deny — using a `char_indices` count as a byte index). General mid-char slicing: manual.
> — [std str::split_at](https://doc.rust-lang.org/std/primitive.str.html#method.split_at) · [std str::is_char_boundary](https://doc.rust-lang.org/std/primitive.str.html#method.is_char_boundary)

### 3.4 `Vec::remove`/`swap_remove`/`insert`/`drain`/`split_off` out of range

All panic if the index/range is out of bounds. Length changes between calls, so a once-valid index goes stale.

**Violation → Fix:**
```rust
let x = v.remove(i);                    // BUG: i >= v.len() → panic
if i < v.len() { let x = v.remove(i); } // FIX (or v.get then remove)
```
**Tooling:** No Clippy lint validates runtime index args. Manual.
> — [std Vec::remove](https://doc.rust-lang.org/std/vec/struct.Vec.html#method.remove) · [std Vec::insert](https://doc.rust-lang.org/std/vec/struct.Vec.html#method.insert)

### 3.5 `RefCell` double-borrow panic

`RefCell` enforces borrow rules at runtime: `borrow()` panics if mutably borrowed; `borrow_mut()` panics if borrowed. Holding a guard across a callback/recursive call that re-borrows panics.

**Violation → Fix:**
```rust
let mut g = cell.borrow_mut();
notify_observers();          // BUG: an observer calls cell.borrow() → panic
drop(g); notify_observers(); // FIX: release before re-entrant calls
```
**Tooling:** `await_holding_refcell_ref` (Clippy **suspicious**, warn) — only the *async* variant. Synchronous re-entrant double-borrow: manual.
> — [std RefCell::borrow](https://doc.rust-lang.org/std/cell/struct.RefCell.html#method.borrow) · [std RefCell::borrow_mut](https://doc.rust-lang.org/std/cell/struct.RefCell.html#method.borrow_mut)

### 3.6 `Mutex`/`RwLock` poisoning panic via `.unwrap()`

A mutex becomes poisoned if a holder panics; `lock()`/`try_lock()` then return `Err`. "Most usage will simply `unwrap()`" — so one panicked critical section makes every other `lock().unwrap()` panic: a process-wide cascade.

**Violation → Fix:**
```rust
let g = m.lock().unwrap();                           // BUG: cascades after any poisoning
let g = m.lock().unwrap_or_else(|e| e.into_inner()); // FIX: recover if data still usable
```
**Tooling:** No lint (recovery is a design choice). Manual.
> — [std Mutex](https://doc.rust-lang.org/std/sync/struct.Mutex.html) · [std PoisonError::into_inner](https://doc.rust-lang.org/std/sync/struct.PoisonError.html#method.into_inner)

### 3.7 `unreachable!`/`todo!`/`unimplemented!`/`assert!` on live paths

All expand to `panic!`. A `_ => unreachable!()` panics when a new enum variant or odd input reaches it; `assert!` on real (not just buggy) data panics.

**Violation → Fix:**
```rust
_ => unreachable!(),          // BUG: a new variant / odd input reaches it
_ => return Err(Unsupported), // FIX: degrade gracefully
```
**Tooling:** `todo`, `unimplemented`, `unreachable`, `panic` (all Clippy **restriction**, allow). Enable in production crates.
> — [std unreachable!](https://doc.rust-lang.org/std/macro.unreachable.html) · [Clippy: todo](https://rust-lang.github.io/rust-clippy/master/index.html#todo)

### 3.8 Panic inside `Drop` → double-panic → abort

If a `drop` runs during unwinding from a panic and itself panics, Rust **aborts the process** (uncatchable).

**Violation → Fix:**
```rust
impl Drop for T { fn drop(&mut self) { self.flush().unwrap(); } } // BUG: err while unwinding → abort
impl Drop for T { fn drop(&mut self) { let _ = self.flush(); } }  // FIX: swallow/log, never panic
```
**Tooling:** No lint detects panic-reachable-from-Drop. Manual; treat `unwrap`/`expect`/indexing in a `Drop` impl as red flags.
> — [std Drop](https://doc.rust-lang.org/std/ops/trait.Drop.html)

---

## 4. Option / Result Mishandling

### 4.1 Ignored `Result` (`#[must_use]` / `let _ =`)

`Result` is `#[must_use]`; rustc `unused_must_use` (warn) fires on a bare `Result` statement. But `let _ = fallible();` and `.ok();` silence it and **drop the error** — a failed write/flush/send looks successful.

**Violation → Fix:**
```rust
let _ = file.write_all(data); // BUG: short write / I/O error silently lost
file.write_all(data)?;        // FIX
```
**Tooling:** rustc `unused_must_use` (**warn**). `let_underscore_must_use` (Clippy **restriction**, allow), `unused_io_amount` (Clippy **correctness**, deny — ignored read/write byte counts / partial writes).
> — [std Result](https://doc.rust-lang.org/std/result/enum.Result.html) · [rustc warn-by-default lints](https://doc.rust-lang.org/rustc/lints/listing/warn-by-default.html) · [Clippy: unused_io_amount](https://rust-lang.github.io/rust-clippy/master/index.html#unused_io_amount)
>
> *Caveat:* the exact `#[must_use]` message string on `Result` is widely reproduced but was not pulled verbatim from a rendered std page; the behavior (Result is `#[must_use]`; `unused_must_use` warns) is primary-sourced. Treat the precise wording as secondary.

### 4.2 `.ok()` discarding the error

`Result::ok()` converts the error to `None`. `parse(&s).ok()?` early-returns `None` on *any* error with zero diagnostics.

**Violation → Fix:**
```rust
let cfg = parse(&s).ok()?;                  // BUG: parse error → silent None
let cfg = parse(&s).map_err(log_err).ok()?; // FIX (or propagate the Result)
```
**Tooling:** No dedicated lint (valid conversion). Manual.
> — [std Result::ok](https://doc.rust-lang.org/std/result/enum.Result.html#method.ok)

### 4.3 Eager `unwrap_or`/`ok_or`/`map_or` argument

std: "Arguments passed to `unwrap_or` are eagerly evaluated; if you are passing the result of a function call, use `unwrap_or_else`." Eager evaluation runs side effects / expensive work on the success path too, and can itself panic.

**Violation → Fix:**
```rust
let v = cache.get(k).unwrap_or(expensive_default());    // BUG: always computes default
let v = cache.get(k).unwrap_or_else(expensive_default); // FIX: only on miss
```
**Tooling:** `or_fun_call` (Clippy **nursery**, allow), `unnecessary_lazy_evaluations` (Clippy **style**, warn — the inverse).
> — [std Option::unwrap_or](https://doc.rust-lang.org/std/option/enum.Option.html#method.unwrap_or)

### 4.4 `map` vs `and_then` → nested `Option`/`Result`

`map` with an `Option`/`Result`-returning closure yields `Option<Option<_>>`; the inner failure is then ignored.

**Violation → Fix:**
```rust
let n = txt.map(|s| s.parse::<i32>());           // BUG: Option<Result<i32,_>> — error swallowed
let n = txt.and_then(|s| s.parse::<i32>().ok()); // FIX (or keep Result + ?)
```
**Tooling:** `map_flatten` (Clippy **complexity**, warn), `bind_instead_of_map` (Clippy **complexity**, warn). The silent-nesting logic itself: manual.
> — [std Option::and_then](https://doc.rust-lang.org/std/option/enum.Option.html#method.and_then)

### 4.5 `collect::<Result<Vec<_>,_>>()` short-circuits

std `FromIterator for Result`: "if it is an `Err`, no further elements are taken." Items after the first `Err` (and their side effects) are not processed.

**Violation → Fix:**
```rust
let all: Result<Vec<_>,_> = ids.iter().map(|i| { audit(i); validate(i) }).collect(); // BUG: audit() stops at first invalid
let (ok, errs): (Vec<_>, Vec<_>) = ids.iter().map(validate).partition(Result::is_ok); // FIX if all needed
```
**Tooling:** No lint (intended behavior). Manual.
> — [std Result FromIterator](https://doc.rust-lang.org/std/result/enum.Result.html#impl-FromIterator%3CResult%3CA,+E%3E%3E-for-Result%3CV,+E%3E)

### 4.6 `Iterator::sum`/`product` overflow

`sum()`/`product()` use the type's `+`/`*` — no checked variant. Large datasets overflow silently in release.

**Violation → Fix:**
```rust
let total: u32 = sizes.iter().sum();  // BUG: overflow wraps in release
let total = sizes.iter().try_fold(0u64, |a, &x| a.checked_add(x as u64)).ok_or(Overflow)?; // FIX
```
**Tooling:** `arithmetic_side_effects` (Clippy **restriction**, allow) flags the underlying op. No `sum`-specific lint.
> — [std Iterator::sum](https://doc.rust-lang.org/std/iter/trait.Iterator.html#method.sum)

---

## 5. Ownership / Lifetime Correctness (compile-clean, runtime-wrong)

### 5.1 `let _ = mutex.lock()` drops the guard immediately

A `_`-bound temporary drops at the end of the statement: `let _ = m.lock();` acquires **and releases** the lock on the same line — the critical section runs unlocked. `let _guard = m.lock();` holds it to scope end.

**Violation → Fix:**
```rust
let _ = mtx.lock().unwrap();      // BUG: lock released immediately
shared.push(x);
let _guard = mtx.lock().unwrap(); // FIX: held until scope end
shared.push(x);
```
**Tooling:** `let_underscore_lock` (Clippy **correctness**, deny). (`let_underscore_future`, Clippy **suspicious**, warn, is the async analogue.)
> — [Reference: destructors](https://doc.rust-lang.org/reference/destructors.html) · [Clippy: let_underscore_lock](https://rust-lang.github.io/rust-clippy/master/index.html#let_underscore_lock)

### 5.2 Drop order (locks, guards, temporaries) — edition-sensitive

Variables drop in reverse declaration order; struct fields in declaration order. **Rust 2024** narrowed temporary scopes: `if let` scrutinee temporaries now drop **before** the `else` block, and tail-expression temporaries drop immediately. Code relying on a `MutexGuard` temporary living into the `else`/next-arm behaves differently between 2021 and 2024.

**Violation → Fix:**
```rust
if let Some(v) = map.lock().unwrap().get(&k) { … } else { map.lock().unwrap().insert(k, d); }
// 2021: outer lock temp may live into else → re-entrant lock() deadlocks. 2024: dropped first → ok.
let needs = { let g = map.lock().unwrap(); g.get(&k).cloned() }; // FIX: explicit short scope
```
**Tooling:** `significant_drop_in_scrutinee`, `significant_drop_tightening` (Clippy **nursery**, allow). Edition behavior: edition-aware manual review.
> — [Reference: destructors](https://doc.rust-lang.org/reference/destructors.html) · [Edition Guide: 2024 if let temporary scope](https://doc.rust-lang.org/edition-guide/rust-2024/temporary-if-let-scope.html)

### 5.3 `mem::take`/`replace` then early `?` leaves a placeholder

`mem::take(&mut x)` leaves `x = Default::default()`. If a later fallible step `?`-returns before restoring `x`, the struct is left in the default state — silent corruption on the error path.

**Violation → Fix:**
```rust
let buf = std::mem::take(&mut self.buffer);
let parsed = parse(&buf)?; // BUG: on Err, self.buffer is now empty (lost data)
// FIX: parse first; swap only after the fallible step succeeds, or restore on all paths.
```
**Tooling:** `mem_replace_with_default`, `mem_replace_option_with_none` (Clippy **style**, warn) are idiom hints, not the logic bug. The forgot-to-restore pattern: manual.
> — [std mem::take](https://doc.rust-lang.org/std/mem/fn.take.html) · [std mem::replace](https://doc.rust-lang.org/std/mem/fn.replace.html)

### 5.4 Cached index/len across a `Vec` mutation

Indices are plain `usize` (no borrow), so this compiles. `push` may reallocate; `insert`/`remove` shift elements. The cached index now points elsewhere or out of bounds.

**Violation → Fix:**
```rust
let last = v.len() - 1;
v.push(x);          // BUG: len changed
process(v[last]);   // reads the wrong element
v.push(x); let last = v.len() - 1; process(v[last]); // FIX: recompute after mutation
```
**Tooling:** No lint (no borrow involved). Manual.
> — [std Vec guarantees](https://doc.rust-lang.org/std/vec/struct.Vec.html#guarantees)

---

## 6. Drop, Leaks & Resource Correctness

### 6.1 `BufWriter` not flushed before drop → silent data loss

std: "It is critical to call flush before `BufWriter` is dropped … any errors that happen in the process of dropping will be ignored." A write failure during the implicit drop-flush (disk full, broken pipe) is silently swallowed.

**Violation → Fix:**
```rust
{ let mut w = BufWriter::new(file); w.write_all(&data)?; }            // BUG: drop-flush error lost
{ let mut w = BufWriter::new(file); w.write_all(&data)?; w.flush()?; } // FIX: surfaces the error
```
**Tooling:** No lint. Manual.
> — [std BufWriter](https://doc.rust-lang.org/std/io/struct.BufWriter.html)

### 6.2 `Rc`/`Arc` reference cycle → memory never freed

Book ch.15.6: a strong `Rc`/`Arc` cycle's counts never reach 0 — "the values will never be dropped … uncollected forever." Rust does **not** guarantee leak-freedom. Use `Weak` for back-references.

**Violation → Fix:**
```rust
struct Node { parent: RefCell<Rc<Node>>, … }   // BUG: child↑parent + parent↑child = cycle leak
struct Node { parent: RefCell<Weak<Node>>, … } // FIX: non-owning back-edge
```
**Tooling:** `rc_mutex`, `rc_buffer` (Clippy **restriction**, allow) are adjacent smells, not cycle detection. No cycle lint — manual.
> — [Book: reference cycles](https://doc.rust-lang.org/book/ch15-06-reference-cycles.html) · [std Rc::Weak](https://doc.rust-lang.org/std/rc/struct.Weak.html)

### 6.3 `mem::forget`/`ManuallyDrop`/`Box::leak`

std `mem::forget`: managed resources "will linger forever in an unreachable state." A forgotten `File`/`MutexGuard`/`TcpStream` leaks the OS handle or never releases the lock. `Box::leak` in a loop/request path is a bug.

**Violation → Fix:**
```rust
for req in reqs { let c = open_conn()?; std::mem::forget(c); … } // BUG: leaks one fd per request
for req in reqs { let c = open_conn()?; … }                      // FIX: let it drop
```
**Tooling:** `mem_forget` (Clippy **restriction**, allow), `forget_non_drop` (Clippy **suspicious**, warn), `undropped_manually_drops` (**rustc deny-by-default**, uplifted from Clippy — `drop(ManuallyDrop)` is a no-op on the inner value).
> — [std mem::forget](https://doc.rust-lang.org/std/mem/fn.forget.html) · [rustc deny-by-default lints (undropped_manually_drops)](https://doc.rust-lang.org/rustc/lints/listing/deny-by-default.html)

### 6.4 `process::exit` / `panic = "abort"` skip all destructors

std `process::exit`: "no destructors on the current stack or any other thread's stack will be run." `BufWriter`s don't flush, temp files leak, locks aren't released.

**Violation → Fix:**
```rust
if fatal { eprintln!("bye"); std::process::exit(1); } // BUG: BufWriters unflushed
// FIX: flush/cleanup explicitly first, or return a Termination from main and let it unwind.
```
**Tooling:** No lint. Manual — audit `process::exit` call sites for pending buffered state.
> — [std process::exit](https://doc.rust-lang.org/std/process/fn.exit.html) · [Reference: destructors](https://doc.rust-lang.org/reference/destructors.html)

---

## 7. Concurrency Correctness (safe Rust)

### 7.1 Re-entrant `std::sync::Mutex` lock

std `Mutex::lock`: "The exact behavior on locking a mutex in the thread which already holds the lock is left unspecified. However, this function will not return on the second call (it might panic or deadlock, for example)." A method holding the lock calling another method that also locks it triggers this.

**Violation → Fix:**
```rust
fn add(&self) { let mut g = self.m.lock().unwrap(); self.recount(); }              // recount() also locks
fn add(&self) { let mut g = self.m.lock().unwrap(); Self::recount_locked(&mut g); } // FIX: pass the guard
```
**Tooling:** No lint detects re-entrant locking. Manual. (`parking_lot::ReentrantMutex` if reentrancy is genuinely needed.) **Phrase findings as "unspecified; will not return on the second call," not "guaranteed deadlock."**
> — [std Mutex::lock](https://doc.rust-lang.org/std/sync/struct.Mutex.html#method.lock)

### 7.2 Lock-ordering deadlock

`MutexGuard` holds the lock until dropped. Two threads taking the same two locks in opposite orders is a classic AB-BA deadlock; the type system does not prevent it.

**Violation → Fix:**
```rust
// T1: A.lock(); B.lock();   T2: B.lock(); A.lock();  // BUG: AB-BA deadlock
// FIX: define order A<B; everyone locks A before B (or one combined Mutex<(..)>).
```
**Tooling:** No static lint. Manual; `parking_lot` deadlock-detection feature at runtime.
> — [std Mutex](https://doc.rust-lang.org/std/sync/struct.Mutex.html) · [Book: shared-state concurrency](https://doc.rust-lang.org/book/ch16-03-shared-state.html)

### 7.3 `Condvar` without a predicate loop

std `Condvar`: "susceptible to spurious wakeups … the predicate must always be checked each time this function returns." A bare `if` proceeds on a spurious wakeup; one `Condvar` with two different mutexes "may result in a runtime panic."

**Violation → Fix:**
```rust
let g = m.lock().unwrap(); if !ready { let g = cv.wait(g).unwrap(); } use(g);     // BUG: spurious wakeup
let mut g = m.lock().unwrap(); while !ready { g = cv.wait(g).unwrap(); } use(g);  // FIX: loop on predicate
```
**Tooling:** No lint enforces the predicate loop. Manual (prefer `wait_while`).
> — [std Condvar::wait_timeout](https://doc.rust-lang.org/std/sync/struct.Condvar.html#method.wait_timeout)

### 7.4 Atomic `Ordering` too weak

std `Ordering`: `Relaxed` = "no ordering constraints." A `Release` store + `Acquire` load establish happens-before; a `Relaxed` flag does **not** guarantee data written before it is visible to a reader that saw it — a real bug on ARM/AArch64, invisible on x86.

**Violation → Fix:**
```rust
DATA.store(v,Relaxed); READY.store(true,Relaxed); // reader: if READY.load(Relaxed){read DATA}  // BUG
DATA.store(v,Relaxed); READY.store(true,Release); // reader: if READY.load(Acquire){read DATA}   // FIX
```
**Tooling:** rustc `invalid_atomic_ordering` (**deny**, Rust 1.56+) catches *invalid* orderings (e.g. `Acquire` on a store) — **not** "too weak." Choosing the right strength: manual, per the Nomicon.
> — [std atomic::Ordering](https://doc.rust-lang.org/std/sync/atomic/enum.Ordering.html) · [Nomicon: atomics](https://doc.rust-lang.org/nomicon/atomics.html)

### 7.5 `compare_exchange_weak` outside a retry loop

`compare_exchange_weak` may fail spuriously on LL/SC architectures — acceptable *in a loop*, wrong for a one-shot decision (a spurious failure is treated as a real mismatch).

**Violation → Fix:**
```rust
if a.compare_exchange_weak(0,1,AcqRel,Acquire).is_ok() { init(); } // BUG: spurious Err skips init
loop { match a.compare_exchange_weak(0,1,AcqRel,Acquire) { Ok(_)=>break, Err(_)=>continue } } // FIX
```
**Tooling:** No lint. Manual.
> — [std AtomicUsize::compare_exchange_weak](https://doc.rust-lang.org/std/sync/atomic/struct.AtomicUsize.html#method.compare_exchange_weak)

### 7.6 Channel `recv()`/`send()` unwrapped

std `mpsc`: an unsuccessful op means the other half hung up. `recv()` → `Err(RecvError)` once all senders drop; a `recv().unwrap()` loop panics on normal shutdown. `sync_channel(0)` is a rendezvous — mismatched counts deadlock.

**Violation → Fix:**
```rust
loop { let msg = rx.recv().unwrap(); handle(msg); } // BUG: panics when senders drop
while let Ok(msg) = rx.recv() { handle(msg); }       // FIX: clean exit on disconnect
```
**Tooling:** No lint. Manual.
> — [std sync::mpsc](https://doc.rust-lang.org/std/sync/mpsc/index.html)

### 7.7 Unjoined `thread::spawn` swallows panic and result

If you never `join()` (or drop the handle), a panicking thread does **not** propagate to the parent and the result is lost — the program continues as if it succeeded. `thread::scope` (Rust 1.63+) joins and propagates.

**Violation → Fix:**
```rust
for w in work { thread::spawn(move || process(w)); }              // BUG: panics/results vanish
thread::scope(|s| { for w in work { s.spawn(|| process(w)); } }); // FIX: joined + panics propagate
```
**Tooling:** No lint. Manual.
> — [std thread::spawn](https://doc.rust-lang.org/std/thread/fn.spawn.html) · [std thread::scope](https://doc.rust-lang.org/std/thread/fn.scope.html)

---

## 8. Async Correctness (tokio / futures)

### 8.1 Holding a `std::sync::MutexGuard` (or non-`Send`) across `.await`

A future captures everything live across `.await`. `tokio::spawn` requires `Send + 'static`; a `std::sync::MutexGuard` is `!Send` → won't compile in a spawned task. Even single-threaded, the lock is held while the task is suspended for I/O — serializing the runtime / risking deadlock.

**Violation → Fix:**
```rust
let g = std_mtx.lock().unwrap(); do_io().await; *g += 1;          // BUG: !Send / lock held across await
{ let mut g = std_mtx.lock().unwrap(); *g += 1; } do_io().await;  // FIX: scope the std guard
// or: let mut g = tokio_mtx.lock().await;  if the lock must be held across the await
```
**Tooling:** `await_holding_lock`, `await_holding_refcell_ref`, `await_holding_invalid_type` (all Clippy **suspicious**, warn).
> — [tokio Runtime (Send bound)](https://docs.rs/tokio/latest/tokio/runtime/struct.Runtime.html) · [Clippy: await_holding_lock](https://rust-lang.github.io/rust-clippy/master/index.html#await_holding_lock)

### 8.2 Blocking the async runtime

tokio: "issuing a blocking call or performing a lot of compute in a future without yielding … may prevent the executor from driving other futures forward." A blocked worker stalls all tasks on it.

**Violation → Fix:**
```rust
async fn h() { std::thread::sleep(Duration::from_secs(1)); }       // BUG: blocks a worker thread
async fn h() { tokio::time::sleep(Duration::from_secs(1)).await; } // FIX (timer)
let out = tokio::task::spawn_blocking(|| heavy_cpu()).await?;      // FIX (CPU / blocking I/O)
```
**Tooling:** No lint (control-flow sensitive). Manual + tokio docs.
> — [tokio spawn_blocking](https://docs.rs/tokio/latest/tokio/task/fn.spawn_blocking.html) · [tokio blocking-and-yielding](https://docs.rs/tokio/latest/tokio/task/index.html#blocking-and-yielding)

### 8.3 Future built but never `.await`ed

Futures are lazy. `let _ = client.send(req);` builds and drops a future — the request is **never sent**. `#[must_use]` + `unused_must_use` flag a bare future statement, but `let _ = …`/`let f = …;` silence it.

**Violation → Fix:**
```rust
client.send(req);        // BUG: future created, never polled (warns: unused)
client.send(req).await?; // FIX
```
**Tooling:** rustc `unused_must_use` (**warn**) — unbound future only. `let_underscore_future` (Clippy **suspicious**, warn), `async_yields_async` (Clippy **correctness**, deny).
> — [std future::Future (futures do nothing unless polled)](https://doc.rust-lang.org/std/future/trait.Future.html) · [Clippy: let_underscore_future](https://rust-lang.github.io/rust-clippy/master/index.html#let_underscore_future)

### 8.4 `tokio::select!` cancels the losing branches

select! "returns when the first branch completes, cancelling the remaining branches." A not-cancellation-safe op in a loser (`read_exact`, `read_to_end`, `write_all`, `Mutex::lock`, `Semaphore::acquire`) loses partial progress — every loop iteration if in a loop.

**Violation → Fix:**
```rust
loop { tokio::select! { _ = shutdown.recv() => break,
                        n = sock.read_exact(&mut buf) => handle(n)?, } } // BUG: read_exact not cancel-safe
let mut read = Box::pin(sock.read_exact(&mut buf));                       // FIX: persist the future
loop { tokio::select! { _ = shutdown.recv() => break,
                        n = &mut read => { handle(n)?; read = Box::pin(sock.read_exact(&mut buf)); } } }
```
**Tooling:** No lint (semantic). Manual — audit every `select!` branch against tokio's cancellation-safety list.
> — [tokio select!](https://docs.rs/tokio/latest/tokio/macro.select.html) · [tokio AsyncReadExt::read_exact (cancel-safety)](https://docs.rs/tokio/latest/tokio/io/trait.AsyncReadExt.html#method.read_exact)

### 8.5 `select!` loser side effects discarded

Only the completed branch's future is polled; a lost branch's "`<async expression>` is still evaluated, but the resulting future is not polled" — its async body never runs.

**Violation → Fix:**
```rust
tokio::select! { _ = a_send(log_event()) => {}, _ = b.recv() => {} } // BUG: if b wins, log_event future never runs
// FIX: perform required effects unconditionally before/after select!.
```
**Tooling:** No lint. Manual.
> — [tokio select!](https://docs.rs/tokio/latest/tokio/macro.select.html)

### 8.6 `block_on` inside an async context; tokio primitive without a runtime

tokio `Runtime::block_on` panics "if called within an asynchronous execution context." A `tokio::time::Sleep`/`TcpStream` constructed with no tokio runtime entered panics ("no reactor running"); `tokio::spawn` without a runtime panics.

**Violation → Fix:**
```rust
async fn h() { let rt = Runtime::new().unwrap(); rt.block_on(other()); } // BUG: nested → panic
async fn h() { other().await; }                                          // FIX
futures::executor::block_on(async { tokio::time::sleep(d).await });      // BUG: no tokio runtime → panic
#[tokio::main] async fn main() { tokio::time::sleep(d).await; }          // FIX
```
**Tooling:** No lint. Manual; `tokio::task::block_in_place` is the sanctioned escape on the multi-thread runtime.
> — [tokio Runtime::block_on](https://docs.rs/tokio/latest/tokio/runtime/struct.Runtime.html) · [tokio Handle::block_on](https://docs.rs/tokio/latest/tokio/runtime/struct.Handle.html#method.block_on)

### 8.7 `tokio::spawn` panic isolated; detached task lost on shutdown

tokio: panics in a spawned task are caught (`JoinError::is_panic()`); if the `JoinHandle` is dropped "the task continues … its return value is lost." On runtime shutdown, in-flight detached tasks are cancelled mid-await — partial work lost.

**Violation → Fix:**
```rust
tokio::spawn(async { critical_job().await.unwrap(); }); // BUG: panic isolated & unobserved
let h = tokio::spawn(async { critical_job().await });
if let Err(e) = h.await { error!(?e, "job failed"); }   // FIX: observe the JoinError
```
**Tooling:** `let_underscore_future` (Clippy **suspicious**, warn) catches `let _ = tokio::spawn(..)`. A bare `tokio::spawn(..);` does not warn. Manual.
> — [tokio JoinHandle](https://docs.rs/tokio/latest/tokio/task/struct.JoinHandle.html) · [tokio Runtime shutdown](https://docs.rs/tokio/latest/tokio/runtime/struct.Runtime.html#shutdown)

---

## 9. Iterator & Collection Correctness

### 9.1 `zip` truncates to the shorter iterator

std `Iterator::zip`: "If the first iterator returns `None`, `zip` will short-circuit." A length mismatch silently drops the tail of the longer.

**Violation → Fix:**
```rust
for (id, name) in ids.iter().zip(&names) { … } // BUG: extra ids skipped if names shorter
assert_eq!(ids.len(), names.len());            // FIX: assert, or itertools::zip_eq
```
**Tooling:** No std lint for length mismatch. Manual (`itertools::zip_eq` panics on mismatch).
> — [std Iterator::zip](https://doc.rust-lang.org/std/iter/trait.Iterator.html#method.zip)

### 9.2 `Vec::dedup` removes only consecutive duplicates

`[1,2,1].dedup()` stays `[1,2,1]`. Code expecting set-like uniqueness gets duplicates.

**Violation → Fix:**
```rust
v.dedup();             // BUG: non-adjacent dups remain
v.sort(); v.dedup();   // FIX: global dedup
```
**Tooling:** No lint. Manual.
> — [std Vec::dedup](https://doc.rust-lang.org/std/vec/struct.Vec.html#method.dedup)

### 9.3 `chunks`/`windows`/`chunks_exact` last-chunk & zero size

`chunks(n)` yields a shorter final chunk; `chunks_exact(n)` drops the remainder (only via `.remainder()`); all panic if `n == 0`.

**Violation → Fix:**
```rust
for c in data.chunks(4) { let x = c[3]; }       // BUG: last chunk may be <4 → panic
for c in data.chunks_exact(4) { let x = c[3]; } // FIX for fixed-size (handle .remainder())
```
**Tooling:** No lint for last-chunk/zero-size. Manual.
> — [std slice::chunks](https://doc.rust-lang.org/std/primitive.slice.html#method.chunks) · [std slice::chunks_exact](https://doc.rust-lang.org/std/primitive.slice.html#method.chunks_exact)

### 9.4 Sorting floats with `partial_cmp().unwrap()` panics on NaN

`partial_cmp` returns `None` for NaN, so `.unwrap()` panics on any NaN element. `f64::total_cmp` (Rust 1.62+) gives a NaN-safe total order.

**Violation → Fix:**
```rust
v.sort_by(|a, b| a.partial_cmp(b).unwrap()); // BUG: any NaN → panic
v.sort_by(|a, b| a.total_cmp(b));            // FIX (Rust ≥ 1.62)
```
**Tooling:** No dedicated lint for NaN-unwrap-in-comparator. `unnecessary_sort_by` (Clippy **complexity**, warn) is adjacent. Manual.
> — [std f64::total_cmp](https://doc.rust-lang.org/std/primitive.f64.html#method.total_cmp) · [std slice::sort_by](https://doc.rust-lang.org/std/primitive.slice.html#method.sort_by)

### 9.5 `HashMap`/`HashSet` iteration order is non-deterministic

Default SipHash with a random per-map seed: order varies between runs and between maps. Building a hash/signature/serialized output by iterating a `HashMap` is non-reproducible — "flaky-only-sometimes."

**Violation → Fix:**
```rust
let sig = map.iter().fold(String::new(), |s,(k,v)| s + k + v); // BUG: order varies → different sig
let mut kv: Vec<_> = map.iter().collect(); kv.sort();          // FIX: impose an order
```
**Tooling:** No lint detects order-dependence. Manual (use `BTreeMap` when order matters).
> — [std HashMap](https://doc.rust-lang.org/std/collections/struct.HashMap.html)

### 9.6 `sort` (stable) vs `sort_unstable` (not stable)

`slice::sort` "is stable"; `sort_unstable` "may reorder equal elements." Multi-key sorting via successive sorts relies on stability; switching to unstable for speed scrambles the secondary order.

**Violation → Fix:**
```rust
v.sort_by_key(|r| r.name); v.sort_unstable_by_key(|r| r.dept); // BUG: within-dept name order lost
v.sort_by_key(|r| r.name); v.sort_by_key(|r| r.dept);          // FIX: stable preserves prior order
```
**Tooling:** `stable_sort_primitive` (Clippy **pedantic**, allow) only suggests the *unstable* (perf) direction. Manual.
> — [std slice::sort](https://doc.rust-lang.org/std/primitive.slice.html#method.sort) · [std slice::sort_unstable](https://doc.rust-lang.org/std/primitive.slice.html#method.sort_unstable)

### 9.7 `retain` keeps where the predicate is `true`

std `Vec::retain` keeps elements where `f(&e)` returns `true`. The common bug is writing the predicate as "should be removed" (inverted), deleting the wrong half.

**Violation → Fix:**
```rust
v.retain(|x| x.is_expired());  // BUG: keeps expired, drops valid (inverted)
v.retain(|x| !x.is_expired()); // FIX
```
**Tooling:** No lint (semantic). Manual.
> — [std Vec::retain](https://doc.rust-lang.org/std/vec/struct.Vec.html#method.retain)

### 9.8 Combinator order / init

`it.take(10).skip(20)` yields nothing; `it.skip(20).take(10)` paginates. `step_by(0)` panics. `fold(0, *)` is always 0; `fold(1, +)` skips the implicit zero.

**Violation → Fix:**
```rust
let page = it.take(10).skip(20);          // BUG: takes 10, then skips 20 → empty
let page = it.skip(20).take(10);          // FIX
let prod = xs.iter().fold(0, |a,&x| a*x); // BUG: starts at 0 → always 0
let prod = xs.iter().fold(1, |a,&x| a*x); // FIX
```
**Tooling:** `map_flatten` (Clippy **complexity**, warn) for `.map(..).flatten()`. `iterator_step_by_zero` (Clippy **correctness**, deny) for `step_by(0)`. Order/init logic: manual.
> — [std Iterator::skip](https://doc.rust-lang.org/std/iter/trait.Iterator.html#method.skip) · [std Iterator::fold](https://doc.rust-lang.org/std/iter/trait.Iterator.html#method.fold) · [Clippy: iterator_step_by_zero](https://rust-lang.github.io/rust-clippy/master/index.html#iterator_step_by_zero)

---

## Cross-Cutting Notes

- **Debug vs release is the master footgun.** Overflow (1.2, 2.1, 2.5) and `Iterator::sum` (4.6) panic in debug but **silently corrupt in release**. State explicitly that passing tests in debug does not clear release; recommend `[profile.release] overflow-checks = true` where the cost is acceptable.
- **rustc deny-by-default lints already on:** `arithmetic_overflow`, `unconditional_panic`, `overflowing_literals`, `invalid_atomic_ordering` (≥1.56). They catch only **provably constant** cases — runtime variants are this audit's job.
- **Clippy `correctness` is deny-by-default and curated false-positive-free** ("if you see a `correctness` lint, the code is outright wrong"); `suspicious` is warn-by-default. The highest-value casting/panic lints (`cast_possible_truncation`, `unwrap_used`, `indexing_slicing`, `float_cmp`, `arithmetic_side_effects`) are `pedantic`/`restriction` and **allow-by-default** — recommending they be enabled is itself an audit action.
- **Edition-sensitive:** 5.2 (Rust 2024 `if let`/tail-expr temporary scope narrowing).
- **Version-pinned:** float→int saturation (1.45, §2.3); `invalid_atomic_ordering` (1.56, §7.4); `f64::total_cmp` (1.62, §9.4); `thread::scope` (1.63, §7.7). Check the crate's MSRV before asserting these.
- **Unverified wording caveat:** `std::sync::Mutex` re-entrancy — the primary statement is "unspecified … will not return on the second call (it might panic or deadlock)." Do not assert "guaranteed deadlock."

---

## Sources

**The Rust Reference** — [operator-expr (overflow / numeric cast / division / lazy boolean)](https://doc.rust-lang.org/reference/expressions/operator-expr.html) · [range-expr](https://doc.rust-lang.org/reference/expressions/range-expr.html) · [match-expr](https://doc.rust-lang.org/reference/expressions/match-expr.html) · [if-expr](https://doc.rust-lang.org/reference/expressions/if-expr.html#if-let-expressions) · [destructors / drop order / temporary scopes](https://doc.rust-lang.org/reference/destructors.html)

**The Rust Book** — [shadowing](https://doc.rust-lang.org/book/ch03-01-variables-and-mutability.html#shadowing) · [shared-state concurrency](https://doc.rust-lang.org/book/ch16-03-shared-state.html) · [reference cycles](https://doc.rust-lang.org/book/ch15-06-reference-cycles.html)

**Edition Guide** — [2024 if let temporary scope](https://doc.rust-lang.org/edition-guide/rust-2024/temporary-if-let-scope.html)

**std** — [Option](https://doc.rust-lang.org/std/option/enum.Option.html) · [Result](https://doc.rust-lang.org/std/result/enum.Result.html) · [Vec](https://doc.rust-lang.org/std/vec/struct.Vec.html) · [slice](https://doc.rust-lang.org/std/primitive.slice.html) · [str](https://doc.rust-lang.org/std/primitive.str.html) · [f64](https://doc.rust-lang.org/std/primitive.f64.html) · [RefCell](https://doc.rust-lang.org/std/cell/struct.RefCell.html) · [Mutex](https://doc.rust-lang.org/std/sync/struct.Mutex.html) · [PoisonError](https://doc.rust-lang.org/std/sync/struct.PoisonError.html) · [Condvar](https://doc.rust-lang.org/std/sync/struct.Condvar.html) · [mpsc](https://doc.rust-lang.org/std/sync/mpsc/index.html) · [atomic::Ordering](https://doc.rust-lang.org/std/sync/atomic/enum.Ordering.html) · [Iterator](https://doc.rust-lang.org/std/iter/trait.Iterator.html) · [mem::forget/take/replace](https://doc.rust-lang.org/std/mem/fn.forget.html) · [BufWriter](https://doc.rust-lang.org/std/io/struct.BufWriter.html) · [process::exit](https://doc.rust-lang.org/std/process/fn.exit.html) · [thread::spawn/scope](https://doc.rust-lang.org/std/thread/fn.scope.html) · [Rc::Weak](https://doc.rust-lang.org/std/rc/struct.Weak.html) · [HashMap](https://doc.rust-lang.org/std/collections/struct.HashMap.html)

**Nomicon** — [atomics / memory ordering](https://doc.rust-lang.org/nomicon/atomics.html)

**rustc lint lists** — [deny-by-default](https://doc.rust-lang.org/rustc/lints/listing/deny-by-default.html) · [warn-by-default](https://doc.rust-lang.org/rustc/lints/listing/warn-by-default.html)

**Clippy** — [master index](https://rust-lang.github.io/rust-clippy/master/index.html) · [lint categories (correctness deny / suspicious warn / pedantic·restriction·nursery·cargo allow)](https://doc.rust-lang.org/clippy/lints.html). Every Clippy lint cited above was verified for name, group, and default level against the rust-clippy `master` source (the rendered master index is JS-rendered and has known group/level errors). `undropped_manually_drops` is **not** a Clippy lint — it was uplifted to a rustc deny-by-default lint and is cited as such above.

**tokio / async** — [Runtime](https://docs.rs/tokio/latest/tokio/runtime/struct.Runtime.html) · [task::spawn / JoinHandle](https://docs.rs/tokio/latest/tokio/task/struct.JoinHandle.html) · [spawn_blocking / blocking-and-yielding](https://docs.rs/tokio/latest/tokio/task/index.html#blocking-and-yielding) · [select!](https://docs.rs/tokio/latest/tokio/macro.select.html) · [std future::Future — futures do nothing unless polled](https://doc.rust-lang.org/std/future/trait.Future.html)

**Secondary (corroborating only)** — [Rust 1.45 release notes — float-cast saturation](https://blog.rust-lang.org/2020/07/16/Rust-1.45.0.html)
