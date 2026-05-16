// Consolidator helpers — deterministic stages of the dream cycle.
//
// The LLM work is done by the CALLING Claude session via the /mindwright:dream
// skill body. This module exposes pure data helpers the session can call as
// MCP tools:
//
//   drainBatch(scope)        — pick oldest 70% of short-term, group into
//                              exchanges, package for the calling session.
//   retainFact({...})        — embed + insert long-term row + run supersede
//                              candidate detection.
//   markSuperseded(old,new)  — passthrough to store.markSuperseded.
//   finalizeDrain(drain_id)  — hard-delete drained short-term, record
//                              consolidation row, regenerate mirrors.
//
// `drain_id` encodes the boundary as a (created_at, id) tuple. finalizeDrain
// re-queries by `(created_at, id) <= (cutoff_ts, cutoff_id)` so rows that
// share a millisecond with the boundary are partitioned deterministically.
// Plain `created_at <= cutoff` would over-delete: a single PreToolUse burst
// inserts cli_prompt + thinking + text under one db.transaction with
// identical ms-resolution timestamps, so without the id tie-breaker
// finalizeDrain would hard-delete rows the dream cycle never saw.
//
// drain_id wire format: `<scope>|<cutoff_ts>|<cutoff_id>` where `|` is
// used as separator because ISO timestamps already contain `:`. scope is
// `<sessionId>` or the literal string `all`.

import { renderAll, writeDroppedArchive } from './mirrors.js';
import { extractEntities, classifyEntity } from './entities.js';
import { retrieve } from './retriever.js';
import { STORED_EXCHANGE_OPENERS, KIND_FACT, MS_PER_HOUR } from './constants.js';

// Default drain fraction. DESIGN.md specifies 0.7 (drain oldest 70%).
const DEFAULT_DRAIN_PCT = 0.7;

// Char-budget estimate per exchange (rough — calling session caps its own packaging).
const DEFAULT_EXCHANGE_CHAR_BUDGET = 12_000;

// How long a drain claim stays valid before drainBatch reclaims its rows for
// another pass. An interactive dream cycle typically takes 30-60s; even a user
// who pauses heavily mid-loop should be done in well under 6 hours. Anything
// older than this is almost certainly an abandoned drain (process died, user
// walked away) and should self-recover so the locked rows aren't permanently
// stuck out-of-band.
const STALE_LOCK_HOURS = 6;

export function drainBatch({
  store,
  sessionId = null, // null → all sessions
  drainPct = DEFAULT_DRAIN_PCT,
  exchangeCharBudget = DEFAULT_EXCHANGE_CHAR_BUDGET,
}) {
  // The whole pick-and-claim sequence runs under BEGIN IMMEDIATE so two
  // concurrent dream sessions can't both observe the same "no lock yet"
  // state and both claim the same slice. The first to commit wins the rows;
  // the second sees them filtered out by `NOT IN (drain_locks)` and either
  // gets the next slice or returns empty. Enforces the "one drain at a time"
  // invariant DESIGN.md and skills/dream/SKILL.md both promise.
  const staleCutoff = new Date(Date.now() - STALE_LOCK_HOURS * MS_PER_HOUR).toISOString();
  const drainTxn = store.db.transaction(() => {
    // Expire stale claims first so abandoned drains release their rows back
    // into the pool. We rely on ON DELETE CASCADE going the other way (entry
    // deleted → lock row gone); here we just clear orphan lock rows whose
    // owning drain never finalized.
    store.db.prepare('DELETE FROM drain_locks WHERE acquired_at < ?').run(staleCutoff);

    // event_ts is SELECTed as additive payload only — it is surfaced to the
    // calling dream session so retainFact can stamp the distilled long-term
    // row with the originating exchange's true event time. The ORDER BY
    // stays (created_at ASC, id ASC): the governing invariant forbids
    // event_ts from ever entering drain selection or the finalize cursor
    // (event_ts is NULL for live rows and non-monotonic within a seeded
    // batch — ordering on it would corrupt which rows drain/delete).
    const allShortTerm = sessionId
      ? store.db.prepare(`
          SELECT id, kind, content, session_id, created_at, event_ts
            FROM entries
           WHERE tier='short' AND active=1 AND session_id=?
             AND id NOT IN (SELECT entry_id FROM drain_locks)
           ORDER BY created_at ASC, id ASC
        `).all(sessionId)
      : store.db.prepare(`
          SELECT id, kind, content, session_id, created_at, event_ts
            FROM entries
           WHERE tier='short' AND active=1
             AND id NOT IN (SELECT entry_id FROM drain_locks)
           ORDER BY created_at ASC, id ASC
        `).all();

    if (!allShortTerm.length) {
      return {
        drain_id: null,
        exchanges: [],
        drain_cutoff: null,
        drain_cutoff_id: null,
        session_id: sessionId,
        drained_count: 0,
        existing_long_term_summary: summarizeLongTerm(store),
      };
    }

    const drainCount = Math.max(1, Math.floor(allShortTerm.length * drainPct));
    const drained = allShortTerm.slice(0, drainCount);
    const last = drained[drained.length - 1];
    const drainCutoff = last.created_at;
    // Keep the cutoff id as a string end-to-end. better-sqlite3 returns
    // INTEGER PRIMARY KEY values as JS Number by default (no safeIntegers),
    // which loses precision past 2^53 — and the wire-format trip through
    // drain_id (string) + Number(idStr) re-parse used to do the precision-
    // lossy Number coercion twice. Stringifying once here and parsing as
    // BigInt at the receiving side keeps the value precision-safe even if
    // we later flip the connection to safeIntegers=true. JSON-safe too —
    // BigInt in the response would throw on JSON.stringify.
    const drainCutoffIdStr = String(last.id);
    const drainId = `${sessionId || 'all'}|${drainCutoff}|${drainCutoffIdStr}`;

    // Claim every drained row before returning so a parallel drainBatch
    // can't double-grab. finalizeDrain hard-deletes these entries; the FK
    // CASCADE removes the lock rows in the same step.
    const acquiredAt = new Date().toISOString();
    const claim = store.db.prepare(
      'INSERT INTO drain_locks (entry_id, drain_id, acquired_at) VALUES (?, ?, ?)',
    );
    for (const row of drained) {
      claim.run(row.id, drainId, acquiredAt);
    }

    const exchanges = groupIntoExchanges(drained, exchangeCharBudget);

    return {
      drain_id: drainId,
      drain_cutoff: drainCutoff,
      drain_cutoff_id: drainCutoffIdStr,
      session_id: sessionId,
      drained_count: drained.length,
      exchanges,
      existing_long_term_summary: summarizeLongTerm(store),
    };
  });
  return drainTxn.immediate();
}

