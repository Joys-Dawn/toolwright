# Performance Audit — Reference

Definitions, failure patterns, concrete anti-pattern→fix examples, and the primary-source principle governing each dimension in `SKILL.md`. Examples are deliberately domain-general (Node/TS/pseudocode) — this is a lens, not a product checklist. Full bibliographic entries are in **Primary Sources** at the end.

---

## Mandatory first step — the Worst-Case Resource Budget

A line-scoped review cannot see "four concurrent units each hold a 5 GB resource" because the per-instance cost, the multiplicity unit, and the realistic count live in three different files and never in one diff hunk. The budget is the forcing function that makes the multiplier explicit.

The five-step procedure — per-instance footprint → unit of multiplicity → realistic concurrent count → worst case (footprint × count) vs a stated ceiling → lifetime/release on every exit path — plus the "over the ceiling ⇒ at minimum Warning, usually Critical" rule and the "produce the table even when every row is OK" requirement live in [SKILL.md](SKILL.md); that is the checklist the auditor executes. This section does not restate the steps — it explains *why* the method works and walks one example end to end.

**Worked example (generic).** A search index of ~1.5 GB is loaded at module scope. The module is imported by a worker process that is spawned **once per open project**. A developer realistically has 4 projects open.

| Resource | Per-instance footprint | Multiplicity unit | Realistic peak count | Worst case | Target ceiling | Verdict |
|----------|------------------------|-------------------|----------------------|------------|----------------|---------|
| Search index | ~1.5 GB RSS | per project worker | 4 | ~6 GB | 8 GB laptop, ≤2 GB budget | **OVER** |

The fix is structural (Dimension 1): one shared resident service holds a single copy; project workers query it over IPC. The budget then reads `1.5 GB × 1 = 1.5 GB`, OK.

**Why this method.** It is the **USE method** applied as a pre-flight: for every resource enumerate Utilization, Saturation, and Errors before reasoning about anything else (Gregg). The "realistic concurrent count × per-unit cost" arithmetic is **Little's Law** in its capacity form: the resident/in-flight quantity equals arrival rate × holding time, so doubling either the multiplicity unit or the lifetime doubles the footprint (Little 1961). Provisioning to a *stated* ceiling rather than hoping the peak never arrives is the provisioned-rate discipline behind graceful overload handling (Google SRE, *Handling Overload*).

---

## Cluster A — Scale of instances & resources

A line-scoped correctness review is structurally blind to this entire cluster. It is the core of this audit.

### 1. Process & Instance Multiplicity

**One process model + N copies of a heavy resident resource.** The defect is rarely visible at the load site — it is the *absence* of a shared owner combined with a spawn topology described elsewhere.

**Violation — heavy resource at module scope in a per-unit process:**
```ts
// indexer.ts — imported by a worker that is spawned once per open project
const index = loadIndex(); // ~1.5 GB resident, eagerly, at import time

export function search(q: string) { return index.query(q); }
```
With 4 projects open, 4 worker processes each `loadIndex()` → 4 × 1.5 GB resident. No pool, no cap, no shared service.

**Fix — single resident owner, many thin clients:**
```ts
// index-service.ts — one long-lived process, started once for the machine/user
const index = loadIndex();              // exactly one copy, ever
server.handle('search', q => index.query(q));

// worker.ts — holds no copy; queries the shared service over IPC/socket
export function search(q: string) { return rpc('search', q); }
```

**Multiplicity-unit mismatch** is the softer form: the resource is loaded per *request* when per *worker* would serve every request that worker handles, or per *session* when one machine-wide copy is read-only and shareable. Always also flag the **absence of a ceiling**: nothing bounds how many heavy instances can coexist (no pool max, no concurrency limit, no admission control).

**Governing principle.** The Twelve-Factor App treats processes as the unit of scale: stateless, share-nothing processes that scale *out* (factors VI *Processes* and VIII *Concurrency*) — which means anything large and read-only belongs in a backing service shared across them, not duplicated into every process. Size the shared owner with Little's Law (concurrent in-flight = throughput × service time), not by guessing.

### 2. Heavy & Native Resource Lifecycle

