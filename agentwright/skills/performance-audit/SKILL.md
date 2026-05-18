---
name: performance-audit
description: Audits code and architecture for scalability, resource exhaustion, and load behavior — what breaks at 100k users, N concurrent processes, or after running for a week. Covers process/instance multiplicity, native-resource lifecycle, leaks, hot-path amplification, backpressure, algorithmic complexity, and contention. Use when reviewing changes that load models/pools/caches, run per-session/per-request, spawn processes, or handle growth. For logic bugs use `agentwright:correctness-audit`; for principle/idiom hygiene use `agentwright:best-practices-audit`.
---

# Performance Audit

Audit whether this code stays alive and responsive **under realistic load, multiplicity, and time** — not whether it produces the right answer for one call (that is `agentwright:correctness-audit`), and not whether it follows naming/SOLID/DRY (that is `agentwright:best-practices-audit`). The questions this audit exists to answer:

- **What happens at 100k users / 1M rows / a week of uptime?**
- **How many copies of this run at once, and what does each one hold resident?**
- **What is never released, and what grows without bound?**
- **When the producer outpaces the consumer, what gives?**

A correctness audit reviewing a diff line-by-line **structurally cannot** see "four concurrent sessions each load a 5 GB model" — that fact lives in a process-spawn config, a module singleton, and the *absence* of a shared service, spread across files and never in one hunk. This audit is therefore **architecture-first by default** (see Scope). Every finding cites file, line(s), dimension, and a concrete fix, and models the failure at scale: which load triggers it, what saturates, and at what multiplier.

## Scope

**Default mode is architecture mode, not diff-line mode.** Even when invoked on a diff, you must read the *deployment and lifecycle context* of the changed code, not only the changed lines. A scale defect is almost never confined to the hunk that introduces it.

- **Diff mode** (default when changes exist, no scope given): run `git diff` / `git diff --cached` to identify *what changed*, then trace each changed component's **deployment topology**: where is it instantiated, how many times, by what (per process / per session / per request / per worker / per tab / per CPU), what it loads or holds resident, and when it is released. Flag scale defects reachable from the change even when the defect spans unchanged files. This explicitly overrides the correctness-audit "only changed lines" rule.
- **File/directory mode**: audit the named files plus their instantiation sites and lifecycle owners.
- **Full review mode**: scan the system's resource-bearing components (model/pool/cache/queue/connection loaders, lifecycle hooks, hot paths, growth surfaces).

Read all in-scope code, its instantiation sites, and its teardown paths before producing findings.

## Mandatory first step: the Resource Budget

Before evaluating dimensions, build a **Worst-Case Resource Budget**. This is the forcing function a line-scoped review lacks — it makes the multiplier explicit instead of invisible.

For every heavy or bounded resource the in-scope code acquires (loaded model/index, cache, connection or thread pool, child process, large buffer, mmap, GPU context, open file/socket):

1. **Per-instance footprint** — memory / file descriptors / connections / threads one instance holds at steady state and at peak.
2. **Unit of multiplicity** — what causes another copy to exist: per request, per session, per project, per worker, per CPU core, per tab.
3. **Realistic concurrent count** — a defensible peak for that unit (e.g., a developer with 4 repos open; 200 concurrent requests; 32 workers).
4. **Worst case = footprint × count**, compared against a stated target machine/runtime ceiling.
5. **Lifetime** — how long the owning process lives, and what releases the resource (and on which exit paths — normal, error, SIGINT/SIGTERM).

If the product exceeds the target ceiling, that is at minimum a Warning and usually Critical. The budget table is a required section of the report (see Output Format). Anchor the reasoning in the USE method (for every resource: utilization, saturation, errors) and Little's Law (in-flight = throughput × latency); see [REFERENCE.md](REFERENCE.md).

## Dimensions to Evaluate

Evaluate each dimension. Skip dimensions with no findings. See [REFERENCE.md](REFERENCE.md) for definitions, anti-pattern→fix examples, and the primary-source citation governing each.

### Cluster A — Scale of instances & resources

A line-scoped correctness review is blind to this cluster. It is the core of this audit.