// Chronological max of two provenance timestamps, NULL-tolerant. Both the
// JSONL rec.timestamp and store.js created_at are fixed-width ISO-8601 UTC
// (`YYYY-MM-DDTHH:mm:ss.sssZ`), so lexicographic order IS chronological
// order — no Date parsing needed (and a string compare can't throw on a
// malformed value the way Date math silently producing NaN could). Returns
// null only when BOTH inputs are null/absent.
function maxIsoTs(a, b) {
  if (typeof a !== 'string' || a.length === 0) return typeof b === 'string' && b.length ? b : null;
  if (typeof b !== 'string' || b.length === 0) return a;
  return a >= b ? a : b;
}

export function groupIntoExchanges(rows, charBudget = DEFAULT_EXCHANGE_CHAR_BUDGET) {
  const out = [];
  let current = null;
  let currentChars = 0;
  let exchangeIdx = 0;
  // When a logical exchange exceeds charBudget and gets soft-split, the first
  // part keeps its bare `ex-N` id and subsequent parts get `ex-N-partK` so the
  // consolidator skill can still see they're halves of one thread (regex:
  // `^ex-(\d+)(?:-part\d+)?$`). Without the suffix, two halves of the same
  // conversation look like independent exchanges and cross-half supersede
  // detection in the dream cycle loses the link.
  let baseIdx = -1;
  let partIdx = 0;

  for (const row of rows) {
    const opens = STORED_EXCHANGE_OPENERS.has(row.kind);
    if (opens || !current) {
      if (current) out.push(current);
      baseIdx = exchangeIdx++;
      partIdx = 0;
      current = {
        exchange_id: `ex-${baseIdx}`,
        rows: [],
        token_estimate: 0,
        // Representative provenance time of this exchange = max of its rows'
        // event_ts (NULLs ignored). The dream skill forwards this opaque
        // value to retain_fact as `event_ts` (like it forwards drain_id) so
        // the LLM never does timestamp arithmetic itself. NULL when no row
        // in the exchange carries a source event time (all live rows).
        event_ts: null,
      };
      currentChars = 0;
    }
    // If adding this row would exceed the budget, soft-split — keep the same
    // base id, advance the part suffix. Each part recomputes its own
    // representative event_ts from only the rows it actually holds.
    if (currentChars + row.content.length > charBudget && current.rows.length) {
      out.push(current);
      partIdx++;
      current = {
        exchange_id: `ex-${baseIdx}-part${partIdx + 1}`,
        rows: [],
        token_estimate: 0,
        event_ts: null,
      };
      currentChars = 0;
    }
    const rowEventTs = row.event_ts ?? null;
    current.rows.push({
      id: row.id,
      kind: row.kind,
      content: row.content,
      // ts stays created_at — the consolidator/skill ordering and the
      // dropped-archive are lifecycle concerns (created_at only). event_ts
      // is a SEPARATE field so a row that has one exposes both honestly.
      ts: row.created_at,
      event_ts: rowEventTs,
    });
    current.event_ts = maxIsoTs(current.event_ts, rowEventTs);
    currentChars += row.content.length;
    current.token_estimate = Math.ceil(currentChars / 4); // rough chars→tokens
  }
  if (current && current.rows.length) out.push(current);
  return out;
}