A garbage collector reclaims JS objects; it does **not** reclaim native sessions, sockets, pools, child processes, GPU contexts, mmaps, or file descriptors. Those need explicit, deterministic release on **every** exit path.

**Violation — native handle acquired, never explicitly released:**
```ts
const session = nativeRuntime.createSession(modelPath); // native memory + fd
const out = session.run(input);
return out;                       // session is never .release()d;
                                  // relies entirely on process exit
```

**Fix — deterministic release on all paths:**
```ts
const session = nativeRuntime.createSession(modelPath);
try {
  return session.run(input);
} finally {
  session.release();              // normal AND throw path
}
// process-lifetime owner: also release on shutdown
process.once('SIGTERM', () => session.release());
process.once('SIGINT',  () => session.release());
```

Related: **disposal missing on one exit path** (cleanup on the happy path only); **long-lived owner for a short-lived need** (a per-process-lifetime handle for work that lasts one call); **non-idempotent teardown** (`dispose()` throws on second call, or frees some sub-resources and leaks others).

**Governing principle.** This is **RAII** — resource acquisition is bound to an owning scope whose exit deterministically releases it (Stroustrup); its managed-runtime equivalent is the **`IDisposable`/Dispose pattern** with `using`/`try-finally` (Microsoft .NET docs). Twelve-Factor IX (*Disposability*) requires processes to shut down gracefully and release resources on signal, not to lean on the OS reaping them.

### 3. Resource Leaks & Unbounded Growth

Every accumulating mechanism needs a corresponding recycling mechanism; one without the other is a leak with a fuse.

**Violation — unbounded in-memory collection:**
```ts
const cache = new Map<string, Result>();          // module-level, never evicts
function memoized(key: string) {
  if (!cache.has(key)) cache.set(key, compute(key));
  return cache.get(key)!;                          // grows forever on unbounded keyspace
}
```
**Fix — bound it (max size + eviction, or TTL):**
```ts
const cache = new LRU<string, Result>({ max: 5_000, ttl: 60_000 });
```

**Violation — listener/timer/subscription with no matching teardown:**
```ts
emitter.on('data', onData);
const id = setInterval(poll, 1_000);
// scope is destroyed; nothing calls emitter.off / clearInterval
```
**Fix:** pair every `on`/`addEventListener`/`setInterval`/`subscribe` with `off`/`removeEventListener`/`clearInterval`/`unsubscribe` on scope destruction.

Also: **handle/fd/connection leak** — opened on a path that does not close on all exits; under sustained load this exhausts the OS descriptor limit and every subsequent `open`/`accept`/`connect` fails with `EMFILE` (man7 `getrlimit(2)`, `RLIMIT_NOFILE`). **Accumulating store with no recycler** — logs/rows/temp files that grow forever with no retention/rotation/compaction. **Monotonic memory ratchet** — steady-state RSS on a long-lived process only ever rises (retained references, an arena/pool that never returns memory).

**Governing principle.** Nygard's **Steady State**: a system that runs unattended must, for every mechanism that accumulates data, have a mechanism that removes it; otherwise it fails the moment a bound (heap, disk, descriptor table) is reached (*Release It!*, 2nd ed.). The descriptor ceiling itself is a hard OS limit (`RLIMIT_NOFILE` → `EMFILE`).

### 4. Hot-Path & Startup Amplification

Cost that is acceptable once becomes the system's dominant load when it sits on a path hit per request / per render / per keystroke / per session-start, *especially* when N concurrent units each trigger it independently.

**Violation — unbounded external input read on every session start:**
```ts
function onSessionStart() {
  const everything = readAll(transcriptDir);    // no size/count cap
  return seed(everything);                      // runs per session start...
}
```
With M concurrent sessions/projects this is M × full-corpus work, with no machine-wide coordination.

**Fix — cap the input, do the work once, coalesce concurrent triggers:**
```ts
const seedOnce = singleFlight('seed', async () => {
  const recent = readWindow(transcriptDir, { maxBytes: 2_000_000 }); // bounded
  return seed(recent);
});
function onSessionStart() { return seedOnce(); } // N triggers → 1 execution
```

**Synchronized stampede**: many clients do the expensive thing at the same instant (cold start, shared cache expiry, a cron tick) — a *thundering herd*. Add jitter and coalescing so the herd disperses instead of arriving as one spike.

