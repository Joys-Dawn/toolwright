# Rust Security Audit — Reference

Failure mode, the exact UB/security mechanism, vulnerable→safe code, severity, tooling, and primary-source citation for every domain in `SKILL.md`. Every UB claim traces to the Rust Reference "Behavior considered undefined" page, The Rustonomicon, or a std `# Safety` section, quoted by clause. RUSTSEC IDs are cited with their CVE. Severity uses the SKILL.md's four tiers (Critical / High / Medium / Low); escalation conditions are stated inline.

**Authority discipline (the master distinction).** `unsafe` does not relax the rules:

> *"Rust code is incorrect if it exhibits any of the behaviors in the following list. This includes code within `unsafe` blocks and `unsafe` functions. `unsafe` only means that avoiding undefined behavior is on the programmer; it does not change anything about the fact that Rust programs must never cause undefined behavior."* The list is explicitly **not exhaustive**: *"it may grow or shrink. There is no formal model of Rust's semantics…"*
> — [Reference: Behavior considered undefined](https://doc.rust-lang.org/reference/behavior-considered-undefined.html)

**Confirming-evidence rule.** For any UB finding, prefer **Miri** as the confirming evidence and cite the exact Reference/Nomicon/std clause. Clippy `restriction`/`pedantic` lints are *signals to enable and review*, not proof of a bug; **never report "Clippy clean" as "sound."** Never assert a construct is UB on a secondary source (blog / Stacked-Borrows write-up) alone. Lints attributed to **rustc** are built-in compiler lints, not Clippy. Clippy group/level were verified against the static versioned snapshot `rust-clippy/rust-1.86.0/index.html`; the `master` index is JS-rendered and not fetchable as data, so groups/levels are historically stable but should be re-verified on the project's toolchain.

**The memory-safety inversion.** The generic `agentwright:security-audit` hard-excludes Rust memory-safety ("buffer overflows, use-after-free … are impossible"). That is correct for *safe* Rust and **wrong for `unsafe`/FFI Rust** — `unsafe` soundness and UB are precisely this skill's core domain (Dimensions 1–3). Safe-Rust-only memory-safety claims remain out of scope.

**Edition/version gates flagged inline.** `mem::uninitialized`/`zeroed` deprecated 1.39; `&raw const`/`&raw mut` operators 1.82 (the `addr_of!`/`addr_of_mut!` macros they replace are 1.51); `extern "C-unwind"` stable 1.71; `unsafe_op_in_unsafe_fn` warn-by-default in edition 2024; `static_mut_refs` `deny` by default in edition 2024 (warn in 2021). Check `Cargo.toml` edition/MSRV before asserting a lint level.

---

## 1. `unsafe` Block Soundness & UB (core)

The Reference UB-list preamble (quoted above) governs this entire dimension and should anchor the skill's rationale. The list is non-exhaustive; absence from it is not a soundness proof.

### 1.1 Data races

A data race is **immediate UB** and the first bullet of the UB list. Safe Rust cannot produce one; it is reachable only through `unsafe` — raw pointers, `static mut`, or an unsound `unsafe impl Send`/`Sync`. The Nomicon's `Send`/`Sync` machinery is what normally prevents it.

**Vulnerable → Safe:**
```rust
static mut COUNTER: u64 = 0;
unsafe { COUNTER += 1; }                                // BUG: concurrent → data-race UB (torn read/write)
static COUNTER: AtomicU64 = AtomicU64::new(0);
COUNTER.fetch_add(1, Ordering::Relaxed);                // FIX
```
**Severity:** Critical — UB; classic memory-corruption / torn-read primitive.
**Tooling:** **Miri** detects the race when the racing schedule is exercised; **TSan** (`RUSTFLAGS="-Zsanitizer=thread"`, nightly) at runtime. rustc `static_mut_refs` flags the common `static mut` vector. Clippy does not detect data races directly.
> — [Reference: Behavior considered undefined](https://doc.rust-lang.org/reference/behavior-considered-undefined.html) · [Nomicon: Send and Sync](https://doc.rust-lang.org/nomicon/send-and-sync.html)

### 1.2 Dereferencing dangling / out-of-bounds / misaligned places

*"Accessing (loading from or storing to) a place that is dangling or based on a misaligned pointer"* is UB. A pointer is dangling if *"not all of the bytes it points to are part of the same live allocation"*; alignment is the **pointer's type's**, not the field's. UB occurs only on **load/store** — `&raw const`/`&raw mut` on a misaligned/packed place is allowed; taking `&`/`&mut` is not. For ZST/zero-length, the pointer is "trivially never dangling," but `slice::from_raw_parts` still requires non-null + aligned (use `NonNull::dangling()`).

**Vulnerable → Safe:**
```rust
let r = &*(0x1 as *const i32);                          // BUG: fabricated dangling/unaligned reference (UB)
let v = (&raw const packed.field).read_unaligned();     // FIX: never &packed.field; raw + read_unaligned
```
**Severity:** Critical — UB / memory unsafety.
**Tooling:** **Miri** reliably detects dangling/misaligned/ZST-provenance accesses on exercised paths. Clippy `cast_ptr_alignment` (pedantic, allow) flags `ptr as *T` that increases alignment. **ASan** catches some OOB/dangling at runtime.
> — [Reference: dangling pointers](https://doc.rust-lang.org/reference/behavior-considered-undefined.html#dangling-pointers) · [std slice::from_raw_parts](https://doc.rust-lang.org/std/slice/fn.from_raw_parts.html)

### 1.3 Breaking pointer aliasing rules (`&`/`&mut` uniqueness)

*"`&T` must point to memory that is not mutated while they are live (except for data inside an `UnsafeCell<U>`), and `&mut T` must point to memory that is not read or written by any pointer not derived from the reference and that no other reference points to while they are live."* The exact model (Stacked/Tree Borrows) is undecided but the principle is binding: the optimizer assumes `&mut` is unaliased and reorders/elides accordingly — *"writes are the primary hazard."* Two live `&mut` to one place, or `&T` aliasing `&mut T`, → silent miscompilation.

**Vulnerable → Safe:**
```rust
let a = &mut *p; let b = &mut *p;                        // BUG: two live &mut to one place → UB
let (a, b) = slice.split_at_mut(mid);                    // FIX: disjoint splits, or UnsafeCell/Cell/RefCell
```
**Severity:** Critical — UB; silent miscompilation.
**Tooling:** **Miri** (default Stacked Borrows or `-Zmiri-tree-borrows`) is the primary detector on exercised paths. Clippy `mut_from_ref` (**correctness, deny**) flags one specific pattern: an `unsafe fn` returning `&mut` derived from a `&` argument. No general-aliasing lint.
> — [Reference: Behavior considered undefined](https://doc.rust-lang.org/reference/behavior-considered-undefined.html) · [Nomicon: Aliasing](https://doc.rust-lang.org/nomicon/aliasing.html). *(Stacked/Tree Borrows write-ups are intuition only — not the normative model.)*

### 1.4 Producing an invalid value

*"Producing an invalid value … happens any time a value is assigned to or read from a place, passed to a function/primitive operation or returned."* Per-type validity: `bool` ∈ {0,1}; `fn` pointer non-null; `char` not a surrogate `0xD800..=0xDFFF` and `<= char::MAX`; `!` never exists; integers/floats/raw pointers initialized; an `enum` has a valid discriminant with all variant fields valid; references/`Box<T>` aligned, non-null, non-dangling, pointing to a valid value; wide-pointer metadata matches; `NonNull`/`NonZero` in their custom range. *"Uninitialized memory is also implicitly invalid for any type that has a restricted set of valid values."*

**Vulnerable → Safe:**
```rust
let b: bool = unsafe { mem::transmute(2u8) };           // BUG: 2 is not a valid bool (UB)
let c: char = unsafe { mem::transmute(0x110000u32) };   // BUG: > char::MAX (UB)
let b = byte == 1;  let c = char::from_u32(x).ok_or(..)?; // FIX: validate
```
**Severity:** Critical — UB.
**Tooling:** **Miri** detects invalid-value production (including invalid discriminants / niche violations) on exercised paths. Clippy `transmute_int_to_bool`, `transmute_int_to_char`, `transmuting_null`, `invalid_null_ptr_usage` (restriction, allow); `char_lit_as_u8` (complexity, **warn**).
> — [Reference: Behavior considered undefined (validity list)](https://doc.rust-lang.org/reference/behavior-considered-undefined.html)

### 1.5 Reading uninitialized memory; `mem::uninitialized`/`zeroed` vs `MaybeUninit`

All runtime memory begins uninitialized; *"Attempting to interpret this memory as a value of any type will cause Undefined Behavior."* `mem::uninitialized()`/`zeroed()` for a type whose bit pattern is invalid is UB at the **point of creation**, regardless of later use — *"it is undefined behavior to have uninitialized data in a variable even if that variable has an integer type."* Both are **deprecated since 1.39** in favor of `MaybeUninit`; `MaybeUninit::assume_init` is UB if the value is not fully initialized and valid.

**Vulnerable → Safe:**
```rust
let x: i32 = unsafe { mem::uninitialized() };           // BUG: uninit value created (UB), deprecated 1.39
let mut m = MaybeUninit::<i32>::uninit();
m.write(compute()); let x = unsafe { m.assume_init() }; // FIX: init fully, then assume_init
```
**Severity:** Critical — UB.
**Tooling:** **Miri** detects uninit reads on exercised paths. Clippy `uninit_assumed_init`/`uninit_vec` (correctness — verify level on target toolchain). The `mem::uninitialized` deprecation surfaces as rustc `deprecated`.
> — [std MaybeUninit](https://doc.rust-lang.org/std/mem/union.MaybeUninit.html) · [Nomicon: Uninitialized Memory](https://doc.rust-lang.org/nomicon/uninitialized.html)

### 1.6 `transmute` — size/validity/lifetime, `&`→`&mut`, fat pointers

`mem::transmute<T,U>`'s only static check is `size_of::<T>() == size_of::<U>()`. *"Both the argument and the result must be valid at their given type."* Nomicon rules: never transmute an invalid bit pattern; **"Transmuting an `&` to `&mut` is always Undefined Behavior"**; transmuting to a reference without an explicit lifetime yields an **unbounded lifetime** (a lifetime-extension hole); compound→compound requires identical layout (don't transmute non-`#[repr(C)]` structs). Integer→pointer transmute is largely unspecified, and dereferencing a pointer produced that way is undefined behavior under Rust's pointer-provenance model — use an `as` cast or the `std::ptr` provenance APIs, not `transmute`.

**Vulnerable → Safe:**
```rust
let m: &mut T = unsafe { mem::transmute(shared_ref) };  // BUG: &→&mut is ALWAYS UB
// FIX: redesign with UnsafeCell/Cell/RefCell; for ptr reinterpret use ptr.cast(); bytes via from_ne_bytes
```
**Severity:** Critical — UB; *"the absolute last resort … incredibly unsafe."*
**Tooling:** **Miri** detects the resulting invalid-value/aliasing UB (the transmute itself is not flagged; the bad value/access is). Clippy `transmute_ptr_to_ref`, `transmute_int_to_bool`, `transmute_int_to_char`, `transmute_undefined_repr`, `transmute_num_to_bytes` (restriction, allow); `wrong_transmute` (correctness — verify on toolchain).
> — [Nomicon: Transmutes](https://doc.rust-lang.org/nomicon/transmutes.html) · [std mem::transmute](https://doc.rust-lang.org/std/mem/fn.transmute.html) · [Nomicon: Unbounded Lifetimes](https://doc.rust-lang.org/nomicon/unbounded-lifetimes.html)

### 1.7 Violating library type invariants

`unsafe` constructors bypass validation that the rest of std relies on:
- `Vec::set_len(n)`: caller must ensure `n <= capacity` **and** elements `old_len..n` are initialized.
- `String::from_utf8_unchecked`: *"unsafe because it does not check that the bytes … are valid UTF-8 … it may cause memory unsafety issues with future users of the `String`, as the rest of the standard library assumes that `String`s are valid UTF-8."*
- `slice::from_raw_parts`: non-null, aligned (even ZST/zero-len), valid for `len * size_of::<T>()` bytes within **one allocation**, `len` initialized values, not mutated for `'a`, total `<= isize::MAX`.
- `NonNull::new_unchecked(0)` / `NonZero::*_unchecked(0)`: producing the niche value is invalid-value UB (Dim 1.4).

**Vulnerable → Safe:**
```rust
unsafe { v.set_len(n); }                                 // BUG: elements 0..n uninitialized → UB
String::from_utf8_unchecked(untrusted)                   // BUG: non-UTF-8 String → downstream memory unsafety
v.spare_capacity_mut()… write … unsafe { v.set_len(n) }; // FIX
str::from_utf8(untrusted)?                                // FIX
```
**Severity:** Critical — UB / memory unsafety (incl. non-UTF-8 `str`: std states downstream memory unsafety).
**Tooling:** **Miri** detects the resulting OOB/uninit/invalid value on exercised paths. Clippy `missing_safety_doc` (**style, warn — default-on**, fires on a `pub unsafe fn` without a `# Safety` doc); `undocumented_unsafe_blocks`, `not_unsafe_ptr_arg_deref` (restriction, allow — enable explicitly).
> — [std Vec::set_len](https://doc.rust-lang.org/std/vec/struct.Vec.html#method.set_len) · [std String::from_utf8_unchecked](https://doc.rust-lang.org/std/string/struct.String.html#method.from_utf8_unchecked) · [std slice::from_raw_parts](https://doc.rust-lang.org/std/slice/fn.from_raw_parts.html)

### 1.8 `// SAFETY:` documentation discipline (cross-cutting)

Every `unsafe` block needs a `// SAFETY:` comment proving its preconditions; every `unsafe fn` needs a `# Safety` doc. Edition 2024: `unsafe_op_in_unsafe_fn` is warn-by-default — `unsafe` ops inside an `unsafe fn` still need an explicit `unsafe {}` block. Absence of a safety comment is not itself UB, but it is a strong signal that 1.1–1.7 were not reasoned through.

**Vulnerable → Safe:**
```rust
unsafe { ptr.add(off).write(v) }                          // BUG (Low/Medium): no // SAFETY: justification
// SAFETY: off < len (checked above); ptr is valid for len writes of T; aligned per alloc.
unsafe { ptr.add(off).write(v) }                          // FIX
```
**Severity:** Low (the discipline itself); Medium for undocumented `unsafe` touching pointers/lifetimes/FFI.
**Tooling:** Clippy `missing_safety_doc` (**style, warn — default-on**); `undocumented_unsafe_blocks`, `multiple_unsafe_ops_per_block`, `unnecessary_safety_comment` (restriction, allow — must be enabled). rustc `unsafe_op_in_unsafe_fn` (edition-2024 default warn).
> — [Clippy lint list](https://rust-lang.github.io/rust-clippy/rust-1.86.0/index.html) · [RFC 2585: unsafe-block-in-unsafe-fn](https://rust-lang.github.io/rfcs/2585-unsafe-block-in-unsafe-fn.html)

---

## 2. `Send`/`Sync` & Concurrency Unsafety

### 2.1 Unsound hand-written `unsafe impl Send`/`Sync`

`Send`/`Sync` are **unsafe traits**; *"Incorrectly implementing Send or Sync can cause Undefined Behavior."* They auto-derive when all fields qualify. A sound hand-impl requires no unsynchronized shared mutable state across threads, the correct generic bound (`unsafe impl<T: Send> … {}`), and a `// SAFETY:` proof. The Nomicon's `Carton` example: `Sync` needs `T: Sync` because a public `&Carton → &T` path exists.

**Vulnerable → Safe:**
```rust
struct W(*mut T); unsafe impl Send for W {}             // BUG: no T: Send bound, no proof → data race in safe code
unsafe impl<T: Send> Send for W<T> {}                    // FIX: correct bound + // SAFETY: unique-ownership proof
// or: wrap in Arc<Mutex<T>> and delete the manual impl
```
**Severity:** Critical — the only way besides raw `unsafe` to get a data race in otherwise-"safe" Rust; converts safe call sites into UB.
**Tooling:** **No Clippy/Miri lint can prove a manual `Send`/`Sync` correct — this is a manual-review must.** Miri catches the *resulting* race only if a racing schedule is exercised. Flag every `unsafe impl Send`/`Sync` lacking a `// SAFETY:` and (for generics) a bound.
> — [Nomicon: Send and Sync](https://doc.rust-lang.org/nomicon/send-and-sync.html)

### 2.2 Sending `Rc` / raw pointers across threads via a wrong impl

`Rc` is neither `Send` nor `Sync` *"because the refcount is shared and unsynchronized"*; raw pointers are neither. Forcing `Send` onto a type containing `Rc` and moving it to another thread races the non-atomic refcount → use-after-free / double-free.

**Vulnerable → Safe:**
```rust
struct S(Rc<T>); unsafe impl Send for S {}              // BUG: refcount race → UAF/double-free
struct S(Arc<T>);                                        // FIX: atomic refcount; remove the manual impl
```
**Severity:** Critical — UB (data race on the refcount → memory corruption).
**Tooling:** Without a bad `unsafe impl` the compiler rejects this (good). With one: manual review + Miri (race must be exercised).
> — [Nomicon: Send and Sync](https://doc.rust-lang.org/nomicon/send-and-sync.html)

### 2.3 `static mut` aliasing / concurrent access

*"Merely taking such a reference in violation of Rust's mutability XOR aliasing requirement has always been instantaneous undefined behavior, even if the reference is never read from or written to."* Edition 2024: `static_mut_refs` is **`deny` by default** (warn in 2021).

**Vulnerable → Safe:**
```rust
static mut S: T = …; let r = unsafe { &mut S };         // BUG: instantaneous UB on the reference itself
static S: Mutex<T> = …;                                  // FIX (or AtomicU*/SyncUnsafeCell)
let p = &raw mut S;                                      // FIX (&raw operator 1.82+; addr_of_mut! for 1.51): no reference; confine unsafe + // SAFETY:
```
**Severity:** Critical — instantaneous UB; trivially a data race under threads.
**Tooling:** rustc `static_mut_refs` (warn 2021 / **deny 2024**). **Miri** detects the aliasing/race on exercised paths.
> — [Edition 2024: static mut references](https://doc.rust-lang.org/edition-guide/rust-2024/static-mut-references.html) · [Reference: Behavior considered undefined](https://doc.rust-lang.org/reference/behavior-considered-undefined.html)

### 2.4 Interior mutability without synchronization across threads

`UnsafeCell` is not `Sync` (so `Cell`/`RefCell` aren't). Mutating through a shared reference is legal only via `UnsafeCell` (or its safe wrappers); concurrent unsynchronized mutation is a data race. Mutating immutable bytes is itself UB: *"the bytes pointed to by a shared reference … are immutable"* unless inside `UnsafeCell`.

**Vulnerable → Safe:**
```rust
struct S(RefCell<T>); unsafe impl Sync for S {}         // BUG: cross-thread RefCell → data-race UB
struct S(Mutex<T>);                                      // FIX (or RwLock/atomics); remove the manual impl
```
**Severity:** Critical — data-race UB (or mutating-immutable-bytes UB).
**Tooling:** Compiler rejects without a bad `unsafe impl Sync`; otherwise manual review + Miri.
> — [Nomicon: Send and Sync](https://doc.rust-lang.org/nomicon/send-and-sync.html) · [Reference: Behavior considered undefined](https://doc.rust-lang.org/reference/behavior-considered-undefined.html)

---

## 3. FFI Safety

### 3.1 Unwinding (panic / foreign exception) across a non-`-unwind` ABI

UB list: *"unwinding past a stack frame that does not allow unwinding (e.g. by calling a `"C-unwind"` function imported or transmuted as a `"C"` function …)."* A Rust `panic` crossing `extern "C"` aborts the process — a **defined** behavior since Rust 1.81 (uncaught panics in `extern "C"` functions abort; before 1.81 this was undefined behavior) — but *"A foreign exception entering Rust will cause undefined behavior."* `extern "C-unwind"` (stable 1.71) is the correct ABI when unwinding must cross. `catch_unwind` *"will only catch unwinding panics, not those that abort the process"* — useless under `panic = "abort"`.

**Vulnerable → Safe:**
```rust
#[no_mangle] pub extern "C" fn cb() { may_panic(); }    // BUG: panic→abort (DoS); foreign exception in → UB
#[no_mangle] pub extern "C" fn cb() -> i32 {
    std::panic::catch_unwind(|| { may_panic(); 0 }).unwrap_or(-1) }  // FIX (or extern "C-unwind")
```
**Severity:** Critical — UB (foreign exception into Rust); the abort path is *defined* but a DoS if unintended (Dim 8.1).
**Tooling:** No lint detects "this `extern "C"` fn can panic." Manual review of every `extern` fn body for panic sources. Miri does not model foreign code. Clippy `unwrap_used`/`expect_used`/`panic`/`indexing_slicing` (restriction, allow) help find panic sources if enabled.
> — [Nomicon: FFI](https://doc.rust-lang.org/nomicon/ffi.html) · [std panic::catch_unwind](https://doc.rust-lang.org/std/panic/fn.catch_unwind.html) · [Reference: Behavior considered undefined](https://doc.rust-lang.org/reference/behavior-considered-undefined.html)

### 3.2 `#[repr(C)]` / layout mismatch with the C side

*"Rust guarantees that the layout of a `struct` is compatible with the platform's representation in C only if the `#[repr(C)]` attribute is applied."* Passing a default-`repr(Rust)` struct (unspecified field order/padding), or a Rust declaration whose types/sizes differ from C, is wrong-signature UB. The compiler **cannot** check foreign declarations — *"specifying it correctly is part of keeping the binding correct at runtime."*

**Vulnerable → Safe:**
```rust
struct Pt { x: i32, y: i32 }  extern "C" { fn f(p: Pt); } // BUG: repr(Rust) layout across FFI → UB
#[repr(C)] struct Pt { x: i32, y: i32 }                   // FIX: prefer bindgen-generated bindings
```
**Severity:** Critical — wrong-ABI/signature UB / memory corruption.
**Tooling:** rustc `improper_ctypes` / `improper_ctypes_definitions` (warn-by-default) catch many non-FFI-safe types in `extern` signatures. `bindgen` reduces hand-error. Not a Clippy domain.
> — [Nomicon: FFI](https://doc.rust-lang.org/nomicon/ffi.html) · [Reference: Behavior considered undefined](https://doc.rust-lang.org/reference/behavior-considered-undefined.html)

### 3.3 `CString`/`CStr` interior NUL, ownership, double-free, leak

`CString::new` rejects interior NUL. `into_raw` transfers ownership to C — *"one should not use the standard C `free()`… Failure to call `CString::from_raw` will lead to a memory leak."* `from_raw` `# Safety`: only on a pointer from `into_raw`; *"A double-free may occur if the function is called twice"*; taking ownership of foreign-allocated memory *"is likely to lead to undefined behavior or allocator corruption."* Assuming a C `*const c_char` is UTF-8/NUL-terminated when it is not is UB (invalid `str` / OOB read).

**Vulnerable → Safe:**
```rust
libc::free(cstr.into_raw() as *mut _);                   // BUG: wrong allocator → corruption/UB
let _ = unsafe { CString::from_raw(p) };                 // FIX: reclaim with Rust's allocator
unsafe { CStr::from_ptr(p) }.to_str()?                   // FIX: validate UTF-8 (not _unchecked)
```
**Severity:** Critical — double-free / allocator corruption / UB; the leak-only path is Medium (resource exhaustion).
**Tooling:** Miri (Rust side only) catches the double-free if both `from_raw` calls are exercised in a Rust harness. Manual review of ownership transfer. No specific Clippy lint.
> — [std ffi::CString](https://doc.rust-lang.org/std/ffi/struct.CString.html)

### 3.4 `#[no_mangle]` symbol clashes / null function pointers

`#[no_mangle]` exports an unmangled symbol; collisions across crates or with libc produce wrong-function calls (effectively wrong-ABI UB). Reference validity: *"A `fn` pointer value must be non-null"* — a null `extern fn` is invalid-value UB when produced/called.

**Vulnerable → Safe:**
```rust
#[no_mangle] pub extern "C" fn init() { … }             // BUG: generic name → cross-crate/libc clash
#[no_mangle] pub extern "C" fn mylib_init() { … }        // FIX: namespace the symbol
cb: Option<extern "C" fn()>  // model the null case as None, check before calling   // FIX
```
**Severity:** Critical — wrong-symbol call / null-fn-pointer = UB.
**Tooling:** Linker diagnostics for duplicate symbols; no Clippy/Miri. Manual review.
> — [Reference: Behavior considered undefined](https://doc.rust-lang.org/reference/behavior-considered-undefined.html) · [Nomicon: FFI](https://doc.rust-lang.org/nomicon/ffi.html)

---

## 4. Supply Chain & Dependencies

### 4.1 Known-vulnerable / yanked dependency (RustSec + `cargo audit`)

The **RustSec Advisory Database** tracks advisories against crates.io crates (IDs `RUSTSEC-YYYY-NNNN`, exported to OSV). `cargo audit` scans `Cargo.lock` for crates with known `vulnerability` advisories (and yanked crates).

**Vulnerable → Safe:** dependency tree containing `lz4-sys = 1.9.3` → bump to `>= 1.9.4`; add `cargo audit` / `cargo deny check advisories` as a CI gate.

**Severity:** Critical when a `vulnerability`-class advisory matches a resolved version; Medium for `yanked` with no advisory.
**Tooling:** `cargo audit`, `cargo deny check advisories`. No Clippy/Miri.
> — [RustSec](https://rustsec.org/) · [RUSTSEC-2022-0051 — lz4-sys ≤ 1.9.3, "Memory corruption in liblz4", CVE-2021-3520, CVSS 9.8, patched ≥ 1.9.4 (verified live)](https://rustsec.org/advisories/RUSTSEC-2022-0051.html)

### 4.2 Unmaintained / unsound / notice (RustSec informational)

RustSec separates **vulnerability** advisories from **informational** kinds: **unmaintained** (no longer actively maintained), **unsound** (a memory-safety hole reachable from safe Rust), **notice** (lower-confidence awareness). The index categorizes by label, not formal prose — state this nuance rather than quoting a definition.

**Severity:** `unsound` → High (latent soundness hazard) — **Critical** if you can show a safe trigger path in the audited code; `unmaintained`/`notice` → Medium (supply-chain risk).
**Tooling:** `cargo deny check advisories` with `unmaintained`/`unsound`/`notice` configured; `cargo audit --deny unmaintained`.
> — [RustSec advisory index](https://rustsec.org/advisories/)

### 4.3 `cargo deny` — bans, sources, licenses

`cargo deny` runs the RustSec advisories check **plus**: `bans` (forbidden / duplicate / wildcard deps), `sources` (only approved registries/git — blocks unexpected git/`[patch]`), `licenses` (allow/deny set). Source-pinning and ban checks mitigate dependency-confusion / unexpected upstream.

**Severity:** Medium (supply-chain hardening / policy).
**Tooling:** `cargo deny check {advisories,bans,sources,licenses}`.
> — [cargo-deny book](https://embarkstudios.github.io/cargo-deny/checks/advisories/index.html)

### 4.4 `build.rs` / proc-macros execute arbitrary code at build time

Build scripts and proc-macros run with developer/CI privileges during `cargo build` — **before any test runs**. A malicious or compromised dependency (incl. transitive, incl. typosquat) is build-time RCE. This is the dominant Rust supply-chain threat.

**Severity:** Medium (build-time RCE risk) — escalate to **Critical** if a specific advisory implicates a present `build.rs`/proc-macro crate.
**Tooling:** `cargo audit`/`cargo deny` (advisories on the offending crate); `cargo vet`/`cargo crev` (human trust attestations, incl. build deps); `cargo geiger` (counts `unsafe` per dep — audit-surface proxy, not a vuln scanner). Review `build.rs` of unfamiliar crates; pin versions; commit `Cargo.lock`.
> — [RustSec](https://rustsec.org/) · [cargo-deny book](https://embarkstudios.github.io/cargo-deny/checks/advisories/index.html)

### 4.5 `Cargo.lock`, version ranges, `[patch]`/git pinning

Convention: **commit `Cargo.lock` for binaries** (reproducible, audited builds); libraries typically do not. Broad SemVer ranges + non-committed lock can silently pull a freshly-vulnerable patch. `[patch]`/git deps without a pinned `rev` track a moving branch (unaudited upstream).

**Severity:** Medium (hygiene) — **Critical** if it admits a known-vuln version.
**Tooling:** `cargo audit` reads `Cargo.lock`; `cargo deny` `bans` (wildcard) / `sources` (git pinning); `cargo +nightly -Zminimal-versions` tests the true minimum.
> — [Cargo FAQ — lockfile guidance](https://doc.rust-lang.org/cargo/faq.html) · [cargo-deny book](https://embarkstudios.github.io/cargo-deny/checks/advisories/index.html)

---

## 5. Deserialization & Untrusted Input

### 5.1 Unbounded recursion / stack overflow (`serde_json` and friends)

`serde_json` enforces a default recursion limit (**currently 128**, defined in the parser). With the `unbounded_depth` feature **and** `Deserializer::disable_recursion_limit()`, it will *"Parse arbitrarily deep JSON structures without any consideration for overflowing the stack"* — the docs say you must then provide your own protection (e.g. `serde_stacker`). `Value` + `IgnoredAny` depth has had stack-overflow issues (serde #3023) — depth bounding is still the caller's responsibility for `Value`.

**Vulnerable → Safe:**
```rust
let de = serde_json::Deserializer::from_str(input);
de.disable_recursion_limit();                            // BUG: attacker input → stack-overflow DoS
// FIX: keep the default 128, or wrap with serde_stacker, or cap input size/depth before parsing
```
**Severity:** Critical — unbounded recursion on attacker input is a remote DoS.
**Tooling:** No Clippy lint. `cargo fuzz` with a nested corpus reliably finds the crash. Manual review for `disable_recursion_limit`/`unbounded_depth`.
> — [serde_json Deserializer](https://docs.rs/serde_json/latest/serde_json/de/struct.Deserializer.html) *(the literal "128" is in the parser source / issue tracker, not the docs.rs API page — phrase as "currently 128"; serde-rs/json #162/#334, serde-rs/serde #3023 corroborate)*

### 5.2 Length-prefix allocation bomb (`bincode` and other binary formats)

`bincode`'s sequence/map deserializers take a `size_hint` straight from the input length prefix; a `Deserialize` impl feeding that to `Vec::with_capacity` pre-allocates an attacker-chosen size — *"all Bincode can do is blindly allocate."* A maximum-size **limit exists but is not on by default**. Same class affects `rmp`/`postcard`/`ciborium`.

**Vulnerable → Safe:**
```rust
bincode::deserialize(untrusted)                          // BUG: length prefix → memory-exhaustion DoS
// FIX: configure an explicit limit and/or cap the reader length before deserializing
// bincode 2.x: Configuration::with_limit ; bincode 1.x: Config::limit  (verify the resolved major)
```
**Severity:** Critical — memory-exhaustion DoS via one small malicious message.
**Tooling:** No Clippy lint. `cargo fuzz` finds it. Manual review: any `Deserialize` for untrusted input + length-prefixed format without a configured limit.
> — [bincode crate docs](https://docs.rs/crate/bincode/latest) *(method name differs 1.x vs 2.x — verify; bincode-org #345/#587, serde-rs/serde #744 are the authoritative format-behavior discussions)*

### 5.3 `Deserialize` bypassing a validating constructor

A type whose safe constructor enforces an invariant (`Percentage(0..=100)`, a `NonEmpty`, an in-range index) but which `#[derive(Deserialize)]`s field-by-field can be deserialized **directly into an invalid state**, skipping the constructor. If downstream `unsafe` later trusts that invariant (uses it as an unchecked index/length), this is a path to memory unsafety.

**Vulnerable → Safe:**
```rust
#[derive(Deserialize)] struct Id(u32);                   // BUG: skips Id::new validation
#[derive(Deserialize)] #[serde(try_from = "u32")] struct Id(u32);  // FIX: run the validating ctor
// + #[serde(deny_unknown_fields)] for strictness; never feed a derived int to get_unchecked/set_len unre-checked
```
**Severity:** Critical if a violated invariant feeds `unsafe` (UB); High if it only bypasses a security/logic check.
**Tooling:** No automated lint. Manual review: every `#[derive(Deserialize)]` on a type with a non-trivial validating constructor or safety invariant.
> — [serde derive (`try_from`/`deny_unknown_fields`)](https://serde.rs/) · [Reference validity rules (the `unsafe`-trust consequence)](https://doc.rust-lang.org/reference/behavior-considered-undefined.html)

### 5.4 `zerocopy` / `bytemuck` validity requirements

Zero-copy byte→type reinterpretation is sound only for types whose every bit pattern is valid (`bytemuck::Pod`, `zerocopy::FromBytes`). Reinterpreting attacker bytes as a restricted-validity type (`bool`, `char`, niche enum, `NonZero`, references) is invalid-value UB (Dim 1.4). The hazard is a hand-written `unsafe impl Pod`.

**Vulnerable → Safe:**
```rust
bytemuck::from_bytes::<MyEnum>(buf)                       // BUG: niche enum from attacker bytes → UB
// FIX: from_bytes only into #[derive(Pod)]-eligible all-bit-patterns-valid types; parse enums explicitly
```
**Severity:** Critical — invalid-value UB from untrusted bytes.
**Tooling:** `bytemuck`/`zerocopy` derive macros statically reject non-`Pod`/non-`FromBytes` types (compile-time guard). **Miri** catches the resulting invalid value on exercised paths. Manual review of any hand-written `unsafe impl bytemuck::Pod`.
> — [bytemuck docs](https://docs.rs/bytemuck/) · [Reference: Behavior considered undefined (validity list)](https://doc.rust-lang.org/reference/behavior-considered-undefined.html)

---

## 6. Cryptography & Secret Misuse

### 6.1 Non-constant-time comparison of secrets / MACs / tokens

`==`/`PartialEq` on `&[u8]` short-circuits on the first differing byte, leaking a prefix via timing — a practical MAC-forgery / token side channel. Use `subtle::ConstantTimeEq` (routes the result through a volatile read so the compiler cannot reintroduce a branch), `constant_time_eq`, or the library's `verify`. `subtle`'s docs caution *"side-channel resistance is not a property of software alone"* — constant-time is best-effort against the optimizer.

**Vulnerable → Safe:**
```rust
if computed_mac == received_mac { … }                    // BUG: timing oracle → forgery
if computed_mac.ct_eq(&received_mac).into() { … }         // FIX (subtle) / constant_time_eq / library verify
```
**Severity:** Critical — exploitable timing oracle (auth bypass / forgery).
**Tooling:** No Clippy lint detects "this `==` is on a secret." Manual review of equality on MAC/token/password/key bytes.
> — [subtle docs](https://docs.rs/subtle/latest/subtle/) · [constant_time_eq](https://docs.rs/constant_time_eq/)

### 6.2 Secrets lingering in memory

Rust does **not** zero memory on drop; freed key/password buffers persist (swap/core-dump/heap-reuse). `zeroize` *"guarantee[s] the operation will not be 'optimized away'"* via volatile writes. Caveat: the `Vec`/`String`/`CString` impls *"zeroize the entire capacity … but cannot guarantee copies of the data were not previously made by buffer reallocation"* — a grown/cloned secret has leaked copies `zeroize` can't reach. `Drop` is **not guaranteed** (`mem::forget`, abort, some panics).

**Vulnerable → Safe:**
```rust
let key: Vec<u8> = derive();   // dropped, not zeroed     // BUG: secret persists in freed memory
let key = Zeroizing::new(derive());                       // FIX (or secrecy::SecretBox); size buffers once, no clone/Debug
```
**Severity:** Medium (defense-in-depth; latent disclosure under memory-dump/swap) — **Critical** if combined with a memory-disclosure vuln.
**Tooling:** No lint. Manual review: secret types not wrapped in `zeroize`/`secrecy`; secret buffers that realloc or are cloned/`Debug`-printed.
> — [zeroize docs](https://docs.rs/zeroize/latest/zeroize/) · [secrecy docs](https://docs.rs/secrecy/)

### 6.3 RNG correctness — crypto vs non-crypto

For cryptographic randomness use an OS/CSPRNG: `getrandom` (*"We always prioritize failure over returning known insecure 'random' bytes"*), `OsRng`/`ThreadRng`, or `StdRng` (CSPRNG, ChaCha12). **Not crypto-secure:** `SmallRng` — *"Non-cryptographic: output is easy to predict (insecure)."* Fixed/low-entropy seeding is insecure — rand's `seed_from_u64` is documented as unsuitable for cryptography because the input size is only 64 bits. `rand` 0.8 vs 0.9 changed constructor names — verify against the resolved version.

**Vulnerable → Safe:**
```rust
let k = SmallRng::seed_from_u64(42).gen::<[u8;32]>();    // BUG: predictable key → full crypto break
let mut k = [0u8;32]; OsRng.fill_bytes(&mut k);           // FIX (or getrandom::getrandom(&mut k)?)
```
**Severity:** Critical — predictable keys/nonces/tokens = full crypto break.
**Tooling:** No Clippy lint. Manual review: `SmallRng`/`seed_from_u64`/`from_seed` with a constant, or any non-`OsRng`/`getrandom` source feeding key/nonce/token generation.
> — [rand SmallRng](https://docs.rs/rand/latest/rand/rngs/struct.SmallRng.html) · [rand StdRng](https://docs.rs/rand/latest/rand/rngs/struct.StdRng.html) · [getrandom](https://docs.rs/getrandom/latest/getrandom/)

### 6.4 Weak / broken primitives, nonce/IV reuse, ECB, hardcoded keys

MD5, SHA-1, `DefaultHasher`/`SipHasher` (not cryptographic), ECB mode, and **static/reused nonce or IV** are broken. AES-GCM / ChaCha20-Poly1305 nonce reuse is **catastrophic** — it leaks the authentication key (forgery) plus the XOR of plaintexts, not merely a confidentiality nick. Hardcoded keys in source are an immediate compromise. Rolling your own KDF/MAC/padding is a vuln by default.

**Vulnerable → Safe:**
```rust
let nonce = [0u8;12]; cipher.encrypt(&nonce, pt)?;       // BUG: reused nonce → auth-key leak (catastrophic)
let mut nonce = [0u8;12]; OsRng.fill_bytes(&mut nonce);  // FIX: unique random nonce per message
// (or a strict never-repeating counter per key; rotate keys before exhaustion). Replace MD5/SHA-1, ECB.
```
**Severity:** Critical — directly breaks confidentiality/integrity.
**Tooling:** No reliable Clippy lint. Manual review: literal/constant nonce/IV/key bytes; `Md5`/`Sha1`/`DefaultHasher` in a security path; ECB selectors. `cargo audit` additionally flags advisory-bearing crypto crates.
> — [aes-gcm docs](https://docs.rs/aes-gcm/) · [chacha20poly1305 docs](https://docs.rs/chacha20poly1305/) *(both document the unique-nonce requirement; nonce-reuse severity is standard AEAD cryptography)*

### 6.5 `unwrap()` on crypto results / decrypt-without-verify

`unwrap()`/`expect()` on a decryption/verification `Result` turns a failed tag check into a panic (DoS; UB across FFI, Dim 3.1). For AEAD, **decrypt-then-use without checking the tag** (or a non-AEAD mode without encrypt-then-MAC) is a chosen-ciphertext / padding-oracle vulnerability. AEAD `decrypt` returns `Err` on tag mismatch — handle it, never `unwrap`/ignore.

**Vulnerable → Safe:**
```rust
let pt = cipher.decrypt(&nonce, ct).unwrap();            // BUG: panic on tag fail; using pt = auth bypass
let pt = cipher.decrypt(&nonce, ct).map_err(|_| AuthError)?;  // FIX: use pt only on Ok
```
**Severity:** Critical — auth bypass / padding oracle; panic-on-tag-fail is Medium (DoS) or Critical across FFI.
**Tooling:** Clippy `unwrap_used`/`expect_used` (restriction, allow) if enabled. Manual review of every `decrypt`/`verify` call.
> — [aes-gcm docs](https://docs.rs/aes-gcm/) · [chacha20poly1305 docs](https://docs.rs/chacha20poly1305/) *(panic consequences: Dim 3.1 / 8.1)*

---

## 7. Command, Path & Resource Injection

### 7.1 `Command` shell injection

`std::process::Command` does **not** invoke a shell and passes `args` as a literal argv (the safe default — no metacharacter interpretation). The vuln is explicitly spawning a shell with interpolated input. Leaking the parent environment can also matter — `env_clear()` for sensitive subprocesses.

**Vulnerable → Safe:**
```rust
Command::new("sh").arg("-c").arg(format!("ls {dir}"))    // BUG: arbitrary command execution
Command::new("ls").arg(dir)                               // FIX: no shell; dir is one argv element
```
**Severity:** Critical — arbitrary command execution.
**Tooling:** No Clippy lint. Manual/grep review for `sh -c` / `cmd /C` / `bash -c` with interpolated input.
> — [std process::Command (documents the no-shell behavior)](https://doc.rust-lang.org/std/process/struct.Command.html)

### 7.2 Path traversal — `Path::join` absolute-replace, `..`, zip/tar slip, symlink TOCTOU

`Path::join` with an **absolute** argument **discards the base and returns the argument** (`base.join("/etc/passwd") == "/etc/passwd"`); `..` components escape. Archive extraction trusting entry paths is "zip/tar slip." `fs::canonicalize` + verifying the result stays under the intended prefix is required; even then a symlink swap between check and use is a TOCTOU.

**Vulnerable → Safe:**
```rust
let p = root.join(user_supplied); open(p)?;              // BUG: absolute / .. escapes root
let c = root.join(user).canonicalize()?;
if !c.starts_with(root.canonicalize()?) { return Err(..) } // FIX (reject absolute + ParentDir; sanitize archive entries)
// eliminate the TOCTOU with the cap-std capability API
```
**Severity:** Critical — arbitrary file read/write/overwrite (RCE-adjacent).
**Tooling:** No Clippy lint. Manual review of every `Path::join` / archive-extract on attacker-controlled names; consider `cap-std`.
> — [std Path::join / canonicalize (documents absolute-replace)](https://doc.rust-lang.org/std/path/struct.Path.html#method.join)

### 7.3 Predictable temp paths

A temp path built from a predictable name (`/tmp/myapp-<pid>`) then created is a symlink/pre-creation race (TOCTOU → privilege escalation / file clobber). `tempfile` creates the file atomically with `O_EXCL` and an unpredictable name.

**Vulnerable → Safe:**
```rust
File::create(format!("/tmp/app-{}", pid))?;              // BUG: TOCTOU symlink/pre-creation race
let f = tempfile::NamedTempFile::new()?;                  // FIX (atomic, unpredictable)
```
**Severity:** Medium (TOCTOU) — **Critical** in a privileged/setuid context.
**Tooling:** No Clippy lint. Manual review for hand-built temp paths.
> — [tempfile docs (atomic, unpredictable creation)](https://docs.rs/tempfile/latest/tempfile/)

### 7.4 SQL injection via `format!`; SSRF via user URLs; unbounded reads

SQL built with `format!`/concat is injectable — use parameterized queries (`sqlx::query!`/bind params, `diesel`'s builder). `reqwest::get(user_url)` permits SSRF (internal metadata endpoints, scheme abuse via redirects) — validate scheme/host, block private/link-local ranges, constrain redirects. `read_to_end`/`read_to_string` on an attacker stream is unbounded memory (DoS) — use `Read::take(limit)`.

**Vulnerable → Safe:**
```rust
sqlx::query(&format!("… WHERE id = {id}"))               // BUG: SQLi
sqlx::query!("… WHERE id = $1", id)                       // FIX
r.read_to_end(&mut v)?                                    // BUG: unbounded
r.take(MAX).read_to_end(&mut v)?                          // FIX
```
**Severity:** Critical — SQLi / SSRF / remote memory-exhaustion DoS.
**Tooling:** No Clippy lint for SQLi/SSRF semantics; `sqlx`'s compile-time-checked macros prevent SQLi when used. Manual review.
> — [sqlx docs](https://docs.rs/sqlx/) · [reqwest redirect Policy](https://docs.rs/reqwest/) · [std Read::take](https://doc.rust-lang.org/std/io/trait.Read.html#method.take)

---

## 8. Panic / DoS & Misc Rust-Specific

*(In scope here only with a DoS or FFI/security consequence; pure non-DoS panics are `rust-correctness-audit`'s.)*

### 8.1 Panic-as-DoS in a server; panic across FFI

A panicking handler is a DoS vector. In tokio a panicking task is isolated (`JoinHandle` → `Err(JoinError)`) but the in-flight request is dropped and held state/locks may be poisoned; with `panic = "abort"` **any** panic kills the whole process. A panic crossing a non-`-unwind` FFI boundary is UB-or-abort (Dim 3.1). `catch_unwind` *"will only catch unwinding panics, not those that abort the process,"* and is *"not recommended … for a general try/catch."*

**Vulnerable → Safe:**
```rust
async fn handler(b: Bytes) { let v: T = serde_json::from_slice(&b).unwrap(); … }  // BUG: remote DoS
async fn handler(b: Bytes) -> Result<_, _> { let v: T = serde_json::from_slice(&b)?; … }  // FIX (4xx)
// wrap extern "C" entries in catch_unwind; avoid panic = "abort" if per-request isolation is required
```
**Severity:** Critical — remote DoS; UB if across FFI.
**Tooling:** Clippy `unwrap_used`/`expect_used`/`panic`/`indexing_slicing`/`missing_panics_doc` (restriction/pedantic, allow — enable). `cargo fuzz` to find panicking inputs. Manual review of handler entry points and `extern` fns.
> — [std panic::catch_unwind](https://doc.rust-lang.org/std/panic/fn.catch_unwind.html) · [Nomicon: FFI](https://doc.rust-lang.org/nomicon/ffi.html)

### 8.2 Integer-overflow-as-vuln; `debug_assert!` vanishing in release

Arithmetic overflow **panics in debug** but **wraps in release** by default (unless `overflow-checks = true`). A length/bounds/quota that wraps in release can defeat a security check (e.g. `if used + n > limit` wrapping so the check passes → undersized allocation / OOB). `debug_assert!` does **not** run in release — a security invariant guarded only by it is **absent in production**.

**Vulnerable → Safe:**
```rust
let total = a + b; if total > cap { reject() }           // BUG: wraps in release → check bypassed
let total = a.checked_add(b).ok_or(Overflow)?;           // FIX (or saturating_add where safe)
debug_assert!(idx < len);  // → promote to: if idx >= len { return Err(..) }   // FIX
```
**Severity:** Critical when the wrap enables a bypass / OOB; Medium for `debug_assert!`-guarded invariants generally.
**Tooling:** Clippy `arithmetic_side_effects` (restriction, allow). `overflow-checks = true` for the security-critical profile. **Miri** detects the panic-class overflow. Manual review of arithmetic feeding a security decision.
> — [Reference: overflow](https://doc.rust-lang.org/reference/expressions/operator-expr.html#overflow) · [Cargo profiles — overflow-checks](https://doc.rust-lang.org/cargo/reference/profiles.html#overflow-checks)

### 8.3 `unreachable_unchecked` / `get_unchecked` / `unwrap_unchecked` / `assume_init` reached

`hint::unreachable_unchecked()` — *"Reaching this function is Undefined Behavior … the compiler will eliminate all branches … that invariably lead to a call,"* a wrong assumption yields *"nonsensical machine instructions … including in seemingly unrelated code."* `slice::get_unchecked` with an OOB index is *"undefined behavior even if the resulting reference is not used."* `unwrap_unchecked` on `None`/`Err` and `assume_init` on uninit are UB (Dim 1.5).

**Vulnerable → Safe:**
```rust
unsafe { *v.get_unchecked(i) }   // i from untrusted input  // BUG: OOB UB (memory-corruption primitive)
v.get(i).ok_or(OutOfRange)?                                  // FIX
// replace unreachable_unchecked() with unreachable!() unless a benchmarked, proven-exhaustive invariant + // SAFETY:
```
**Severity:** Critical — UB / OOB read or write (corruption primitive when the index is attacker-influenced).
**Tooling:** **Miri** detects each on exercised paths. Clippy `indexing_slicing` (restriction, allow) flags checked indexing; the `_unchecked` calls need `undocumented_unsafe_blocks` + manual review. `cargo fuzz` to drive the bad index.
> — [std hint::unreachable_unchecked](https://doc.rust-lang.org/std/hint/fn.unreachable_unchecked.html) · [std slice::get_unchecked](https://doc.rust-lang.org/std/primitive.slice.html#method.get_unchecked) · [std MaybeUninit](https://doc.rust-lang.org/std/mem/union.MaybeUninit.html)

### 8.4 `slice::from_raw_parts` misuse; `as` truncation in a security decision

`from_raw_parts` misuse (wrong len, multiple allocations, unaligned, uninit, `> isize::MAX`) is UB (full conditions, Dim 1.7). `as` casts **silently truncate** (`u64 as u32`, `usize as u32`); a truncated length/ID/permission used in a security decision (casting a 64-bit size to 32-bit for a bounds check) can bypass it.

**Vulnerable → Safe:**
```rust
let n = big_u64 as u32; if n < cap { … }                 // BUG: truncation bypasses the check
let n = u32::try_from(big_u64).map_err(|_| TooLarge)?;    // FIX
// from_raw_parts: derive len from the same allocation; assert len * size_of::<T>() <= isize::MAX
```
**Severity:** Critical (UB for `from_raw_parts`; truncation Critical when it defeats a security check, else Medium).
**Tooling:** Clippy `cast_possible_truncation`, `cast_sign_loss`, `cast_ptr_alignment`, `ptr_as_ptr` (pedantic, allow). **Miri** for the `from_raw_parts` UB on exercised paths.
> — [std slice::from_raw_parts](https://doc.rust-lang.org/std/slice/fn.from_raw_parts.html) · [Reference: numeric cast](https://doc.rust-lang.org/reference/expressions/operator-expr.html#numeric-cast)

### 8.5 Format-string myth; TOCTOU; `#![forbid(unsafe_code)]`; transmute lifetime extension

**Dispel the myth:** Rust's `format!`/`println!` use a **compile-time-checked** format string that must be a literal — a literal format string is **not** a classic format-string vulnerability and cannot be a runtime user value in the standard macros. Residual risks are **log injection** (newlines/control chars in user data) and **secret-in-`Debug`/`Display`**, not memory-unsafe format exploitation. Filesystem **TOCTOU**: `Path::exists()`/`metadata()` then act is racy (open-then-check the fd). `#![forbid(unsafe_code)]` statically forbids any `unsafe` (a strong control where none is needed). `mem::transmute` to a reference without an explicit lifetime is an **unbounded lifetime** soundness hole (Dim 1.6).

**Severity:** format-string-as-memory-vuln = **not a Rust vuln** (state this to prevent false positives); log injection / secret-in-`Debug` = Medium; TOCTOU = Medium/Critical by context; missing `#![forbid(unsafe_code)]` where applicable = Low; transmute unbounded-lifetime = Critical (UB, Dim 1.6).
**Tooling:** rustc `unsafe_code` lint / `#![forbid(unsafe_code)]`. No Clippy lint for log injection. **Miri** for the transmute lifetime-extension UB on exercised paths.
> — [std format!](https://doc.rust-lang.org/std/macro.format.html) · [Nomicon: Unbounded Lifetimes](https://doc.rust-lang.org/nomicon/unbounded-lifetimes.html)

---

## Tooling Matrix (what actually catches what)

| Tool | Catches | Does NOT catch |
|---|---|---|
| **Miri** (`cargo +nightly miri test`) | UB on **exercised** paths: invalid values, dangling/misaligned/OOB access, uninit reads, aliasing (Stacked/Tree Borrows), invalid discriminants, some data races, provenance/`int2ptr` misuse | Anything not executed; foreign/FFI code; whether a manual `unsafe impl Send/Sync` is abstractly correct; timing side channels |
| **Clippy** | Signals: `undocumented_unsafe_blocks`, `missing_safety_doc`, `multiple_unsafe_ops_per_block`, `not_unsafe_ptr_arg_deref`, `mut_from_ref` (**correctness, deny**), transmute lints, `cast_possible_truncation`, `mem_forget`, `unwrap_used`/`expect_used`/`panic`/`indexing_slicing`, `arithmetic_side_effects`, `await_holding_lock` (suspicious, warn) | Whether the `unsafe` is *actually* sound; cross-fn UB; crypto/RNG misuse; SQLi/SSRF semantics; data races. **Most safety lints are `restriction`/`pedantic` = allow by default — must be explicitly enabled; their silence is not "clean."** |
| **`cargo audit`** | Resolved deps with RustSec `vulnerability` advisories; yanked crates | Soundness in *your* `unsafe`; un-advised vulns; build-script behavior |
| **`cargo deny`** | RustSec + `unmaintained`/`unsound`/`notice` (configurable) + banned/duplicate crates + disallowed sources/licenses | Your own code |
| **`cargo geiger`** | Count of `unsafe` expressions per dependency (audit-surface proxy) | Whether that `unsafe` is sound; vulnerabilities |
| **`cargo vet` / `cargo crev`** | Whether deps (incl. build/proc-macro) have human trust attestations | Technical bugs directly |
| **`cargo fuzz`** (libFuzzer) | Panics/crashes/UB from a fuzzable entry: deserialization DoS, recursion/alloc bombs, OOB via bad index, panic-as-DoS | Pure logic flaws with no crashing oracle; needs a harness |
| **Sanitizers** (nightly `-Zsanitizer=address\|thread\|memory`) | ASan: heap/stack OOB, UAF, double-free; TSan: data races; MSan: uninit reads | Only exercised paths; mutually exclusive; need a representative workload |
| **rustc lints** | `static_mut_refs` (deny 2024), `unsafe_op_in_unsafe_fn` (warn 2024), `improper_ctypes`/`improper_ctypes_definitions` (warn), `#![forbid(unsafe_code)]` | Soundness of allowed `unsafe`; dep vulns |

---

## Cross-Cutting Notes

- **Hard rule.** For any UB finding, prefer **Miri** as the confirming evidence and cite the exact Reference/Nomicon/std clause. `restriction`-group Clippy lints are *signals to enable and review*, not proof. **Never report "Clippy clean" as "sound"** — most safety lints are allow-by-default; their silence proves nothing. Never assert UB from a secondary source alone.
- **The memory-safety inversion.** `unsafe`/FFI/unsound-`impl` memory-unsafety **is** in scope (opposite of the generic security audit's Rust exclusion). Safe-Rust-only memory-safety claims are **not** — route those nowhere; they are not findings.
- **Severity by exploitability/impact.** UB, known-vuln deps, exploitable crypto/injection → **Critical**. Unsound `unsafe impl` is **Critical** (it converts safe call sites to UB). Latent soundness hazards with a plausible trigger, nonce-reuse paths, deserialize-bypass of a security check → **High**. Supply-chain hardening, unmaintained deps, secrets-not-zeroized, undocumented `unsafe` → **Medium**. `// SAFETY:` discipline, missing `#![forbid(unsafe_code)]` → **Low**. Escalation conditions are stated per item.
- **Model the mechanism.** Every Critical must describe what the optimizer or attacker actually does — the miscompilation from the aliasing assumption, the data-race interleaving, the allocation bomb, the timing oracle — not just "this is `unsafe`."
- **Edition-sensitive:** `static_mut_refs` (warn 2021 / **deny 2024**, §2.3); `unsafe_op_in_unsafe_fn` (warn-by-default edition 2024, §1.8).
- **Version-pinned:** `mem::uninitialized`/`zeroed` deprecated 1.39 (§1.5); `&raw const`/`&raw mut` operators 1.82 / `addr_of!` macros 1.51 (§2.3); `extern "C-unwind"` stable 1.71, uncaught-panic-abort in `extern "C"` 1.81 (§3.1). Check `Cargo.toml` edition/MSRV before asserting these.
- **Don't duplicate other skills.** Security/UB only. Non-security runtime bugs → `agentwright:rust-correctness-audit`; idioms/API design → `agentwright:rust-best-practices-audit`; test code → routed via `agentwright:test-quality-audit`. For a dual-facet anti-pattern (e.g. `mem::uninitialized`), the design facet is the best-practices skill's; the UB facet is here.

---

## Honestly Flagged — Re-verify Before Asserting (target toolchain / crate versions)

The UB *rules* all trace to a primary clause. These few *specifics* were not fully nailed down and the SKILL.md Verification Pass §3 lists them — re-confirm against the project before stating them as fact:

- **`serde_json` default recursion limit = 128.** Confirmed via serde-rs/json #162/#334 and the `disable_recursion_limit`/`unbounded_depth` docs, but the literal "128" is in the parser source / issue tracker, **not** on the docs.rs API page. Phrase as "currently 128, defined in serde_json's parser."
- **`bincode` limit method name.** `Config::limit` (bincode 1.x) vs `Configuration::with_limit` (bincode 2.x) — verify against the resolved major. The length-prefix/`size_hint` DoS behavior itself is confirmed via bincode-org #345/#587 and serde-rs/serde #744.
- **`cargo-deny` advisories config keys.** The exact `deny`/`warn` TOML keys per `unmaintained`/`unsound`/`yanked`/`notice` should be re-checked at the cargo-deny book's advisories `cfg.html` against the target `cargo-deny` version. The behavior (it consumes RustSec and handles those categories) is confirmed.
- **`RUSTSEC-2025-0141`** (referenced on the RustSec index as "bincode is unmaintained"): surfaced via the index listing, not independently opened — verify the exact ID/text before quoting it in a shipped finding.
- **Clippy group/level.** Verified against the static `rust-clippy/rust-1.86.0/index.html` snapshot (consistent). The live `master` index is JS-rendered and not fetchable as data — treat groups/levels as "verify on the project's toolchain" rather than absolute.
- **`unsound`/`notice` formal definitions.** `rustsec.org/advisories/` categorizes by label, not formal prose — describe them operationally; there is no quotable one-line definition.

**RUSTSEC-2022-0051 / CVE-2021-3520 (lz4-sys ≤ 1.9.3, CVSS 9.8) is verified live** and may be cited directly.

---

## Sources

**Primary — UB authority (Rust Reference & Rustonomicon)** — [Behavior considered undefined (full UB list + validity-by-type; `#dangling-pointers`)](https://doc.rust-lang.org/reference/behavior-considered-undefined.html) · [Nomicon: Transmutes](https://doc.rust-lang.org/nomicon/transmutes.html) · [Send and Sync](https://doc.rust-lang.org/nomicon/send-and-sync.html) · [Aliasing](https://doc.rust-lang.org/nomicon/aliasing.html) · [Uninitialized Memory](https://doc.rust-lang.org/nomicon/uninitialized.html) · [FFI](https://doc.rust-lang.org/nomicon/ffi.html) · [Unbounded Lifetimes](https://doc.rust-lang.org/nomicon/unbounded-lifetimes.html)

**Primary — std `# Safety` sections** — [mem::transmute](https://doc.rust-lang.org/std/mem/fn.transmute.html) · [MaybeUninit](https://doc.rust-lang.org/std/mem/union.MaybeUninit.html) · [Vec::set_len / from_raw_parts](https://doc.rust-lang.org/std/vec/struct.Vec.html#method.set_len) · [slice::from_raw_parts](https://doc.rust-lang.org/std/slice/fn.from_raw_parts.html) · [slice::get_unchecked](https://doc.rust-lang.org/std/primitive.slice.html#method.get_unchecked) · [String::from_utf8_unchecked](https://doc.rust-lang.org/std/string/struct.String.html#method.from_utf8_unchecked) · [hint::unreachable_unchecked](https://doc.rust-lang.org/std/hint/fn.unreachable_unchecked.html) · [ffi::CString](https://doc.rust-lang.org/std/ffi/struct.CString.html) · [panic::catch_unwind](https://doc.rust-lang.org/std/panic/fn.catch_unwind.html) · [process::Command](https://doc.rust-lang.org/std/process/struct.Command.html) · [Path::join / canonicalize](https://doc.rust-lang.org/std/path/struct.Path.html) · [Read::take](https://doc.rust-lang.org/std/io/trait.Read.html#method.take) · [format!](https://doc.rust-lang.org/std/macro.format.html)

**Primary — version/edition gates** — [Edition 2024: static mut references](https://doc.rust-lang.org/edition-guide/rust-2024/static-mut-references.html) · [Cargo profiles — overflow-checks](https://doc.rust-lang.org/cargo/reference/profiles.html#overflow-checks) · [RFC 2585: unsafe-block-in-unsafe-fn](https://rust-lang.github.io/rfcs/2585-unsafe-block-in-unsafe-fn.html) *(`extern "C-unwind"` stable 1.71 and uncaught-panic-abort in `extern "C"` since 1.81; `mem::uninitialized` deprecated 1.39; `&raw` operators 1.82, `addr_of!` macros 1.51 — per the corresponding release notes, cross-checked against nomicon/ffi.html and MaybeUninit docs)*

**Primary — supply chain** — [RustSec Advisory Database](https://rustsec.org/) · [RustSec advisory index (vulnerability vs informational)](https://rustsec.org/advisories/) · [cargo-deny book — Advisories](https://embarkstudios.github.io/cargo-deny/checks/advisories/index.html) · [Cargo FAQ — lockfile guidance](https://doc.rust-lang.org/cargo/faq.html)

**Primary — Clippy lint list (group/level verified)** — [static snapshot used for verification: rust-clippy/rust-1.86.0/index.html](https://rust-lang.github.io/rust-clippy/rust-1.86.0/index.html) (live: [master](https://rust-lang.github.io/rust-clippy/master/index.html) — JS-rendered, re-verify per toolchain). Verified **restriction, allow**: `undocumented_unsafe_blocks`, `multiple_unsafe_ops_per_block`, `unnecessary_safety_comment`, `not_unsafe_ptr_arg_deref`, `transmute_ptr_to_ref`, `transmuting_null`, `invalid_null_ptr_usage`, `transmute_int_to_char`, `transmute_int_to_bool`, `transmute_num_to_bytes`, `transmute_undefined_repr`, `mem_forget`, `arithmetic_side_effects`, `unwrap_used`, `expect_used`, `panic`, `indexing_slicing`. **correctness, deny**: `mut_from_ref`. **pedantic, allow**: `cast_ptr_alignment`, `cast_possible_truncation`, `cast_sign_loss`, `missing_panics_doc`, `ptr_as_ptr`. **complexity, warn**: `char_lit_as_u8`. **style, warn (default-on)**: `missing_safety_doc`. **suspicious, warn**: `await_holding_lock`.

**Primary — crate security docs** — [subtle](https://docs.rs/subtle/latest/subtle/) · [constant_time_eq](https://docs.rs/constant_time_eq/) · [zeroize](https://docs.rs/zeroize/latest/zeroize/) · [secrecy](https://docs.rs/secrecy/) · [getrandom](https://docs.rs/getrandom/latest/getrandom/) · [rand SmallRng](https://docs.rs/rand/latest/rand/rngs/struct.SmallRng.html) · [rand StdRng](https://docs.rs/rand/latest/rand/rngs/struct.StdRng.html) · [serde_json Deserializer](https://docs.rs/serde_json/latest/serde_json/de/struct.Deserializer.html) · [serde derive](https://serde.rs/) · [bytemuck](https://docs.rs/bytemuck/) · [tempfile](https://docs.rs/tempfile/latest/tempfile/) · [sqlx](https://docs.rs/sqlx/) · [reqwest](https://docs.rs/reqwest/)

**Cited RUSTSEC / CVE (verified live)** — [RUSTSEC-2022-0051 — lz4-sys ≤ 1.9.3, "Memory corruption in liblz4" (integer overflow → OOB write), CVE-2021-3520, CVSS 9.8 Critical, patched ≥ 1.9.4](https://rustsec.org/advisories/RUSTSEC-2022-0051.html). RUSTSEC-2025-0141 ("bincode is unmaintained") — surfaced via the index; verify exact ID/text before quoting.

**Secondary (corroborating only — never the sole basis for a UB claim)** — bincode-org/bincode #345, #587; serde-rs/serde #744 (length-prefix DoS, `with_limit`) · serde-rs/json #162, #334; serde-rs/serde #3023 (recursion limit 128, `IgnoredAny` deep-nesting) · Ralf Jung — Stacked/Tree Borrows (aliasing intuition only; the normative model is "undecided" per the Reference).