function summarizeLongTerm(store) {
  // Group by (category, scope) so the calling Claude session sees the
  // orthogonal-axis split when deciding what to distill / where to scope
  // newly retained facts. Key shape: "<category>/<scope>" (e.g.
  // "fact/user", "fact/project", "procedural/role:planner",
  // "episodic/project").
  const rows = store.countByCategoryScope();
  const out = {};
  for (const r of rows) {
    out[`${r.category}/${r.scope}`] = r.n;
  }
  return out;
}

export async function retainFact({
  store,
  sessionId = null,
  drainId = null,
  exchangeId = null,
  content,
  category,
  scope = null,
  entities = null,
  confidence = null,
  // Representative provenance time of the originating exchange (max of its
  // rows' event_ts, computed deterministically in groupIntoExchanges and
  // forwarded opaquely by the dream skill). NULL for ad-hoc /mindwright:retain
  // and live distillation with no historical source — the governing invariant
  // makes NULL behave exactly as today via COALESCE in retrieval.
  eventTs = null,
  embed,
  rerank = null,
}) {
  if (!content || !category) {
    const e = new Error('retainFact requires content and category');
    e.code = 'INVALID_FACT_INPUT';
    throw e;
  }
  if (!scope) {
    const e = new Error('retainFact requires scope (user | project | role:<role>)');
    e.code = 'INVALID_FACT_INPUT';
    throw e;
  }

  // Embed if a fn is provided; otherwise insert with NULL embedding for the
  // sweeper to backfill.
  let emb = null;
  if (embed) {
    try {
      const out = await embed([content]);
      emb = out[0] || null;
    } catch {
      emb = null; // degrade silently — sweeper picks it up
    }
  }

  // Authorship: prefer the explicit arg, then the store's bound sessionId,
  // then the literal 'consolidator' for callers that have neither (the dream
  // skill in unbound-MCP mode, plus unit tests that exercise retainFact in
  // isolation).
  const authorSessionId = sessionId || store.sessionId || 'consolidator';

  // Resolve entities as [{name, kind}, ...]. extractEntities already
  // classifies; caller-supplied names route through the same classifyEntity
  // helper so we have one source of truth instead of two regex sets that
  // could silently diverge.
  const ents = (entities && entities.length)
    ? entities.map((name) => ({ name, kind: classifyEntity(name) }))
    : extractEntities(content);

  // Insert + entity link happen under one transaction so a mid-loop failure
  // rolls back the new entry instead of leaving it with partial graph state.
  // better-sqlite3 nests this around insertEntry's own transaction via
  // savepoints.
  //
  // source_ref stamps the inserted long-term row with the drainId so
  // finalizeDrain can count exactly the rows this drain produced —
  // independent of ad-hoc /mindwright:retain or /mindwright:update_memory
  // calls that may fire between drainBatch and finalizeDrain in the same
  // session.
  const sourceRef = drainId ? `drain:${drainId}` : null;
  const txn = store.db.transaction(() => {
    const insertedId = store.insertEntry({
      tier: 'long',
      category,
      scope,
      kind: KIND_FACT,
      content,
      sourceRef,
      sessionId: authorSessionId,
      confidence,
      eventTs,
      embedding: emb,
    });
    for (const { name, kind } of ents) {
      const eid = store.upsertEntity(name, kind);
      store.linkEntry(insertedId, eid);
    }
    return insertedId;
  });
  const id = txn();

  // Supersede candidate detection: retrieve over long-term tier with the new
  // fact's text as query; any close-match active rows other than the just-
  // inserted one are candidates.
  //
  // Race note (single-session is the contract): insert + retrieve are NOT
  // atomic per-fact. better-sqlite3 in WAL serializes writes, so concurrent
  // retainFact A and B will commit sequentially — but A's retrieve still
  // runs after A's insert commits and may not see B if B inserts in
  // between. The dream cycle is single-session and sequential (the calling
  // Claude session iterates through facts one at a time), so this only
  // bites when two different /mindwright:dream sessions race. In that case
  // the supersede surfaces asymmetrically (the later inserter sees the
  // earlier one as a candidate), which is acceptable — the calling session
  // still gets to call mark_superseded on the side it picked.
  const candidates = await findSupersedeCandidates({
    store, embed, rerank, content, insertedId: id,
  });

  return { fact_id: id, supersede_candidates: candidates };
}

