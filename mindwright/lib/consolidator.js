// Deterministic stages of the dream cycle (LLM work is done by the calling
// session via the /mindwright:dream skill).
//
// `drain_id` encodes the boundary as a (created_at, id) tuple, NOT just
// created_at: a single PreToolUse burst commits cli_prompt+thinking+text under
// one transaction with identical ms-resolution timestamps, so without the id
// tie-breaker finalizeDrain would hard-delete rows the dream cycle never saw.
// Wire format `<scope>|<cutoff_ts>|<cutoff_id>` (`|` because ISO ts contain
// `:`); scope is `<sessionId>` or the literal `all`.

import { renderAll, writeDroppedArchive } from './mirrors.js';
import { extractEntities, classifyEntity } from './entities.js';
import { retrieve } from './retriever.js';
import { STORED_EXCHANGE_OPENERS, KIND_FACT, MS_PER_HOUR, DRAIN_MAX_ROWS } from './constants.js';

// Drain the oldest DEFAULT_DRAIN_PCT of short-term — but never more than
// DRAIN_MAX_ROWS in one pass (the SELECT is LIMIT-capped), so a huge seed
// backlog is consolidated over many bounded passes instead of one the
// consolidator can't digest.
const DEFAULT_DRAIN_PCT = 0.7;

const DEFAULT_EXCHANGE_CHAR_BUDGET = 12_000;

// A drain claim older than this is almost certainly abandoned (process died);
// drainBatch reclaims its rows so they aren't permanently stuck out-of-band.
const STALE_LOCK_HOURS = 6;

export function drainBatch({
  store,
  sessionId = null, // null → all sessions
  drainPct = DEFAULT_DRAIN_PCT,
  exchangeCharBudget = DEFAULT_EXCHANGE_CHAR_BUDGET,
}) {
  // Pick-and-claim runs under BEGIN IMMEDIATE so two concurrent dream sessions
  // can't both observe "no lock yet" and claim the same slice: the first to
  // commit wins, the second sees them filtered by `NOT IN (drain_locks)`.
  const staleCutoff = new Date(Date.now() - STALE_LOCK_HOURS * MS_PER_HOUR).toISOString();
  const drainTxn = store.db.transaction(() => {
    // Expire stale claims so abandoned drains release their rows back into
    // the pool (orphan lock rows whose owning drain never finalized).
    store.db.prepare('DELETE FROM drain_locks WHERE acquired_at < ?').run(staleCutoff);

    // GOVERNING INVARIANT: event_ts is additive payload only and must never
    // enter drain selection or the finalize cursor. It is NULL for live rows
    // and non-monotonic within a seeded batch, so ordering on it would corrupt
    // which rows drain/delete. ORDER BY stays (created_at ASC, id ASC).
    //
    // `pending_session_id IS NULL` keeps live-staged rows out of the drain.
    // Pending rows are tier='short' but not yet "in" memory; draining them
    // would distill content the originating session still has live in
    // context, doubling it as a long-tier fact while the same content is
    // about to land as a normal short-term row at the next PreCompact.
    //
    // Session-scope is one optional predicate. Building the WHERE once
    // avoids the drift hazard of two near-identical SQL bodies — any future
    // filter change (a new column, an ORDER BY tweak) lands in exactly one
    // place. better-sqlite3 caches prepared statements by SQL text, so the
    // dynamic variant just becomes two distinct cache entries (same as the
    // old ternary) without losing the preparation benefit.
    const sessionFilter = sessionId ? ' AND session_id=?' : '';
    const sessionParams = sessionId ? [sessionId] : [];
    const allShortTerm = store.db.prepare(`
      SELECT id, kind, content, session_id, created_at, event_ts
        FROM entries
       WHERE tier='short' AND active=1 AND pending_session_id IS NULL${sessionFilter}
         AND id NOT IN (SELECT entry_id FROM drain_locks)
       ORDER BY created_at ASC, id ASC
       LIMIT ?
    `).all(...sessionParams, DRAIN_MAX_ROWS);

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

    // allShortTerm is LIMIT-capped at DRAIN_MAX_ROWS, oldest-first. Hitting
    // that cap means older rows are still queued behind this window, so the
    // live "keep the freshest 30% in short-term" rule doesn't apply — drain
    // the whole bounded window and let the next pass take the next one. Only
    // when the entire remaining backlog fits under the cap do we apply
    // drainPct (unchanged live behavior).
    const atCap = allShortTerm.length >= DRAIN_MAX_ROWS;
    const drainCount = atCap
      ? allShortTerm.length
      : Math.max(1, Math.floor(allShortTerm.length * drainPct));
    const drained = allShortTerm.slice(0, drainCount);
    const last = drained[drained.length - 1];
    const drainCutoff = last.created_at;
    // Cutoff id as a string end-to-end: better-sqlite3 returns rowids as JS
    // Number (loses precision past 2^53) and BigInt would throw on
    // JSON.stringify. Stringify once here, parse as BigInt at the receiver.
    const drainCutoffIdStr = String(last.id);
    const drainId = `${sessionId || 'all'}|${drainCutoff}|${drainCutoffIdStr}`;

    // Claim every drained row before returning so a parallel drainBatch can't
    // double-grab (FK CASCADE removes the lock rows on hard-delete).
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

// Chronological max of two NULL-tolerant provenance timestamps. Inputs are
// fixed-width ISO-8601 UTC, so lexicographic order IS chronological order — no
// Date parsing (string compare can't NaN the way Date math silently can).
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
  // Soft-split parts keep the base `ex-N` id with an `ex-N-partK` suffix so
  // the dream cycle still sees them as halves of one thread; without it
  // cross-half supersede detection loses the link.
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
        // Max of this exchange's rows' event_ts (NULLs ignored); forwarded
        // opaquely to retain_fact so the LLM never does ts arithmetic. NULL
        // when no row carries a source event time.
        event_ts: null,
      };
      currentChars = 0;
    }
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
      // ts is lifecycle (created_at only); event_ts is a separate field.
      ts: row.created_at,
      event_ts: rowEventTs,
    });
    current.event_ts = maxIsoTs(current.event_ts, rowEventTs);
    currentChars += row.content.length;
    current.token_estimate = Math.ceil(currentChars / 4);
  }
  if (current && current.rows.length) out.push(current);
  return out;
}