#### 1. Process & Instance Multiplicity

- **Per-instance heavy load with no sharing**: a multi-hundred-MB/GB resource (model, index, dataset, large cache) loaded into a process that is spawned per request / per session / per project, with no shared daemon, pool, or singleton service. N concurrent units ⇒ N full copies resident.
- **Multiplicity unit mismatch**: the resource is loaded at a finer granularity than necessary (per request when per worker would do; per session when machine-wide would do).
- **Duplicated resident state across workers**: each worker/replica holds its own full copy of something that could be shared (read-only model, lookup table) with no measurement of the aggregate.
- **No ceiling on instance count**: nothing bounds how many heavy instances can exist at once (no pool cap, no concurrency limit, no admission control).

#### 2. Heavy & Native Resource Lifecycle

- **Native/external resource never explicitly released**: a handle the garbage collector cannot reclaim (native session, connection, pool, child process, GPU context, mmap, fd) acquired but never `close()`/`dispose()`/`destroy()`d — relying solely on process exit.
- **Disposal missing on an exit path**: cleanup exists for the normal path but not for error paths or signal handlers (SIGINT/SIGTERM); the process exits without releasing.
- **Long-lived owner for a short-lived need**: a heavy resource is held for the entire process/session lifetime when it is needed only briefly (load → use → should-dispose, but kept resident).
- **Non-idempotent or partial teardown**: dispose that throws on second call, or releases some sub-resources but leaks others.

#### 3. Resource Leaks & Unbounded Growth

- **Listeners/timers/subscriptions not removed**: `addEventListener`/`setInterval`/observable/socket subscriptions created without the matching teardown on scope destruction.
- **Unbounded in-memory collection**: cache/map/queue/dedupe-set added to but never evicted (no LRU, no TTL, no max size).
- **Accumulating store with no recycler**: logs/rows/files/temp artifacts that grow forever with no retention/rotation/compaction — every accumulating mechanism needs a recycling mechanism.
- **Handle/fd/connection leak**: opened on a path that does not close on all exits; under load this exhausts the OS descriptor limit (`EMFILE`).
- **Monotonic memory ratchet**: steady-state RSS only ever rises (fragmentation, arena/pool that never returns memory, retained references) on a long-lived process.

#### 4. Hot-Path & Startup Amplification

- **Expensive work in a frequently-hit lifecycle point**: heavy computation/IO on every request, every render, every keystroke, or every session/process start, where caching/debouncing/memoizing or doing it once would remove it.
- **Cost scales with unbounded external input in a hot path**: startup or per-event work that reads "all files" / "the whole transcript" / "every row" with no size or count cap.
- **Amplified by concurrent triggers**: the hot-path work is independently triggered by each of N concurrent units (sessions/projects/tabs) with no machine-wide single-flight, multiplying total load by N.
- **Synchronized stampede**: many clients/instances do the expensive thing at the same instant (cold start, cache expiry, scheduled tick) with no jitter or coalescing — a thundering herd.

#### 5. Producer/Consumer Capacity & Backpressure

- **Unbounded or externally-sized producer, single/under-provisioned consumer**: work enqueued faster than one serialized worker can drain it, with no bound and no backpressure.
- **No backpressure**: a fast producer forces unbounded buffering on a slow consumer (ignored stream `write()` return value, unbounded queue, `Promise.all` over an unbounded array).
- **Timeout/escape-hatch that silently drops work**: when the consumer cannot keep up, work is dropped/deferred without surfacing the loss, so the system "works" but never catches up.
- **No load shedding under overload**: at saturation the system queues unboundedly (latency and memory blow up) instead of rejecting early; FIFO queue that serves stale requests first.

### Cluster B — Classic scalability

#### 6. Algorithmic Complexity

- **O(n²)+ from a nested scan**: linear scan (`includes`/`find`/`indexOf`) inside a loop over a related collection; should be a `Set`/`Map` for O(1) lookup.
- **Repeated work that could be hoisted**: re-sorting, regex recompilation (`new RegExp` in a loop), or recomputation of an invariant inside a loop/render.
- **Superlinear growth on a user-controlled `n`**: an algorithm whose input size is attacker- or growth-controlled and grows worse than linearly.