// Run the long-tier retrieve and filter out the just-inserted id. Shared by
// retainFact (dream cycle) and the retainHandler MCP path (explicit
// /mindwright:retain), which had textually duplicated supersede blocks.
// Returns [] when no embed function is provided (no semantic query to run).
// Callers that need swallow-on-error can wrap; this helper lets retrieve()
// throws propagate so retainFact preserves its existing failure surface.
//
// `insertedId` is compared as Number — both lastInsertRowid (BigInt) and
// h.id (Number from retrieve) sit comfortably under MAX_SAFE_INTEGER for
// any realistic install (>9 quadrillion rows to overflow).
export async function findSupersedeCandidates({ store, embed, rerank, content, insertedId }) {
  if (!embed) return [];
  // Push tier: 'long' into each retriever's SQL so the 50-per-retriever
  // candidate pool only contains long-term rows — otherwise short-term
  // chunks that happen to be semantically near the new fact eat candidate
  // slots and get discarded post-rerank, halving effective recall on
  // stores with a lot of short-term content.
  const hits = await retrieve({ store, queryText: content, embed, rerank, tier: 'long' });
  const insertedIdNum = Number(insertedId);
  return hits.map((h) => Number(h.id)).filter((hidNum) => hidNum !== insertedIdNum);
}

export function markSuperseded(store, oldId, newId) {
  store.markSuperseded(oldId, newId);
  return { ok: true };
}