**Governing principle.** A self-reinforcing per-event cost is the **positive-feedback loop** Google SRE identifies as the engine of cascading failure (*Addressing Cascading Failures*): the work makes the system slower, which (via retries/restarts/more sessions) produces more of the work. The synchronized variant is the classic **thundering herd**. Fast, cheap startup is also a Twelve-Factor IX requirement (*Disposability*).

### 5. Producer/Consumer Capacity & Backpressure

When arrival rate λ exceeds service rate μ, the queue between them grows without bound — latency and memory diverge. Backpressure is the mechanism that makes λ track μ.

**Violation — fast producer, ignored backpressure signal:**
```ts
for (const chunk of hugeSource) {
  out.write(chunk);                 // ignores write()'s false return ⇒
}                                   // unbounded internal buffering ⇒ OOM
```
**Fix — respect the backpressure signal (or use a pipeline that does):**
```ts
import { pipeline } from 'node:stream/promises';
await pipeline(hugeSource, transform, out); // pauses the source when out is full
```

**Violation — unbounded producer, single under-provisioned consumer:**
```ts
queue.push(...externallySizedBatch); // bound by external input, not by us
setInterval(() => processOne(queue.shift()), 0); // drains 1 at a time, forever behind
```
**Fix:** bound the queue and apply backpressure to (or shed from) the producer; drain with a concurrency-limited worker sized so μ ≥ λ; under overload **reject early** (load-shed) rather than enqueue unboundedly. A timeout/escape-hatch that silently drops work hides the loss and the system "works" while never catching up — surface the drop.

**Governing principle.** **Reactive Streams** defines backpressure as the consumer governing the producer's rate over an asynchronous boundary with bounded buffers (reactive-streams.org). **Little's Law** is why an unbounded queue is fatal: L = λ·W, so if λ > μ then W → ∞ and L (queued items, hence memory) → ∞. Shedding load at saturation instead of queueing it is Google SRE's *Handling Overload*; the unbounded-buffer and starved-worker shapes are Nygard's **Unbounded Result Sets** and **Blocked Threads**.

---

## Cluster B — Classic scalability

### 6. Algorithmic Complexity

**Violation — linear scan inside a loop ⇒ O(n²):**
```ts
const visible = items.filter(i => !blocked.includes(i.id)); // includes is O(n)
```
**Fix — O(1) membership:**
```ts
const blockedSet = new Set(blocked);
const visible = items.filter(i => !blockedSet.has(i.id));   // overall O(n)
```

**Violation — invariant work repeated in a loop:**
```ts
for (const line of lines) {
  if (new RegExp(pat).test(line)) hit(line); // recompiles the regex every iteration
}
```
**Fix:** hoist the invariant (`const re = new RegExp(pat)` once); likewise hoist re-sorts and recomputations out of loops/renders. Also flag **superlinear growth on a user/growth-controlled `n`** — an input whose size the caller or data growth controls, run through worse-than-linear work.

**Governing principle.** Asymptotic (Big-O) analysis: judge the growth term, not the constant — an O(n²) step dominates everything else once `n` is large (Cormen et al., *Introduction to Algorithms*). Pair this with **Amdahl's Law**: optimizing a term that is not the dominant cost cannot improve the whole; spend effort where the time actually goes (Amdahl 1967).

### 7. Database & I/O Scalability

**Violation — N+1 queries:**
```ts
const posts = await db.query('SELECT * FROM posts LIMIT 20');
for (const p of posts) {
  p.author = await db.query('SELECT * FROM users WHERE id=$1', [p.author_id]); // 20 round-trips
}
```
**Fix — one batched fetch:**
```ts
const posts = await db.query('SELECT * FROM posts LIMIT 20');
const authors = await db.query('SELECT * FROM users WHERE id = ANY($1)',
  [posts.map(p => p.author_id)]);
const byId = new Map(authors.map(a => [a.id, a]));
posts.forEach(p => { p.author = byId.get(p.author_id); });
```

**Violation — unbounded query / missing pagination:**
```ts
const rows = await db.query('SELECT * FROM events'); // whole table, grows forever
```
**Fix:** `LIMIT`/keyset pagination; never return an unbounded set to the caller.