#### 7. Database & I/O Scalability

- **N+1 queries**: a query per row of a result set instead of one join / `IN (…)` / batched fetch.
- **Unbounded query / missing pagination / column over-fetch**: `SELECT *` / `findAll()` with no `LIMIT`; an endpoint that returns the whole table; grows unbounded with the data. Also `SELECT *` pulling wide or unused columns (large `TEXT`/`BLOB`, JSON blobs) across the network and into memory when a narrow projection would do — a per-row cost that bites even under a `LIMIT`.
- **Query in a hot path / sequential independent queries**: per-render or per-iteration queries; independent queries awaited in series instead of batched.
- **No connection pooling / missing index by access pattern**: a connection per request against a small server connection ceiling; a filter/sort on a column the access pattern clearly requires an index for (flag from the access pattern; don't assert the schema unless you can read it).

#### 8. Memory & Throughput at Scale

- **Whole dataset into memory**: reading an entire file/table/collection into an array when streaming/cursor/pagination would bound memory.
- **Unbounded fan-out concurrency**: `Promise.all(items.map(asyncFn))` where `items` is unbounded — exhausts connections/handles/memory; needs a concurrency limit.
- **In-memory coordination state that breaks on scale-out**: a module-level map/set used as cache/lock/rate-limiter/dedupe that is per-process and silently wrong with >1 instance.
- **Repeated expensive pure computation** with the same inputs and no memoization.

#### 9. Concurrency & Contention Under Load

- **Contention/serialization collapse**: a global lock, single serialized stage, or shared hot resource where added concurrency yields *no more* (or *less*) throughput — throughput goes retrograde.
- **No timeout / circuit breaker / bulkhead**: an outbound call with no timeout; a failing dependency with no breaker; one slow dependency exhausting a shared pool and cascading.
- **Retry without budget or jitter**: retries with no per-request/per-client cap and no randomized backoff — retries amplify load and synchronize into spikes.
- **Cache stampede on expiry**: concurrent misses on a hot expired key all regenerate it simultaneously, with no single-flight/coalescing/early-recompute.
- **Event-loop / worker-pool blocking**: synchronous CPU or blocking IO on the event loop (or saturating the small libuv-style worker pool) stalls every concurrent request on that process.
- **Tail-latency amplification under fan-out**: a request that fans out to many components waits for the slowest; a per-component p99 becomes the common case at fan-out scale.

## Investigation Tools

This audit is primarily reasoned from topology and the resource budget — the highest-value findings come from tracing instantiation, multiplicity, and lifetime, not from a linter. Where tools apply, run them and fold the output in:

- **Complexity / hot loops**: language profilers and flamegraphs when a workload is runnable (`node --prof` / `--cpu-prof`, `clinic`, `py-spy`, `pprof`). Map a hot frame to Dimension 6 or 9.
- **Memory**: heap snapshots / RSS over time (`/usr/bin/time -v` max RSS, `node --heapsnapshot-signal`, `valgrind --tool=massif`, `pprof` heap). A monotonically rising RSS on a long-lived process maps to Dimension 2 or 3.
- **Database**: `EXPLAIN ANALYZE` on the queries the access pattern implies; ORM query logging to count round-trips (Dimension 7).
- **Static**: ESLint `no-await-in-loop`, `@typescript-eslint/no-floating-promises`; Ruff `C90` (McCabe complexity); `eslint-plugin-n` for unhandled streams. Treat tool output as supporting evidence for a dimension, never the whole audit.

State in the Summary which tools were run, or that the audit is reasoned (no runnable workload available).

## Output Format

Group findings by severity. Each finding names its dimension. The Resource Budget table is mandatory.

```
## Resource Budget
| Resource | Per-instance footprint | Multiplicity unit | Realistic peak count | Worst case | Target ceiling | Verdict |
|----------|------------------------|-------------------|----------------------|------------|----------------|---------|
| ...      | ...                    | per session       | 4                    | ...        | ...            | OVER / OK |

(One row per heavy/bounded resource. "Verdict" = OVER if worst case exceeds the ceiling.)

## Critical
Will exhaust a resource, collapse throughput, or OOM/crash under realistic load or multiplicity.

### [Dimension] Brief title
**File**: `path/to/file.ts` (lines X–Y) — and the instantiation/lifecycle sites if the defect spans files
**Dimension**: Full dimension name — one-line statement of what scalable code requires here.
**Problem**: What the code does and the failure at scale — the triggering load, what saturates, the multiplier, and the symptom (OOM at N sessions, latency cliff at N rps, fd exhaustion after H hours).
**Fix**: Concrete change (shared daemon/pool/singleton; explicit dispose on all exit paths; bounded cache/queue; pagination; concurrency limit; single-flight; timeout+breaker).

## Warning
Degrades materially under realistic growth/load, or will fail at a multiplier that is plausible but not yet hit.

(same structure)

## Suggestion
Robustness/efficiency improvement that is not yet load-bearing.

(same structure)

## Summary
- Total findings: N (X critical, Y warning, Z suggestion)
- Resource Budget verdict: any OVER rows, and the worst multiplier observed
- Dimensions most frequently violated: top 2–3
- Tooling: profiled / heap-checked / reasoned-only
- Overall assessment: 1–2 sentence verdict on behavior at scale
```

## Verification Pass

Before finalizing, verify every finding:

1. **Re-trace the topology**: confirm the multiplicity claim by reading the actual instantiation site(s) and process/lifecycle owner — not inferred from a name. If a shared daemon/pool/singleton exists that you missed, drop the finding.
2. **Re-check the lifecycle**: confirm the resource truly is not released on the path you claim — search the whole owner (signal handlers, `finally`, framework teardown hooks), not just the acquire site.
3. **Recompute the budget**: re-derive footprint × multiplicity with a defensible peak count. If the worst case is within the ceiling, downgrade or drop.
4. **Verify against primary sources**: for any quantitative claim about a runtime/library limit (pool size, heap ceiling, threadpool, descriptor limit), confirm it — don't assert a number you didn't check. Use [REFERENCE.md](REFERENCE.md) and current docs.
5. **Filter by confidence**: certain false positive → drop. Plausible but unconfirmed → list once under "Worth Investigating," not as a formal finding.

## Rules

- **Architecture-first**: trace multiplicity and lifetime across files; do not confine the audit to changed lines. This is the rule that makes this audit catch what a line-scoped review cannot.
- **Quantify the failure**: every Critical states the load and the multiplier — "OOM at 4 concurrent sessions (5 GB × 4 > 16 GB)", not "uses a lot of memory."
- **The budget is mandatory**: produce the Resource Budget table even if every row is OK — a clean budget is a real result.
- **Be specific and actionable**: cite files/lines (and the lifecycle/instantiation sites); every finding has a concrete fix (shared service, dispose, bound, pool, limit, breaker).
- **Severity by real-world impact**: rate by what breaks in production at a plausible scale, not theoretical worst case. Calibrate to the change — a single-instance CLI with bounded inputs and no heavy resource has a short, mostly-OK budget; say so and stop.
- **Cite the governing principle**: every dimension's finding can name the canon it rests on (USL, Amdahl, Little's Law, the USE method, Reactive Streams backpressure, RAII / the dispose pattern, the 12-Factor process model, circuit breaker / bulkhead). No uncited scale claims; see [REFERENCE.md](REFERENCE.md).
- **Stay domain-general**: describe classes ("a loaded model", "a native session", "a connection pool"), never a specific vendor/library bug. This is a lens, not a product checklist.
- **No fluff**: skip dimensions with no findings; don't praise merely-adequate code.
- **Don't duplicate other skills**: scale, resource lifecycle, and load only. Logic/null/type/async-correctness and TOCTOU/data-race *correctness* → `agentwright:correctness-audit`. Naming/SOLID/DRY/KISS and idiom-level micro-perf hygiene → `agentwright:best-practices-audit`. Security DoS/resource-exhaustion *as an attack* → `agentwright:security-audit` (flag the scale angle here, reference security for the attack angle).