export function finalizeDrain({
  store,
  drainId,
  drainCutoff = null,
  drainCutoffId = null,
  sessionId = null,
}) {
  // Re-pull the rows we promised to drain. The cutoff is a (created_at, id)
  // tuple so rows that share a millisecond with the boundary are partitioned
  // deterministically. Plain `created_at <= cutoff` would over-delete when an
  // entire PreToolUse burst commits inside a single db.transaction (all rows
  // get the same ms-resolution ISO timestamp). A missing or falsy `drainCutoff`
  // would let the DELETE run unbounded across the whole scope, so we refuse —
  // legitimate callers always have a real (cutoff, id) tuple from drainBatch.
  //
  // Accept BigInt, Number, or string for drainCutoffId. drainBatch now emits
  // a string (precision-safe past 2^53); the MCP tool parses it to BigInt
  // before passing it here; the in-process dream cycle may pass either.
  // Normalize to BigInt for the SQL bind — better-sqlite3 binds BigInt to
  // INTEGER columns natively and never loses precision.
  let cutoffIdBig;
  try {
    if (typeof drainCutoffId === 'bigint') {
      cutoffIdBig = drainCutoffId;
    } else if (typeof drainCutoffId === 'number') {
      if (!Number.isFinite(drainCutoffId)) throw new Error('non-finite');
      cutoffIdBig = BigInt(drainCutoffId);
    } else if (typeof drainCutoffId === 'string' && /^-?\d+$/.test(drainCutoffId)) {
      cutoffIdBig = BigInt(drainCutoffId);
    } else {
      throw new Error('not an integer-shaped value');
    }
  } catch {
    cutoffIdBig = null;
  }
  // ISO-format check at the helper boundary. The MCP dispatcher
  // (mcp/tools.mjs#finalizeDrainHandler) already validates via Date.parse,
  // but finalizeDrain is exported and used directly by tests and the
  // in-process dream cycle. A non-ISO truthy string (e.g. 'foo') would
  // lexically out-rank every real ISO timestamp and the `(created_at, id)
  // <= (?, ?)` predicate would over-match and over-delete. Defense in
  // depth at the function that actually issues the DELETE.
  const cutoffOk =
    typeof drainCutoff === 'string' &&
    drainCutoff.length > 0 &&
    !Number.isNaN(Date.parse(drainCutoff));
  if (!cutoffOk || cutoffIdBig === null) {
    const e = new Error(
      `finalizeDrain requires drainCutoff and drainCutoffId (got drainCutoff=${JSON.stringify(drainCutoff)}, drainCutoffId=${JSON.stringify(typeof drainCutoffId === 'bigint' ? String(drainCutoffId) : drainCutoffId)})`,
    );
    e.code = 'INVALID_DRAIN_CUTOFF';
    throw e;
  }
  if (typeof drainId !== 'string' || !drainId) {
    const e = new Error(
      `finalizeDrain requires a non-empty drainId (got ${JSON.stringify(drainId)}) — it is the partition key that scopes the delete to this drain's claimed rows.`,
    );
    e.code = 'INVALID_DRAIN_ID';
    throw e;
  }

  // Partition the SELECT/DELETE by drain_id via drain_locks — NOT by the
  // (created_at, id) tuple alone. Two concurrent drains in the same scope
  // (e.g., two scope='all' dream cycles) hold disjoint slices via drain_locks,
  // but the slice with the HIGHER cutoff would otherwise scoop up the
  // slice with the LOWER cutoff when it finalizes — over-deleting the
  // peer's locked rows and CASCADE-destroying the peer's drain_lock entries
  // (FK ON DELETE CASCADE in 0001_init.sql:131). The cutoff tuple stays as
  // a defense-in-depth guard so a stale lock can never expand a drain's
  // delete window past its original cutoff.
  const params = [drainId];
  let where = "tier='short' AND active=1"
    + ' AND id IN (SELECT entry_id FROM drain_locks WHERE drain_id = ?)'
    + ' AND (created_at, id) <= (?, ?)';
  params.push(drainCutoff, cutoffIdBig);
  if (sessionId) {
    where += ' AND session_id = ?';
    params.push(sessionId);
  }

  // Pull the full row payload (including kind / session_id / created_at) so
  // we can write the audit archive before hard-delete. The consolidator can
  // legitimately produce 0 facts from a batch — without an archive that's
  // silent data loss the user has no way to inspect or recover.
  const rows = store.db.prepare(
    `SELECT id, kind, session_id, created_at, content FROM entries WHERE ${where} ORDER BY created_at ASC, id ASC`,
  ).all(...params);

  if (!rows.length) {
    return { drained_count: 0, produced_count: 0, superseded_count: 0, latency_ms: 0, archive_path: null };
  }

  const startedAt = Date.now();
  const firedAt = new Date(startedAt).toISOString();
  const drainedBytes = rows.reduce((acc, r) => acc + Buffer.byteLength(r.content, 'utf8'), 0);
  const drainedIds = rows.map((r) => r.id);

  // produced_count counts long-term rows this drain caused — and ONLY this
  // drain. retainFact stamps each inserted long-term row's source_ref with
  // `drain:<drainId>` so we can count exactly the rows this drain produced
  // without confusion from ad-hoc /mindwright:retain, /mindwright:update_memory,
  // or /mindwright:resolve_contradiction calls that legitimately fire between
  // drainBatch and finalizeDrain in the same session.
  const produced = store.db.prepare(
    `SELECT COUNT(*) AS n FROM entries
       WHERE tier='long' AND active=1 AND source_ref = ?`,
  ).get(`drain:${drainId}`).n;

  // Count old facts the calling session marked superseded during this drain.
  // entry_supersedes was written by every mindwright_mark_superseded call;
  // we want only the rows whose `new_id` is a long-term row this drain just
  // produced (same source_ref filter as `produced`). This lets the dream
  // skill's step-7 report show an accurate "superseded K old facts" line
  // instead of always reading 0 and lying to the user.
  const superseded = store.db.prepare(
    `SELECT COUNT(*) AS n FROM entry_supersedes
       WHERE new_id IN (
         SELECT id FROM entries WHERE source_ref = ?
       )`,
  ).get(`drain:${drainId}`).n;

  // Write the audit archive BEFORE the hard-delete so a crash mid-finalize
  // never leaves us with rows gone from SQL and no on-disk record.
  let archivePath = null;
  try {
    archivePath = writeDroppedArchive({
      drainId,
      sessionId,
      firedAt,
      rows,
      producedCount: produced,
    });
  } catch (e) {
    // Archive failure must not block the drain — fail loud on stderr but
    // proceed. Worst case the user loses the on-disk audit copy for THIS
    // drain; the consolidator already retained whatever it judged worth
    // retaining.
    process.stderr.write(`[mindwright/consolidator] dropped-archive write failed: ${e.message}\n`);
  }

  store.hardDeleteShortTerm(drainedIds);

  store.recordConsolidation({
    sessionId: sessionId || 'all',
    drainedCount: drainedIds.length,
    drainedBytes,
    producedCount: produced,
  });

  renderAll(store);

  return {
    drained_count: drainedIds.length,
    produced_count: produced,
    superseded_count: superseded,
    latency_ms: Date.now() - startedAt,
    archive_path: archivePath,
  };
}