Also: **column over-fetch** (`SELECT *` pulling wide or unused `TEXT`/`BLOB`/JSON columns across the network and into memory when a narrow projection would do — a per-row cost that bites even under a `LIMIT`); **query in a hot path** (per-render/per-iteration); **sequential independent queries** awaited in series instead of batched; **connection-per-request against a small server ceiling** (e.g., PostgreSQL's default `max_connections` is 100 — a connection per request exhausts it; use a pool); **missing index implied by the access pattern** (flag from how the data is filtered/sorted; do not assert the schema unless you can read it).

**Governing principle.** N+1, the unbounded result set, and indexing-by-access-pattern are the canonical relational scalability defects (Winand, *Use The Index, Luke!*; Nygard, **Unbounded Result Sets**, *Release It!*). The connection ceiling is a real, small, server-side limit (PostgreSQL documentation, `max_connections`, default 100).

### 8. Memory & Throughput at Scale

**Violation — whole dataset into memory:**
```ts
const all = await db.query('SELECT * FROM events'); // 10M rows materialized
all.map(transform);
```
**Fix — bounded memory via cursor/stream/keyset:**
```ts
let cursor = 0;
for (;;) {
  const batch = await db.query(
    'SELECT * FROM events WHERE id > $1 ORDER BY id LIMIT 1000', [cursor]);
  if (batch.length === 0) break;
  batch.forEach(transform);
  cursor = batch[batch.length - 1].id;
}
```

**Violation — unbounded fan-out concurrency:**
```ts
await Promise.all(items.map(callRemote)); // items unbounded ⇒ exhausts conns/fds/mem
```
**Fix:** cap concurrency (`p-limit`, a worker pool, or chunked batches).

**Violation — per-process state used for coordination, breaks on scale-out:**
```ts
const seen = new Set<string>(); // module-level; with 2+ instances each has its own
function once(id: string) { if (seen.has(id)) return; seen.add(id); /* ... */ }
```
**Fix:** move shared cache/lock/rate-limit/dedupe state to a backing store every instance shares; in-process memoization is fine only for pure, bounded, per-process computation.

**Governing principle.** Twelve-Factor VI: processes are stateless and share-nothing, so any state used for coordination must live in a backing service, not process memory — otherwise it is silently wrong with more than one instance. Bounded memory under load is exactly what **Reactive Streams** backpressure guarantees, and **Little's Law** quantifies the residency (memory ∝ in-flight = throughput × latency).

### 9. Concurrency & Contention Under Load

Adding concurrency does not monotonically add throughput. Shared serialization first flattens the curve, then bends it **down**.

**Violation — global serialization point:**
```ts
const lock = new Mutex();
async function handle(req) {
  await lock.acquire();         // every request serializes through one critical section
  try { return await work(req); } finally { lock.release(); }
}
```
**Fix:** shrink/shard the critical section, make the hot path lock-free, or partition state so independent work does not contend.

Other shapes and their fixes:
- **No timeout / circuit breaker / bulkhead** — an outbound call with no timeout; a failing dependency with no breaker; one slow dependency draining a shared pool and taking the whole service down. Add a timeout, a **circuit breaker** (fail fast while the dependency is unhealthy), and **bulkhead** isolation (separate pools so one dependency cannot starve the rest).
- **Retry without budget or jitter** — uncapped retries with fixed backoff amplify load and synchronize into spikes. Cap attempts and use **exponential backoff with full jitter**.
- **Cache stampede on expiry** — concurrent misses on a hot expired key all recompute it at once. Use single-flight/coalescing or probabilistic early recomputation.
- **Event-loop / worker-pool blocking** — synchronous CPU or blocking IO on the event loop, or saturating the platform's small fixed worker pool (libuv defaults to 4 threads), stalls every concurrent request on that process. Move CPU/blocking work off the loop (worker thread / child process) and size the pool deliberately.
- **Tail-latency amplification under fan-out** — a request that fans out to many components waits for the slowest; a per-component p99 becomes the *common* case once a request touches enough components. Mitigate with hedged/backup requests and tail-tolerant fan-out.

**Governing principle.** The **Universal Scalability Law** (Gunther) models throughput as limited by a contention term α (serialization, Amdahl's Law) *and* a coherency term β (cross-talk to keep shared state consistent); β is why throughput can go **retrograde** — more concurrency, less work done. Resilience under that regime is the **Circuit Breaker** (Fowler; Nygard, *Release It!*) and **Bulkhead** (Microsoft Azure architecture) patterns; safe retry is **exponential backoff with jitter** (Brooker, *AWS Builders' Library*); stampede control is *Optimal Probabilistic Cache Stampede Prevention* (Vattani et al., PVLDB 2015); event-loop discipline is Node's *Don't Block the Event Loop*; fan-out tail behavior is *The Tail at Scale* (Dean & Barroso, CACM 2013); the system-level failure mode is Google SRE's *Addressing Cascading Failures*.

---

## Primary Sources

Cited at the principle level. Where a source could not be re-fetched verbatim it is referenced canonically (author, title, venue, year, DOI) with **no reproduced quotations or statistics** — claims rest on the principle, not on a paraphrased figure.

**Scaling & capacity laws**
- Amdahl, G. M. "Validity of the single processor approach to achieving large scale computing capabilities." *AFIPS Spring Joint Computer Conf.*, 1967. DOI 10.1145/1465482.1465560.
- Little, J. D. C. "A Proof for the Queuing Formula: L = λW." *Operations Research* 9(3):383–387, 1961. DOI 10.1287/opre.9.3.383.
- Gunther, N. J. *Guerrilla Capacity Planning* (Universal Scalability Law: contention α + coherency β; retrograde scaling). Springer, 2007.
- Cormen, Leiserson, Rivest, Stein. *Introduction to Algorithms* (asymptotic / Big-O analysis). MIT Press.

**Method & operability**
- Gregg, B. "The USE Method" (Utilization, Saturation, Errors per resource). brendangregg.com/usemethod.html; "Thinking Methodically about Performance," *CACM* 56(2), 2013.
- Beyer, Jones, Petoff, Murphy (eds.). *Site Reliability Engineering*, O'Reilly, 2016 — *Handling Overload* (load shedding, graceful degradation, provisioned rate) and *Addressing Cascading Failures* (positive feedback).
- Wiggins, A. *The Twelve-Factor App*, 12factor.net — VI *Processes* (stateless, share-nothing), VIII *Concurrency* (scale out via the process model), IX *Disposability* (fast startup, graceful shutdown).

**Resource lifecycle**
- Stroustrup, B. *The C++ Programming Language* — Resource Acquisition Is Initialization (RAII).
- Microsoft .NET documentation — the Dispose pattern / `IDisposable` / `using`.
- `getrlimit(2)`, Linux man-pages (man7.org) — `RLIMIT_NOFILE`; descriptor exhaustion surfaces as `EMFILE`.

**Resilience & data-access patterns**
- Nygard, M. *Release It!*, 2nd ed., Pragmatic Bookshelf, 2018 — Steady State, Circuit Breaker, Bulkhead, Unbounded Result Sets, Blocked Threads.
- Fowler, M. "CircuitBreaker." martinfowler.com.
- Microsoft Azure Architecture Center — "Bulkhead pattern."
- Brooker, M. "Timeouts, retries, and backoff with jitter." *Amazon Builders' Library* (exponential backoff with full jitter).
- Winand, M. *SQL Performance Explained* / *Use The Index, Luke!* (use-the-index-luke.com) — N+1, indexing by access pattern.
- PostgreSQL documentation — `max_connections` (default 100).

**Concurrency at scale**
- Reactive Streams specification — reactive-streams.org (non-blocking asynchronous backpressure with bounded buffers).
- Dean, J.; Barroso, L. A. "The Tail at Scale." *CACM* 56(2):74–80, 2013. DOI 10.1145/2408776.2408794. (Cited at principle level — no figures reproduced.)
- Vattani, A.; Chierichetti, F.; Lowenstein, K. "Optimal Probabilistic Cache Stampede Prevention." *PVLDB* 8(8):886–897, 2015. DOI 10.14778/2757807.2757813. (Cited at principle level.)
- Node.js documentation — "Don't Block the Event Loop (or the Worker Pool)," nodejs.org (libuv worker pool defaults to 4 threads, configurable via `UV_THREADPOOL_SIZE`).
