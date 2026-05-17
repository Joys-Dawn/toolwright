---
name: rust-security-audit
description: Audits Rust code for memory-unsafety and security vulnerabilities the generic security audit cannot see — `unsafe` soundness/UB, Send/Sync errors, FFI, supply chain (RUSTSEC/cargo-audit/deny), deserialization DoS, and crypto/secret misuse. Use when reviewing Rust changes that touch `unsafe`, FFI, crypto, deserialization, or dependencies. For runtime bugs use `agentwright:rust-correctness-audit`; for idioms/API design use `agentwright:rust-best-practices-audit`.
---

# Rust Security Audit

Audit Rust code for **memory unsafety and security vulnerabilities** specific to Rust. The Rust Reference is load-bearing here and must anchor every UB finding:

> *"Rust code is incorrect if it exhibits any of the behaviors in [the undefined-behavior list]. This includes code within `unsafe` blocks and `unsafe` functions. `unsafe` only means that avoiding undefined behavior is on the programmer; it does not change anything about the fact that Rust programs must never cause undefined behavior."* — [Reference: Behavior considered undefined](https://doc.rust-lang.org/reference/behavior-considered-undefined.html)

The generic `agentwright:security-audit` **explicitly excludes memory-safety issues in Rust as a hard exclusion** ("buffer overflows, use-after-free … are impossible in … Rust — do not report them"). That exclusion is correct for *safe* Rust and wrong for `unsafe` Rust — **`unsafe` soundness and UB are precisely this skill's core domain**. Every finding must cite the specific Reference/Nomicon clause, std `# Safety` section, RUSTSEC ID, or crate security-doc that governs it.

For runtime bugs that are not security (panics, overflow logic, races without a memory/security consequence), use `agentwright:rust-correctness-audit`. For idioms/API design, use `agentwright:rust-best-practices-audit`.

## Applicability

This audit applies only to Rust source. If no `.rs` files (and no `Cargo.toml`/`Cargo.lock`) are in scope, output exactly:

`**rust-security-audit: PASS** (no Rust code in scope)`

and stop.

## Scope

- **Git diff mode** (default when no scope specified and changes exist): `git diff` + `git diff --cached`; also `git ls-files --others --exclude-standard '*.rs'`. Review changed code and immediate context.
- **File/directory mode**: the `.rs` files or crate directories specified.
- **Full audit mode**: when asked for a full review, scan all crate source (skip `target/`, vendored crates); **prioritize files touching `unsafe`, FFI/`extern`, crypto, deserialization of untrusted input, and `Cargo.toml`/`Cargo.lock`**.

Read all in-scope code before producing findings. Note the crate edition and MSRV (`Cargo.toml`) — several UB-relevant lints are edition-gated (`static_mut_refs` `deny` in 2024, `unsafe_op_in_unsafe_fn` warn in 2024).

## Domains to Evaluate

Check each domain. Skip domains with no findings. See [REFERENCE.md](REFERENCE.md) for the rule, the exact UB/security mechanism with its primary-source clause, vulnerable→safe code, severity, and tooling for every item.

### 1. `unsafe` Block Soundness & UB (core)
*(Reference: Behavior considered undefined; Nomicon)*

- **Data races** (UB; reachable only via `unsafe`/`static mut`/unsound `Send`/`Sync`).
- **Dereferencing dangling / OOB / misaligned places** — UB on load/store; alignment is the *pointer's* type's, even for ZST/zero-length.
- **Breaking `&`/`&mut` aliasing rules** — two live `&mut` to one place, or `&T` aliasing `&mut T`, → silent miscompilation.
- **Producing an invalid value** — `bool` not 0/1, surrogate `char`, null reference/`Box`, `NonZero`/`NonNull` niche, uninit integer.
- **Reading uninitialized memory**; `mem::uninitialized`/`zeroed` (deprecated 1.39) vs `MaybeUninit`; `assume_init` on not-fully-init.
- **`transmute`** size/validity/lifetime: `&`→`&mut` is *always* UB; no-lifetime ref transmute = unbounded lifetime; non-`#[repr(C)]` layout transmute.
- **Violating library type invariants**: `Vec::set_len`, `String::from_utf8_unchecked`, `slice::from_raw_parts`, `NonNull::new_unchecked`.
- **`// SAFETY:` discipline** — every `unsafe` block needs a proof comment; every `unsafe fn` a `# Safety` doc; undocumented `unsafe` touching pointers/lifetimes/FFI is itself a finding.

### 2. `Send`/`Sync` & Concurrency Unsafety
*(Nomicon: Send and Sync)*

- **Unsound hand-written `unsafe impl Send`/`Sync`** — the only way besides raw `unsafe` to get a data race in "safe"-looking Rust; missing generic bound (`unsafe impl<T: Send> Send`) or no `// SAFETY:` proof.
- **Sending `Rc`/raw pointers across threads** via a wrong impl → non-atomic refcount race → UAF/double-free.
- **`static mut` aliasing** — taking the reference is "instantaneous undefined behavior … even if … never read or written" (`static_mut_refs`: warn 2021 / **deny 2024**).
- **Interior mutability without synchronization** — `UnsafeCell`/`Cell`/`RefCell` shared across threads via a bad `unsafe impl Sync`.

### 3. FFI Safety
*(Nomicon: FFI; Reference UB list)*

- **Unwinding across a non-`-unwind` ABI** — a Rust `panic` (or foreign exception) crossing `extern "C"` is UB-or-abort; wrap in `catch_unwind` or use `extern "C-unwind"` (stable 1.71).
- **`#[repr(C)]`/layout mismatch** — passing a `repr(Rust)` struct or a mistyped declaration across FFI is wrong-signature UB; the compiler cannot check foreign declarations.
- **`CString`/`CStr`**: interior NUL, ownership transfer (`into_raw`/`from_raw`), double-free / `libc::free` of Rust-allocated memory, leak; assuming a C `*const c_char` is UTF-8/NUL-terminated.
- **`#[no_mangle]` symbol clashes / null function pointers** — wrong-symbol call or null `extern fn` = UB.

### 4. Supply Chain & Dependencies
*(RustSec Advisory Database; cargo-audit/deny/vet/geiger)*

- **Known-vulnerable / yanked dependency** — a resolved version matching a RUSTSEC `vulnerability` advisory (e.g. **RUSTSEC-2022-0051** `lz4-sys ≤ 1.9.3`, CVE-2021-3520, CVSS 9.8). Surfaced by `cargo audit`/`cargo deny check advisories`.
- **Unmaintained / unsound / notice** RustSec informational advisories — `unsound` is a latent soundness hazard (Critical if you can show a safe trigger path in the audited code).
- **`cargo deny` policy gaps** — bans (duplicate/wildcard deps), sources (unapproved registries/git), licenses.
- **`build.rs`/proc-macros execute arbitrary code at build time** — the dominant Rust supply-chain threat (build-time RCE before any test runs); pin versions, commit `Cargo.lock` for binaries, `cargo vet`/`crev`.
- **`Cargo.lock` / version-range / `[patch]` git pinning** hygiene.

### 5. Deserialization & Untrusted Input
*(serde_json / bincode / zerocopy crate docs)*

- **Unbounded recursion / stack overflow** — `serde_json::Deserializer::disable_recursion_limit()` or the `unbounded_depth` feature on attacker input (default limit is currently 128, enforced in the parser; `Value` + `IgnoredAny` depth is still the caller's responsibility).
- **Length-prefix allocation bomb** — `bincode` (and `rmp`/`postcard`/`ciborium`) feeding an attacker-controlled length prefix into `Vec::with_capacity`; mitigation (`with_limit` / `Config::limit`) is **not on by default** (method name differs bincode 1.x vs 2.x — verify against the resolved major).
- **`Deserialize` bypassing a validating constructor** — `#[derive(Deserialize)]` on a type whose `new` enforces an invariant; Critical if the violated invariant later feeds `unsafe` (use `#[serde(try_from)]`).
- **`zerocopy`/`bytemuck` validity** — reinterpreting attacker bytes as a restricted-validity type (`bool`/`char`/niche enum/`NonZero`) is invalid-value UB; hazard is hand-written `unsafe impl Pod`.

### 6. Cryptography & Secret Misuse
*(crate security docs: subtle/zeroize/getrandom/rand/AEAD)*

- **Non-constant-time comparison of secrets/MACs/tokens** — `==` on `&[u8]` short-circuits → timing oracle → MAC forgery. Use `subtle::ConstantTimeEq`/`constant_time_eq`/library `verify`.
- **Secrets lingering in memory** — Rust does not zero on drop; use `zeroize`/`secrecy` (caveat: `Vec`/`String` realloc/clone leaves copies `zeroize` can't reach; `Drop` is not guaranteed).
- **RNG correctness** — `SmallRng` is "easy to predict (insecure)"; `StdRng::seed_from_u64`/fixed seed is unsuitable for security use (64-bit seed entropy); use `OsRng`/`getrandom` for keys/nonces/tokens (verify `rand` 0.8 vs 0.9 API names).
- **Weak/broken primitives, nonce/IV reuse, ECB, hardcoded keys** — AES-GCM/ChaCha20-Poly1305 **nonce reuse is catastrophic** (leaks the auth key); MD5/SHA-1/`DefaultHasher` in a security path; rolling your own KDF/MAC/padding.
- **`unwrap()` on crypto results / decrypt-without-verify** — AEAD `decrypt` `Err` on tag mismatch must be handled, never `unwrap`ped; decrypt-then-use without the tag check is a chosen-ciphertext/padding-oracle vuln.

### 7. Command, Path & Resource Injection
*(std `# Safety`/behavior docs)*

- **`Command` shell injection** — `Command` does *not* use a shell (safe default); the vuln is explicitly `Command::new("sh").arg("-c").arg(format!(...user...))`.
- **Path traversal** — `Path::join` with an *absolute* arg discards the base; `..` escapes; zip/tar slip; `canonicalize` + `starts_with(root)` required; symlink TOCTOU (consider `cap-std`).
- **Predictable temp paths** — `/tmp/app-<pid>` is a symlink/pre-creation race; use `tempfile` (atomic `O_EXCL`, unpredictable).
- **SQLi via `format!`; SSRF via user URLs; unbounded `read_to_end`/`read_to_string`** — parameterize queries; allowlist scheme/host + block private ranges + cap redirects; `Read::take(limit)`.

### 8. Panic / DoS & Misc Rust-Specific
*(in scope only when there is a DoS or FFI/security consequence — pure panics are `rust-correctness-audit`'s)*

- **Panic-as-DoS in a server; panic across FFI** — a handler that `unwrap`s attacker input is a remote DoS; `panic = "abort"` kills the whole process; panic across non-`-unwind` FFI is UB.
- **Integer-overflow-as-vuln; `debug_assert!` vanishing in release** — a length/quota that wraps in release defeats a bounds check; a security invariant guarded only by `debug_assert!` is absent in production.
- **`unreachable_unchecked`/`get_unchecked`/`unwrap_unchecked`/`assume_init` reached** — UB / OOB; a memory-corruption primitive when the index is attacker-influenced.
- **`as` truncation in a security decision** — `big_u64 as u32` before a bounds check can bypass it; use `try_from`.
- **Format-string myth (dispel it): Rust `format!`/`println!` are compile-time-checked — a literal format string is NOT a classic format-string vuln.** Residual risks are log injection and secret-in-`Debug`, not memory-unsafe format exploitation. `#![forbid(unsafe_code)]` absence where applicable is a Suggestion.

## Static Analysis Tools

Run available tooling and fold its output into findings. **Hard rule: for any UB finding, prefer Miri as the confirming evidence and cite the exact Reference/Nomicon clause. Never assert a construct is UB on a secondary source alone. Never report "Clippy clean" as "sound."**

| Tool | Catches | Does NOT catch |
|---|---|---|
| **Miri** (`cargo +nightly miri test`) | UB on **exercised** paths: invalid values, dangling/misaligned/OOB access, uninit reads, aliasing (Stacked/Tree Borrows), invalid discriminants, some data races, provenance/`int2ptr` misuse | Unexecuted paths; foreign/FFI code; whether a manual `Send`/`Sync` is abstractly correct; timing channels |
| **Clippy** | Signals: `missing_safety_doc` (**style, warn — default-on**), `undocumented_unsafe_blocks`, `not_unsafe_ptr_arg_deref`, `mut_from_ref` (**correctness, deny**), transmute lints, `cast_possible_truncation`, `mem_forget`, `unwrap_used`/`indexing_slicing`, `arithmetic_side_effects`, `await_holding_lock` (suspicious, warn) | Whether the `unsafe` is *actually* sound; cross-fn UB; crypto/RNG misuse; SQLi/SSRF semantics. **Most safety lints are `restriction`/`pedantic` = allow by default — must be explicitly enabled; their absence is not "clean."** |
| **`cargo audit`** | Resolved deps with RustSec `vulnerability` advisories; yanked crates | Soundness in *your* `unsafe`; un-advised vulns; `build.rs` behavior |
| **`cargo deny`** | RustSec + `unmaintained`/`unsound`/`notice` + banned/duplicate crates + disallowed sources/licenses | Your own code |
| **`cargo geiger`** | Count of `unsafe` per dependency (audit-surface proxy) | Whether that `unsafe` is sound |
| **`cargo vet`/`cargo crev`** | Whether deps (incl. build/proc-macro) have human trust attestations | Technical bugs |
| **`cargo fuzz`** | Panics/crashes/UB from a fuzzable entry: deserialization DoS, recursion/alloc bombs, OOB via bad index | Pure logic flaws with no crashing oracle |
| **Sanitizers** (nightly `-Zsanitizer=address\|thread\|memory`) | ASan: heap/stack OOB, UAF, double-free; TSan: data races; MSan: uninit reads | Only exercised paths; mutually exclusive; need a representative workload |
| **rustc lints** | `static_mut_refs` (deny 2024), `unsafe_op_in_unsafe_fn` (warn 2024), `improper_ctypes`/`improper_ctypes_definitions` (warn), `#![forbid(unsafe_code)]` | Soundness of allowed `unsafe`; dep vulns |

```bash
cargo +nightly miri test                       # UB on exercised paths (primary confirming evidence)
cargo audit                                     # RustSec vulnerability/yanked
cargo deny check advisories bans sources        # advisories + supply-chain policy
cargo clippy -- -W clippy::undocumented_unsafe_blocks -W clippy::missing_safety_doc  # enable the safety signals
```

Map each tool finding to its domain. A RustSec match → cite the `RUSTSEC-YYYY-NNNN` ID and CVE. A Miri error → cite the exact UB clause it confirms. An enabled `restriction` lint hit → a signal to review the `unsafe`, not proof of UB by itself.

## False Positive Filtering

Apply in order before reporting. A clean report with 3 real findings beats 3 buried in 12 noise items.

### Hard Exclusions (Rust-specific — note the inversion from the generic security audit)

1. **Safe Rust memory-safety claims.** Buffer overflow / UAF / double-free in code with **no `unsafe`, no FFI, no unsound `unsafe impl`** is impossible — do not report it. (The inverse of the generic audit's rule: in *`unsafe`/FFI* Rust these ARE in scope and are the core domain.)
2. **Pure non-DoS panics** with no security/FFI consequence → `agentwright:rust-correctness-audit`, not here. A panic is in scope here only as remote DoS or across an FFI boundary.
3. **`unsafe` that is documented and provably sound** — a `// SAFETY:` comment whose preconditions you can verify hold. Don't flag correct, justified `unsafe`.
4. **Outdated dependency versions** with no RUSTSEC advisory — surface `cargo audit`/`deny` output in the Summary, not as per-CVE findings.
5. **Format-string "vulnerabilities"** — Rust's `format!`/`println!` take a compile-time-checked literal; this is not a classic format-string vuln. (Real residuals: log injection, secret-in-`Debug`.)
6. **Theoretical UB with no exercised or reachable path** and no Miri/clause confirmation — downgrade to "Needs Investigation."
7. **`Command` without a shell** — `Command::new(prog).arg(x)` is the safe default; only `sh -c`/`cmd /C`/`bash -c` with interpolated input is injection.
8. **Test-only code** — unless it contains real secrets/credentials or its `unsafe` ships in a non-`#[cfg(test)]` path.
9. **`cargo geiger` count alone** — a high `unsafe` count is an audit-surface proxy, not a vulnerability.

### Confidence Gate

Before reporting, answer:

1. **Primary-source clause?** Can you cite the exact Reference/Nomicon/std `# Safety`/RUSTSEC clause that makes this UB or a vuln? If not, it's "Needs Investigation."
2. **Confirmable?** Can Miri (or a fuzz/sanitizer run) exercise it, or is the unsoundness clause-provable by inspection? Unconfirmable + clause-ambiguous → "Needs Investigation."
3. **Concrete trigger?** Which input/call/thread-interleaving reaches it? Vague ("this `unsafe` looks risky") → not a formal finding.

If any raises doubt, add a brief "Needs Investigation" note instead of a formal finding.

## Output Format

Group by severity. Each finding **must** cite the governing clause/ID.

```
## Critical
Is or directly leads to a real vulnerability: UB, memory unsafety, a known-vuln dependency, an exploitable crypto/injection flaw.

### [DOMAIN] Brief title
**File**: `path/to/file.rs` (lines X–Y)
**Standard**: Reference clause / Nomicon section / std `# Safety` / RUSTSEC-YYYY-NNNN (+CVE) — one line of what it requires.
**Vulnerability**: The UB mechanism or attack scenario — what the optimizer/attacker does, the concrete trigger.
**Confirmation**: Miri result / fuzz crash / sanitizer / clause-provable-by-inspection.
**Fix**: Specific vulnerable→safe change.

## High
Significant risk requiring specific conditions or chaining (latent soundness hazard with a plausible trigger; unsound `unsafe impl`; nonce-reuse path).

## Medium
Defense-in-depth gaps and supply-chain hardening (unmaintained dep, missing `cargo deny` gate, secrets not zeroized, undocumented `unsafe`).

## Low
Hardening / best-practice (missing `#![forbid(unsafe_code)]` where applicable, `// SAFETY:` discipline).

## Needs Investigation (optional)
Patterns that did not pass the Confidence Gate — not formal findings.

## Summary
- Total findings: N (X critical, Y high, Z medium, W low)
- Highest-risk domain
- Key clauses/IDs: Reference UB clauses, RUSTSEC IDs, CVEs
- Tooling: miri: clean/not-run/N UB; cargo audit: N advisories; cargo deny: …
- Edition/MSRV notes: edition-gated UB lints (static_mut_refs, unsafe_op_in_unsafe_fn)
- Overall security posture: 1–2 sentences
- Recommended immediate action: the single most urgent fix
```

## Verification Pass

Before finalizing, verify every finding:

1. **Re-read in context (±20 lines)**: is the `unsafe` actually unsound, or are its documented preconditions genuinely upheld here? Is the dep version actually the resolved one (`Cargo.lock`)? Drop misreads.
2. **Confirm, don't assume**: run Miri on the exercising test if one exists; cite the exact Reference/Nomicon/std clause. If you cannot confirm and the clause is ambiguous, move it to "Needs Investigation." Never assert UB from a secondary source (blog/Stacked-Borrows write-up) alone.
3. **Re-verify the flagged-uncertain specifics against the target toolchain/crate versions**: `serde_json`'s default recursion limit (currently 128 — phrase as "currently 128, in the parser") ; `bincode` limit method (`Config::limit` 1.x vs `Configuration::with_limit` 2.x) ; `cargo-deny` advisories config keys ; `RUSTSEC-2025-0141` exact ID/text ; Clippy group/level on the project's toolchain ; `rand` 0.8-vs-0.9 constructor names. RUSTSEC-2022-0051 / CVE-2021-3520 is verified live.
4. **Pin edition/version**: `static_mut_refs` is `deny` only in edition 2024 (warn 2021); `unsafe_op_in_unsafe_fn` warn in 2024; `extern "C-unwind"` ≥1.71; `mem::uninitialized` deprecated 1.39. Check `Cargo.toml` before asserting the lint level.
5. **Filter by confidence**: certain false positive → drop. Plausible-but-unconfirmed → "Needs Investigation," not a formal finding.

## Rules

- **Cite the clause/ID**: every finding references the exact Reference UB clause, Nomicon section, std `# Safety` text, RUSTSEC ID (+CVE), or crate security-doc. This is the core value of this skill.
- **Prefer Miri as confirming evidence**: for UB, run/cite Miri on the exercising path; clause-provable-by-inspection is acceptable only with the quoted clause. `restriction`-group Clippy lints are *signals to enable and review*, not proof of a bug.
- **Never report "Clippy clean" as "sound"**: most safety lints are allow-by-default; their silence proves nothing.
- **The memory-safety inversion**: `unsafe`/FFI/unsound-`impl` memory-unsafety IS in scope (opposite of the generic security audit's Rust exclusion). Safe-Rust-only memory-safety claims are NOT.
- **Model the mechanism**: every Critical describes what the optimizer or attacker actually does (the miscompilation, the data race interleaving, the allocation bomb), not just "this is `unsafe`."
- **Be specific and actionable**: file:line + the concrete vulnerable→safe rewrite.
- **Severity by exploitability/impact**: UB and known-vuln deps are Critical; latent soundness hazards with a plausible trigger are High; supply-chain/defense-in-depth gaps are Medium/Low.
- **Don't duplicate other skills**: security/UB only. Non-security runtime bugs → `agentwright:rust-correctness-audit`; idioms/API design → `agentwright:rust-best-practices-audit`; test code → routed via `agentwright:test-quality-audit`. The design facet of a dual-facet anti-pattern (e.g. `mem::uninitialized`) is the best-practices skill's; the UB facet is here.