function summarizeLongTerm(store) {
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
  // Originating exchange's event_ts, forwarded opaquely. NULL for ad-hoc
  // retain / live distillation — treated via COALESCE in retrieval.
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

  let emb = null;
  if (embed) {
    try {
      const out = await embed([content]);
      emb = out[0] || null;
    } catch {
      emb = null; // degrade silently — sweeper picks it up
    }
  }

  // Author: explicit arg, then store's bound sessionId, then literal
  // 'consolidator' for callers (CLI without --session-id, unit tests) with
  // neither.
  const authorSessionId = sessionId || store.sessionId || 'consolidator';

  // Caller-supplied names route through the same classifyEntity helper as the
  // free-text scan so there's one source of truth, not two divergent regex sets.
  const ents = (entities && entities.length)
    ? entities.map((name) => ({ name, kind: classifyEntity(name) }))
    : extractEntities(content);

  // One transaction: a mid-loop failure rolls back the new entry instead of
  // leaving partial graph state. source_ref stamps the row with the drainId so
  // finalizeDrain counts exactly this drain's rows, independent of ad-hoc
  // retain/update calls between drainBatch and finalizeDrain.
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

  // Race note: insert + retrieve are NOT atomic per-fact. The dream cycle is
  // single-session sequential, so this only bites when two dream sessions
  // race; then the supersede surfaces asymmetrically (later inserter sees the
  // earlier as a candidate), which is acceptable — the session still picks a
  // side via mark_superseded.
  const candidates = await findSupersedeCandidates({
    store, embed, rerank, content, insertedId: id,
  });

  return { fact_id: id, supersede_candidates: candidates };
}

// Long-tier retrieve, filtering out the just-inserted id. Returns [] with no
// embed fn. Lets retrieve() throws propagate (retainFact's failure surface).
export async function findSupersedeCandidates({ store, embed, rerank, content, insertedId }) {
  if (!embed) return [];
  // Push tier:'long' into retriever SQL so the candidate pool isn't eaten by
  // semantically-near short-term chunks (would halve effective recall).
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
  // Cutoff is a (created_at, id) tuple: plain `created_at <= cutoff`
  // over-deletes when a PreToolUse burst commits under one transaction with
  // identical ms-resolution timestamps. A missing/falsy drainCutoff would let
  // the DELETE run unbounded across the whole scope, so refuse.
  //
  // Accept BigInt/Number/string for drainCutoffId; normalize to BigInt for the
  // SQL bind (better-sqlite3 binds BigInt to INTEGER without precision loss).
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
  // ISO-format check here too (defense in depth at the DELETE): a non-ISO
  // truthy string lexically out-ranks every real ISO timestamp so the
  // `(created_at, id) <= (?, ?)` predicate would over-match and over-delete.
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

  // Partition the SELECT/DELETE by drain_id via drain_locks, NOT by the
  // (created_at, id) tuple alone: two concurrent same-scope drains hold
  // disjoint slices, but the higher-cutoff one would otherwise scoop up the
  // lower-cutoff slice and CASCADE-destroy the peer's drain_lock entries. The
  // cutoff tuple stays as defense-in-depth so a stale lock can't expand the
  // delete window past the original cutoff.
  const params = [drainId];
  // pending_session_id IS NULL is defense-in-depth: drain_locks acquired in
  // drainBatch already exclude pending (the SELECT filters it), so no
  // pending row can hold a drain_locks row. Match the SELECT shape anyway in
  // case a future caller seeds drain_locks from another path.
  let where = "tier='short' AND active=1 AND pending_session_id IS NULL"
    + ' AND id IN (SELECT entry_id FROM drain_locks WHERE drain_id = ?)'
    + ' AND (created_at, id) <= (?, ?)';
  params.push(drainCutoff, cutoffIdBig);
  if (sessionId) {
    where += ' AND session_id = ?';
    params.push(sessionId);
  }

  // Full row payload for the pre-delete audit archive: a drain can
  // legitimately produce 0 facts, which without the archive is unrecoverable
  // silent data loss.
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

  // Count only THIS drain's long-term rows (source_ref = drain:<id>), so
  // ad-hoc retain/update/resolve calls between drainBatch and finalizeDrain
  // don't inflate it.
  const produced = store.db.prepare(
    `SELECT COUNT(*) AS n FROM entries
       WHERE tier='long' AND active=1 AND source_ref = ?`,
  ).get(`drain:${drainId}`).n;

  // Old facts superseded during THIS drain: only rows whose new_id is a
  // long-term row this drain produced (same source_ref filter as `produced`),
  // so the report's "superseded K" line is accurate, not always 0.
  const superseded = store.db.prepare(
    `SELECT COUNT(*) AS n FROM entry_supersedes
       WHERE new_id IN (
         SELECT id FROM entries WHERE source_ref = ?
       )`,
  ).get(`drain:${drainId}`).n;

  // Archive BEFORE hard-delete so a crash mid-finalize can't leave rows gone
  // from SQL with no on-disk record.
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
    // Archive failure must not block the drain — fail loud on stderr, proceed.
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

