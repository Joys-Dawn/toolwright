// SQLite + sqlite-vec + FTS5 store. One module owns every read/write path.
//
// Concurrency: WAL mode + busy_timeout=5000 lets the daemon and N hooks all
// open their own writer connections; SQLite serializes them. Each call here
// opens one connection — callers should reuse the returned `Store` per-process.
//
// Open-cost budget: openStore() runs (a) better-sqlite3 native init, (b) three
// pragma sets, (c) sqliteVec.load (extension load — the only non-trivial cost
// at a few ms), (d) runMigrations which short-circuits via a meta SELECT once
// the schema is current. Per-firing cost on a warm machine is < 50ms p99
// (smoke-tested locally — Phase 0 of the planning checklist). Each hook is a
// fresh Node process so there is no cross-firing connection to reuse, by
// design; that's the cost of writes from short-lived scripts rather than
// going through the daemon. Long-running clients (the MCP server itself,
// scripts/setup.js, scripts/status.js) open once and reuse the Store.
//
// Int8 vectors: transformers.js produces Float32Array (CLS-pooled + L2-normalized
// so each component sits in [-1, 1]). We quantize client-side by * 127 + round,
// then bind the resulting Int8Array buffer through `vec_int8(?)` — the bare
// buffer is rejected as float32 (smoke-tested 2026-05-12).
//
// rowid binding: vec_index demands an integer primary key. better-sqlite3 binds
// JS `Number` as float64 which sqlite-vec rejects. Pass rowids as `BigInt`
// (smoke-tested 2026-05-12).

import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { readdirSync, readFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { dbPath, migrationsDir } from './paths.js';
import { tierScopeClause } from './scope-filter.js';
import { UNBOUND_SESSION_ID } from './constants.js';

const SCHEMA_VERSION_KEY = 'schema:version';

export function quantizeToInt8(float32Vec) {
  const out = new Int8Array(float32Vec.length);
  for (let i = 0; i < float32Vec.length; i++) {
    const v = float32Vec[i] * 127;
    out[i] = Math.max(-128, Math.min(127, Math.round(v)));
  }
  return out;
}

export function openStore({ path = dbPath(), readonly = false, sessionId = null } = {}) {
  const dir = dirname(path);
  // Owner-only mode (0o700) on POSIX so a co-located local user can't read
  // the DB (which embeds prompt history, peer messages, distilled facts) or
  // the markdown mirrors that share this directory. The daemon-pipe already
  // applies the same defense at 0o600 to its unix socket — extending it
  // here closes the matching file-mode side door. Harmless on Windows
  // (Node's chmod equivalent is a no-op; Windows ACLs handle access).
  // CWE-732 / CWE-276 defense in depth.
  const isNew = !existsSync(dir);
  if (isNew) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } else if (process.platform !== 'win32') {
    // Windows uses ACLs, not unix permission bits — Node's chmod is a no-op
    // there, so skip entirely. On POSIX a failure here means the
    // owner-only defense is lost; log stderr so an operator can spot the
    // pattern instead of silently losing the file-mode boundary.
    try { chmodSync(dir, 0o700); } catch (e) {
      process.stderr.write(
        `[mindwright/store] chmod(${dir}, 0o700) failed — owner-only defense not active: ${e && e.message ? e.message : e}\n`,
      );
    }
  }

  const db = new Database(path, { readonly });
  // Lock the DB file itself to owner-only — Database() doesn't take a mode,
  // so we tighten after the fact. Same Windows / POSIX split as above.
  if (!readonly && process.platform !== 'win32') {
    try { chmodSync(path, 0o600); } catch (e) {
      process.stderr.write(
        `[mindwright/store] chmod(${path}, 0o600) failed — owner-only defense not active: ${e && e.message ? e.message : e}\n`,
      );
    }
  }
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');

  sqliteVec.load(db);

  if (!readonly) runMigrations(db);

  return new Store(db, { sessionId });
}

// ── meta key-value plumbing ───────────────────────────────────────────────
// `meta` is a single (key PRIMARY KEY, value TEXT NOT NULL, updated_at) table.
// The upsert and the point-read were copy-pasted byte-identically across ~18
// call sites, each re-deriving its own timestamp (best-practices-1). These
// two helpers own the SQL and the timestamp; every caller goes through them.
// Per-caller JSON.parse / base64 / shape-validation stays in the caller —
// only the SQL string and the `new Date().toISOString()` are centralized.
// Module-level (not just Store methods) because runMigrations runs before
// `new Store()` and holds only the raw `db` handle; the Store methods
// `_metaSet`/`_metaGet` thinly delegate here.
function metaSet(db, key, value) {
  db.prepare(`
    INSERT INTO meta(key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
  `).run(key, value, new Date().toISOString());
}

// Raw stored value string, or null when the key is absent. `meta.key` is the
// table's PRIMARY KEY so .get() returns the single row (≡ the old
// `.all()[0]`), and `value` is NOT NULL so a null return unambiguously means
// "no row". The caller owns any decoding and the absent-vs-present meaning.
function metaGet(db, key) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : null;
}

function runMigrations(db) {
  const dir = migrationsDir();
  let files = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  } catch (e) {
    if (e.code === 'ENOENT') return;
    throw e;
  }

  // Read the initial applied-set BEFORE looping so we know which files to
  // even attempt. The meta table may not exist yet on first run (0001 creates
  // it), so we tolerate a missing table on the bootstrap read.
  let applied = new Set();
  try {
    const v = metaGet(db, SCHEMA_VERSION_KEY);
    if (v != null) applied = new Set(JSON.parse(v));
  } catch {
    // meta doesn't exist yet — nothing applied
  }

  // Per-migration transaction wraps both the DDL and the meta upsert so a
  // mid-statement crash leaves nothing half-applied — the next run re-tries
  // the whole migration from a clean meta state.
  //
  // Concurrent first-run race (cross-process WAL): two openStore() callers
  // can each read meta and see an empty applied set, both queue their 0001
  // transactions, SQLite serializes them via the write lock, and the SECOND
  // process then re-applies migrations the first already committed —
  // producing "duplicate column name" on ALTER TABLE statements that have no
  // `IF NOT EXISTS` syntax in SQLite.
  //
  // Fix: use BEGIN IMMEDIATE (better-sqlite3 transaction(...).immediate()) so
  // the write lock is acquired at BEGIN, then re-read the applied set INSIDE
  // the transaction. If a peer just committed this file, we observe it and
  // skip. The outer pre-loop read is kept only to know which files are
  // candidates to try at all — the in-txn re-read is the source of truth.
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(dir, file), 'utf8');
    const applyTxn = db.transaction(() => {
      let inTxnApplied = new Set();
      try {
        const v = metaGet(db, SCHEMA_VERSION_KEY);
        if (v != null) inTxnApplied = new Set(JSON.parse(v));
      } catch {
        // meta still doesn't exist — must be the very first migration
      }
      if (inTxnApplied.has(file)) {
        // Peer committed this one while we were waiting on the write lock.
        applied.add(file);
        return;
      }
      db.exec(sql);
      inTxnApplied.add(file);
      const value = JSON.stringify([...inTxnApplied]);
      metaSet(db, SCHEMA_VERSION_KEY, value);
      applied = inTxnApplied;
    });
    // .immediate() → BEGIN IMMEDIATE: acquire the write lock at BEGIN so we
    // never read meta before another process has finished writing it.
    applyTxn.immediate();
  }
}

class Store {
  constructor(db, { sessionId = null } = {}) {
    this.db = db;
    this.sessionId = sessionId;
  }

  // Late-bind the owning session id. The MCP server resolves its session id
  // asynchronously (after the SDK handshake), so the store is constructed
  // before the id is known. Callers that need it on retain helpers should
  // prefer passing `sessionId` to the helper directly; this setter is a
  // convenience for the daemon path where the same store handle services
  // every tool invocation.
  setSessionId(sessionId) {
    this.sessionId = sessionId || null;
  }

  close() {
    this.db.close();
  }

  // INSERT a new entry. If `embedding` is provided (Float32Array, length 1024),
  // we quantize and write to vec_index in the same transaction. Returns the
  // new entry id.
  //
  // Tier-shape contract (enforced by the DB CHECK):
  //   - tier='short': category null/'raw', scope null.
  //   - tier='long':  category in {procedural,episodic,fact}, scope in
  //                   {user,project,role:<role>}.
  insertEntry({
    tier,
    category = null,
    scope = null,
    kind,
    content,
    sourceRef = null,
    sessionId,
    // Optional provenance/event time (ISO string). Default NULL → the row
    // behaves exactly as before this column existed: retrieval recency
    // COALESCEs to created_at. Only transcript-derived paths (live flush,
    // retainFact's representative stamp, native-memory seed rows) pass it.
    // GOVERNING INVARIANT: this only ever feeds recency ranking — created_at
    // alone drives drain/finalize/safety-net lifecycle. Never thread eventTs
    // into any lifecycle query.
    eventTs = null,
    supersedes = null,
    confidence = null,
    embedding = null,
  }) {
    const now = new Date().toISOString();
    const txn = this.db.transaction(() => {
      const info = this.db.prepare(`
        INSERT INTO entries (tier, category, scope, kind, content, source_ref, session_id, created_at, event_ts, supersedes, confidence, active)
        VALUES (@tier, @category, @scope, @kind, @content, @sourceRef, @sessionId, @createdAt, @eventTs, @supersedes, @confidence, 1)
      `).run({ tier, category, scope, kind, content, sourceRef, sessionId, createdAt: now, eventTs, supersedes, confidence });

      const id = info.lastInsertRowid;
      if (embedding) {
        this.writeEmbedding(id, embedding);
      }
      return id;
    });
    return txn();
  }

  // Write or replace the embedding for an existing entry. The deferred-embed
  // sweeper reads pending ids, awaits the embedder (slow), then calls back
  // here — a concurrent hardDeleteShortTerm between those steps can wipe the
  // entries row. Guarding the insert behind an existence check inside one
  // transaction prevents an orphan vec_index row that has no matching entry.
  writeEmbedding(entryId, embedding) {
    if (!(embedding instanceof Float32Array)) {
      throw new Error('embedding must be a Float32Array');
    }
    if (embedding.length !== 1024) {
      throw new Error(`embedding length ${embedding.length} != 1024`);
    }
    const int8 = quantizeToInt8(embedding);
    const rowid = typeof entryId === 'bigint' ? entryId : BigInt(entryId);
    const txn = this.db.transaction(() => {
      const stillExists = this.db.prepare(
        'SELECT 1 FROM entries WHERE id = ?',
      ).get(rowid);
      if (!stillExists) return false;
      // DELETE-then-INSERT for replace semantics; vec0 tables don't support UPSERT.
      this.db.prepare('DELETE FROM vec_index WHERE rowid = ?').run(rowid);
      this.db.prepare(
        'INSERT INTO vec_index(rowid, embedding) VALUES (?, vec_int8(?))',
      ).run(rowid, Buffer.from(int8.buffer));
      return true;
    });
    return txn();
  }

  fetch(id) {
    return this.db.prepare('SELECT * FROM entries WHERE id = ?').get(id);
  }

  // Semantic NN search. Returns [{id, distance}] ordered by ascending distance.
  // tier (optional): 'short' | 'long' filter applied via the JOIN against
  // entries. Semantic note — this is NOT exactly-k for tier-filtered queries:
  // vec_index MATCH first picks the k cosine-closest neighbors across ALL
  // tiers, then the JOIN drops the rows whose tier doesn't match. Result is
  // "up to k tier-matching rows, fewer if vec_index's k-closest spans both
  // tiers." The downstream RRF + rerank pass only consumes top-20 anyway, so
  // partial recall here is absorbed; if the consumer needs exactly-k it must
  // over-request itself (caller-supplied k > target_k).
  // roles (optional): when provided (array, possibly empty), scopes long-tier
  // rows by `scope LIKE 'role:%'` per `scopeFilterClause`. User-scoped and
  // project-scoped facts pass through regardless.
  semanticSearch(queryFloat32, k, tier = null, roles = null) {
    const int8 = quantizeToInt8(queryFloat32);
    const ts = tierScopeClause(tier, roles);
    return this.db.prepare(`
      SELECT v.rowid AS id, v.distance
        FROM vec_index v
        JOIN entries e ON e.id = v.rowid AND e.active = 1
       WHERE v.embedding MATCH vec_int8(?)
         AND v.k = ?${ts.clause}
       ORDER BY v.distance
    `).all(Buffer.from(int8.buffer), k, ...ts.params);
  }

  // BM25 keyword search via FTS5. Returns [{id, rank}] (rank is BM25 score, more-negative = better).
  bm25Search(queryText, k, tier = null, roles = null) {
    const ts = tierScopeClause(tier, roles);
    return this.db.prepare(`
      SELECT f.rowid AS id, bm25(fts) AS rank
        FROM fts f
        JOIN entries e ON e.id = f.rowid AND e.active = 1
       WHERE fts MATCH ?${ts.clause}
       ORDER BY rank
       LIMIT ?
    `).all(queryText, ...ts.params, k);
  }

  // Most-recent active rows. Recency = COALESCE(event_ts, created_at):
  // a row distilled/seeded from a historical transcript carries the true
  // event time in event_ts and must rank by THAT, not by its seed-run
  // created_at. event_ts is NULL for every live-captured row, so COALESCE
  // falls back to created_at — byte-identical to pre-change ordering for
  // them. The (…, e.id DESC) tiebreak is unchanged. This is a
  // relevance-ranking read ONLY; the governing invariant forbids event_ts
  // from any lifecycle/drain/finalize SQL.
  temporalSearch(k, tier = null, roles = null) {
    const ts = tierScopeClause(tier, roles);
    return this.db.prepare(`
      SELECT e.id FROM entries e
       WHERE e.active = 1${ts.clause}
       ORDER BY COALESCE(e.event_ts, e.created_at) DESC, e.id DESC
       LIMIT ?
    `).all(...ts.params, k);
  }

  // Soft-archive: flip active to 0.
  softArchive(id) {
    this.db.prepare('UPDATE entries SET active = 0 WHERE id = ?').run(id);
  }

  // Restore a previously soft-archived row by flipping active back to 1.
  // Inverse of softArchive — used by /mindwright:restore to recover from
  // typo-/mindwright:forget on the wrong fact id. Safe by construction:
  // soft-archive never deletes data, so the row + embedding + entity links
  // are intact and the flip is sufficient.
  restore(id) {
    this.db.prepare('UPDATE entries SET active = 1 WHERE id = ?').run(id);
  }

  // Mark an old fact superseded by a new one. Both ids must exist. The full
  // (new_id, old_id) edge is written to entry_supersedes so a merge of two
  // originals into one new row records BOTH parents (the entries.supersedes
  // column would silently lose one). The column is also updated for the
  // simple 1:1 case so downstream consumers that read it directly still see
  // a parent — last-wins for merges, but the join table is the truth.
  markSuperseded(oldId, newId, reason = null) {
    const txn = this.db.transaction(() => {
      this.db.prepare('UPDATE entries SET active = 0 WHERE id = ?').run(oldId);
      this.db.prepare('UPDATE entries SET supersedes = ? WHERE id = ?').run(oldId, newId);
      this.db.prepare(`
        INSERT INTO entry_supersedes(new_id, old_id, created_at, reason)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(new_id, old_id) DO NOTHING
      `).run(newId, oldId, new Date().toISOString(), reason);
    });
    txn();
  }

  // Return every old_id that a given new_id supersedes (full audit chain
  // including merges, which the entries.supersedes column can't represent).
  supersedeParents(newId) {
    return this.db.prepare(
      'SELECT old_id, created_at, reason FROM entry_supersedes WHERE new_id = ? ORDER BY created_at ASC',
    ).all(newId);
  }

  // Hard-delete short-term rows after a consolidation drain.
  hardDeleteShortTerm(ids) {
    if (!ids.length) return;
    // Chunk to stay under SQLite's compile-time variable cap (defaults to
    // 32766 on modern builds, but 999 on bundles built with the older
    // default — playing it safe keeps a long-running daemon's project-scope
    // consolidation from blowing up mid-drain). Apply the same chunking to
    // vec_index DELETEs so a 5000-row drain doesn't pay 5000 prepared-statement
    // executions on the vec table while entries is already batched at 10.
    const CHUNK = 500;
    const bigIds = ids.map((id) => (typeof id === 'bigint' ? id : BigInt(id)));
    // entries triggers will sync FTS; vec_index needs explicit cleanup. Run
    // everything in one transaction so partial failure rolls back cleanly.
    const txn = this.db.transaction(() => {
      for (let i = 0; i < bigIds.length; i += CHUNK) {
        const vecSlice = bigIds.slice(i, i + CHUNK);
        const vecPlaceholders = vecSlice.map(() => '?').join(',');
        this.db.prepare(`DELETE FROM vec_index WHERE rowid IN (${vecPlaceholders})`).run(...vecSlice);
      }
      for (let i = 0; i < ids.length; i += CHUNK) {
        const slice = ids.slice(i, i + CHUNK);
        const placeholders = slice.map(() => '?').join(',');
        this.db.prepare(`DELETE FROM entries WHERE id IN (${placeholders})`).run(...slice);
      }
    });
    txn();
  }

  // Per-session transcript offset accessors.
  getOffset(sessionId) {
    const row = this.db.prepare('SELECT last_read_byte FROM offsets WHERE session_id = ?').get(sessionId);
    return row ? row.last_read_byte : 0;
  }

  setOffset(sessionId, byte) {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO offsets(session_id, last_read_byte, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET last_read_byte=excluded.last_read_byte, updated_at=excluded.updated_at
    `).run(sessionId, byte, now);
  }

  // Entries with no embedding yet (created in write-only degraded mode). The
  // daemon sweeper picks these up when it boots and back-fills.
  // Rows whose embed_failures counter has exceeded the threshold are
  // excluded — they are poison content that reliably crashes the tokenizer,
  // and re-trying them every 60s blocks the head of the queue. Skip count
  // is exposed via countPoisonEmbeds() for mindwright_status visibility.
  pendingEmbedSweep(limit, { maxFailures = 5 } = {}) {
    return this.db.prepare(`
      SELECT e.id, e.content
        FROM entries e
        LEFT JOIN vec_index v ON v.rowid = e.id
       WHERE v.rowid IS NULL AND e.embed_failures < ?
       ORDER BY e.created_at ASC
       LIMIT ?
    `).all(maxFailures, limit);
  }

  // Bump the embed-failure counter for a row by 1. Called by the sweeper
  // on per-row embed exceptions.
  bumpEmbedFailure(entryId) {
    const rowid = typeof entryId === 'bigint' ? entryId : BigInt(entryId);
    this.db.prepare('UPDATE entries SET embed_failures = embed_failures + 1 WHERE id = ?').run(rowid);
  }

  // Cheap count for status displays. The full sweep returns row payloads and
  // is capped by `limit`; this returns the true outstanding total without
  // paying the wire cost or the LIMIT cap. Pending = no embedding yet AND
  // still under the retry threshold.
  countPendingEmbeds({ maxFailures = 5 } = {}) {
    return this.db.prepare(`
      SELECT COUNT(*) AS n
        FROM entries e
        LEFT JOIN vec_index v ON v.rowid = e.id
       WHERE v.rowid IS NULL AND e.embed_failures < ?
    `).get(maxFailures).n;
  }

  // Rows past the retry threshold — visible to status so persistent poison
  // content is observable rather than silently degrading recall.
  countPoisonEmbeds({ maxFailures = 5 } = {}) {
    return this.db.prepare(`
      SELECT COUNT(*) AS n
        FROM entries e
        LEFT JOIN vec_index v ON v.rowid = e.id
       WHERE v.rowid IS NULL AND e.embed_failures >= ?
    `).get(maxFailures).n;
  }

  recordConsolidation({ sessionId, drainedCount, drainedBytes, producedCount }) {
    const now = new Date().toISOString();
    return this.db.prepare(`
      INSERT INTO consolidations(session_id, fired_at, drained_count, drained_bytes, produced_count)
      VALUES (?, ?, ?, ?, ?)
    `).run(sessionId, now, drainedCount, drainedBytes, producedCount).lastInsertRowid;
  }

  // Counts for cap-check and status display.
  countShortTermFor(sessionId) {
    return this.db.prepare(
      'SELECT COUNT(*) AS n FROM entries WHERE tier = ? AND session_id = ? AND active = 1',
    ).get('short', sessionId).n;
  }

  // Short-term rows under OTHER bound sessions (excluding the synthetic
  // UNBOUND_SESSION_ID bucket). Used by drainBatch's cross-session hint to
  // tell a solo user "your past sessions have unconsolidated content."
  countShortTermInOtherSessions(currentSessionId) {
    return this.db.prepare(
      `SELECT COUNT(*) AS n FROM entries
        WHERE active = 1 AND tier = 'short'
          AND session_id != ?
          AND session_id != ?`,
    ).get(currentSessionId, UNBOUND_SESSION_ID).n;
  }

  // Project-wide short-term count, across every session. Used by the nudge
  // evaluator so a quiet user running many short sessions still gets a
  // "time to dream" surface when project-wide rows accumulate past
  // CAP_EXCHANGES — per-session caps would otherwise let hundreds of rows
  // pile up across days because no single session crossed the threshold.
  countShortTermAllSessions() {
    return this.db.prepare(
      'SELECT COUNT(*) AS n FROM entries WHERE tier = ? AND active = 1',
    ).get('short').n;
  }

  // Project-wide active short-term content size, in UTF-8 BYTES. The seed
  // loop's between-batch backpressure (lib/seed-consolidate.js) blocks until
  // this drops back under SEED_BATCH_BUDGET_BYTES, so it must measure the SAME
  // unit the loop accumulates (Buffer.byteLength(content,'utf8')). LENGTH() on
  // a TEXT value is the UTF-16 character count; CAST(content AS BLOB) makes
  // LENGTH() the true UTF-8 byte length. COALESCE handles the empty-table case
  // (SUM over zero rows is NULL). Recency-only invariant is irrelevant here —
  // this is a size measure, never an ordering/lifecycle predicate.
  shortTermBytes() {
    return this.db.prepare(
      `SELECT COALESCE(SUM(LENGTH(CAST(content AS BLOB))), 0) AS b
         FROM entries WHERE tier = 'short' AND active = 1`,
    ).get().b;
  }

  // Active rows parked under the synthetic UNBOUND_SESSION_ID —
  // these land when the MCP server boots without a SessionStart ticket.
  // Surfaced by mindwright_status as a warning so the user knows to drain.
  countUnboundActive() {
    return this.db.prepare(
      'SELECT COUNT(*) AS n FROM entries WHERE session_id = ? AND active = 1',
    ).get(UNBOUND_SESSION_ID).n;
  }

  // Unbound short-term subset of countUnboundActive — used by drainBatch's
  // cross-session hint where only the short-term tier is relevant.
  countUnboundShortTerm() {
    return this.db.prepare(
      "SELECT COUNT(*) AS n FROM entries WHERE session_id = ? AND active = 1 AND tier = 'short'",
    ).get(UNBOUND_SESSION_ID).n;
  }

  // Oldest active short-term row's `created_at` for the safety-net check.
  // Returns the ISO8601 string or null when the session has no short-term
  // rows. The Stop hook compares this against SAFETY_NET_DAYS to fire a
  // force-dream nudge on a quiet session where the row count never crosses
  // CAP_EXCHANGES but content has been aging unconsolidated.
  oldestShortTermCreatedAt(sessionId) {
    const row = this.db.prepare(
      'SELECT MIN(created_at) AS oldest FROM entries WHERE tier = ? AND session_id = ? AND active = 1',
    ).get('short', sessionId);
    return row && row.oldest ? row.oldest : null;
  }

  // Project-wide oldest short-term row, across every session. Pairs with
  // countShortTermAllSessions: the safety-net trigger fires globally so a
  // stale row in session B nudges session A on its next Stop.
  oldestShortTermAcrossAllSessions() {
    const row = this.db.prepare(
      'SELECT MIN(created_at) AS oldest FROM entries WHERE tier = ? AND active = 1',
    ).get('short');
    return row && row.oldest ? row.oldest : null;
  }

  // Oldest active long-term user-scoped fact's created_at. Used by
  // mindwright_status to warn about stale preferences — preferences don't
  // auto-decay, so a 6-month-old row looks identical to a 2-day-old one in
  // retrieval. Returns the ISO8601 string or null when no rows match.
  oldestUserPreference() {
    const row = this.db.prepare(
      `SELECT created_at FROM entries
        WHERE tier='long' AND active=1 AND category='fact' AND scope='user'
        ORDER BY created_at ASC LIMIT 1`,
    ).get();
    return row && row.created_at ? row.created_at : null;
  }

  countByTier() {
    const rows = this.db.prepare(
      'SELECT tier, COUNT(*) AS n FROM entries WHERE active = 1 GROUP BY tier',
    ).all();
    const out = { short: 0, long: 0 };
    for (const r of rows) out[r.tier] = r.n;
    return out;
  }

  countByCategory() {
    return this.db.prepare(
      'SELECT category, COUNT(*) AS n FROM entries WHERE tier = ? AND active = 1 AND category IS NOT NULL GROUP BY category',
    ).all('long');
  }

  // Per (category, scope) bucket count for mindwright_status display. Surfaces
  // the orthogonal-axis split (e.g. fact/user vs fact/project, procedural/role:planner
  // vs procedural/role:tester) that countByCategory alone can't show.
  countByCategoryScope() {
    return this.db.prepare(
      'SELECT category, scope, COUNT(*) AS n FROM entries WHERE tier = ? AND active = 1 AND category IS NOT NULL AND scope IS NOT NULL GROUP BY category, scope',
    ).all('long');
  }

  // Mirror-rendering accessors. Each returns the column subset
  // lib/mirrors.js needs to render its per-tier markdown file. Ordering is
  // DESC (newest first) so mirrors read like a reverse-chronological journal,
  // not a stable-diff-friendly log. Kept on Store so raw db.prepare doesn't
  // leak into mirrors.js (single-source-of-truth for SQL).

  // renderRecent — last N short-term observations, newest first.
  listShortTermRecent(limit) {
    return this.db.prepare(
      `SELECT id, kind, content, session_id, created_at
         FROM entries
        WHERE tier = 'short' AND active = 1
        ORDER BY created_at DESC, id DESC
        LIMIT ?`,
    ).all(limit);
  }

  // renderPreferences / renderProjectFacts / renderHeuristics — active
  // long-tier rows filtered by (category, scope). Order: DESC.
  listLongTermByCategoryScope(category, scope) {
    return this.db.prepare(
      `SELECT id, content, confidence, created_at, session_id
         FROM entries
        WHERE tier = 'long' AND category = ? AND scope = ? AND active = 1
        ORDER BY created_at DESC, id DESC`,
    ).all(category, scope);
  }

  // renderEpisodes — active long-tier episodic rows. No scope filter (episodes
  // can carry any scope); we select `scope` so the renderer can show it.
  listLongTermEpisodes() {
    return this.db.prepare(
      `SELECT id, content, scope, created_at, session_id
         FROM entries
        WHERE tier = 'long' AND category = 'episodic' AND active = 1
        ORDER BY created_at DESC, id DESC`,
    ).all();
  }

  // renderAll's heuristics fan-out — distinct role names currently carrying
  // any active procedural row. Strips the 'role:' prefix; callers should
  // still gate writes through the role whitelist (defense in depth).
  listActiveProceduralRoles() {
    return this.db.prepare(
      `SELECT DISTINCT substr(scope, 6) AS role
         FROM entries
        WHERE tier = 'long' AND category = 'procedural'
          AND scope LIKE 'role:%' AND active = 1 AND scope IS NOT NULL`,
    ).all().map((r) => r.role);
  }

  lastConsolidation() {
    return this.db.prepare(
      'SELECT * FROM consolidations ORDER BY fired_at DESC LIMIT 1',
    ).get();
  }

  // Entity linkage helpers.
  upsertEntity(name, kind) {
    this.db.prepare(`
      INSERT INTO entities(name, kind) VALUES (?, ?)
      ON CONFLICT(name) DO NOTHING
    `).run(name, kind);
    return this.db.prepare('SELECT id FROM entities WHERE name = ?').get(name).id;
  }

  linkEntry(entryId, entityId) {
    this.db.prepare(`
      INSERT INTO entry_entities(entry_id, entity_id) VALUES (?, ?)
      ON CONFLICT(entry_id, entity_id) DO NOTHING
    `).run(entryId, entityId);
  }

  // Thin delegators to the module-level meta plumbing (best-practices-1).
  // Every meta upsert/point-read in this class goes through these two so the
  // SQL + timestamp live in exactly one place; per-caller encoding stays in
  // the caller.
  _metaSet(key, value) { metaSet(this.db, key, value); }
  _metaGet(key) { return metaGet(this.db, key); }

  // Role assignments (per-session).
  setRoles(sessionId, roles) {
    this._metaSet(`roles:${sessionId}`, JSON.stringify([...new Set(roles)]));
  }

  getRoles(sessionId) {
    const v = this._metaGet(`roles:${sessionId}`);
    return v != null ? JSON.parse(v) : [];
  }

  // Pending nudge (per-session). Stop can't surface additionalContext (Claude
  // Code only honors it from UserPromptSubmit / SessionStart / PreToolUse —
  // verified in DESIGN.md "Verified facts"), so cap-reached etc. is staged
  // here and the next UserPromptSubmit hook drains it.
  setPendingNudge(sessionId, message) {
    this._metaSet(`pending_nudge:${sessionId}`, message);
  }

  // Returns the pending message and clears it atomically. Returns null if none.
  takePendingNudge(sessionId) {
    const key = `pending_nudge:${sessionId}`;
    const tx = this.db.transaction(() => {
      const v = this._metaGet(key);
      if (v == null) return null;
      this.db.prepare('DELETE FROM meta WHERE key = ?').run(key);
      return v;
    });
    return tx();
  }

  // Project-wide edge-trigger state for the cap-reached nudge. Without it,
  // the Stop hook would re-stage the same reminder every single turn until
  // the user runs /mindwright:dream — which is hostile (the user told
  // mindwright "later"; mindwright keeps shouting on every prompt). Values
  // come from NUDGE_STATES in constants.js: NUDGE_STATES.ARMED (next cap
  // crossing fires the nudge) | NUDGE_STATES.FIRED (already nudged this trip
  // — wait for count to drop below cap before re-arming). Returns null when
  // no value is set (caller treats as ARMED — first run on this DB).
  //
  // PROJECT-WIDE (not per-session): mindwright's triggers are project-wide
  // (countShortTermAllSessions / oldestShortTermAcrossAllSessions). Keying
  // nudge_state per-session caused a re-fire whenever a different session
  // opened on the same cap-crossed state — violating the README promise of
  // "once per cap crossing." A single shared key fixes that. Stale per-
  // session keys from older builds (`nudge_state:<uuid>`) are harmless
  // leftovers in `meta`; the next reset / migration sweep removes them.
  getNudgeState() {
    return this._metaGet('nudge_state');
  }

  setNudgeState(state) {
    this._metaSet('nudge_state', state);
  }

  // Per-session tool_use_id → tool_name map for the chunker. The transcript
  // writes a tool_use block in one assistant record and its matching
  // tool_result in a later user record; hook passes typically only see one of
  // them, so the map MUST persist across passes — otherwise a tool_result
  // arriving after the tool_use was consumed in a prior pass cannot be
  // classified and inbox events get silently dropped. Stored as JSON in
  // meta keyed by `tool_map:<sessionId>`.
  loadToolMap(sessionId) {
    const v = this._metaGet(`tool_map:${sessionId}`);
    if (v == null) return new Map();
    try {
      const obj = JSON.parse(v);
      if (obj && typeof obj === 'object') return new Map(Object.entries(obj));
    } catch (e) {
      // Unparseable tool_map indicates DB corruption or a hand-edit. We
      // recover by resetting (next saveToolMap overwrites cleanly), but log
      // to stderr so an operator can spot the pattern — a quiet "next pass
      // works" hides repeated parse failures that point at a real defect.
      process.stderr.write(
        `[mindwright/store] tool_map for session ${sessionId} unparseable, resetting: ${e && e.message ? e.message : e}\n`,
      );
    }
    return new Map();
  }

  saveToolMap(sessionId, map) {
    if (!(map instanceof Map)) return;
    this._metaSet(`tool_map:${sessionId}`, JSON.stringify(Object.fromEntries(map)));
  }

  // ──────────────────────────────────────────────────────────────────────
  // Per-session retrieval-injection state
  //
  // Two pieces of session-scoped state drive the novelty-gated proactive
  // recall in PreToolUse plus the cross-path dedup in PreToolUse +
  // UserPromptSubmit + mindwright_recall:
  //
  //   - meta:injected_fact_ids:<sessionId> — JSON array of fact ids already
  //     surfaced in the session's additionalContext, FIFO-capped (the cap
  //     itself lives in lib/constants.js — INJECTED_FACT_IDS_CAP).
  //
  //   - meta:last_retrieval_query_emb:<sessionId> — base64-encoded
  //     Float32Array(1024) of the embedding that drove the most recent
  //     retrieval fire. Used to detect novelty: a new thinking-block
  //     embedding whose cosine to this one is ≥ NOVELTY_THRESHOLD is
  //     suppressed.
  //
  // SessionStart clears both rows so a fresh boot starts cold.
  // ──────────────────────────────────────────────────────────────────────

  getInjectedFactIds(sessionId) {
    const v = this._metaGet(`injected_fact_ids:${sessionId}`);
    if (v == null) return [];
    try {
      const arr = JSON.parse(v);
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  }

  // Append ids to the injected-fact-id set, dedup + FIFO-trim to `cap`.
  // The new ids land at the tail; the head is dropped first. Returns the
  // resulting size.
  appendInjectedFactIds(sessionId, ids, cap) {
    if (!Array.isArray(ids) || ids.length === 0) {
      return this.getInjectedFactIds(sessionId).length;
    }
    const key = `injected_fact_ids:${sessionId}`;
    const tx = this.db.transaction(() => {
      const existing = this.getInjectedFactIds(sessionId);
      const seen = new Set(existing);
      for (const id of ids) {
        if (typeof id !== 'number' && typeof id !== 'bigint') continue;
        const n = Number(id);
        if (!Number.isFinite(n)) continue;
        if (seen.has(n)) continue;
        seen.add(n);
        existing.push(n);
      }
      const trimStart = cap && existing.length > cap ? existing.length - cap : 0;
      const trimmed = trimStart > 0 ? existing.slice(trimStart) : existing;
      this._metaSet(key, JSON.stringify(trimmed));
      return trimmed.length;
    });
    return tx();
  }

  clearInjectedFactIds(sessionId) {
    this.db.prepare('DELETE FROM meta WHERE key = ?').run(`injected_fact_ids:${sessionId}`);
  }

  // Float32Array → base64 round-trip via the underlying byte buffer.
  getLastQueryEmb(sessionId) {
    const v = this._metaGet(`last_retrieval_query_emb:${sessionId}`);
    if (v == null) return null;
    try {
      const buf = Buffer.from(v, 'base64');
      if (buf.byteLength !== 1024 * 4) return null;
      // Copy into a fresh ArrayBuffer so the returned view isn't tied to Buffer's
      // internal pool slice (which would let an unrelated write corrupt it).
      const ab = new ArrayBuffer(buf.byteLength);
      const dst = new Uint8Array(ab);
      dst.set(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
      return new Float32Array(ab);
    } catch {
      return null;
    }
  }

  setLastQueryEmb(sessionId, float32Vec) {
    if (!(float32Vec instanceof Float32Array)) {
      throw new Error('setLastQueryEmb: float32Vec must be a Float32Array');
    }
    if (float32Vec.length !== 1024) {
      throw new Error(`setLastQueryEmb: length ${float32Vec.length} != 1024`);
    }
    const key = `last_retrieval_query_emb:${sessionId}`;
    const buf = Buffer.from(float32Vec.buffer, float32Vec.byteOffset, float32Vec.byteLength);
    const b64 = buf.toString('base64');
    this._metaSet(key, b64);
  }

  clearLastQueryEmb(sessionId) {
    this.db.prepare('DELETE FROM meta WHERE key = ?').run(`last_retrieval_query_emb:${sessionId}`);
  }

  // ──────────────────────────────────────────────────────────────────────
  // Per-session "daemon-down warned" latch
  //
  // When the MCP daemon is unreachable, pipe.embed() returns null and the
  // retrieval hooks (UPS + PreToolUse) silently degrade to no-recall. Without
  // a user-visible signal, the user can't tell that retrieval was attempted-
  // and-failed vs no-relevant-facts-existed. We surface a single warning per
  // session via additionalContext the first time a hook sees the daemon down;
  // this latch is cleared by SessionStart so a fresh boot starts un-warned.
  // ──────────────────────────────────────────────────────────────────────
  wasDaemonDownWarned(sessionId) {
    // `value` is NOT NULL, so a non-null _metaGet ⟺ the row exists (≡ !!row).
    return this._metaGet(`daemon_down_warned:${sessionId}`) !== null;
  }

  markDaemonDownWarned(sessionId) {
    this._metaSet(`daemon_down_warned:${sessionId}`, '1');
  }

  clearDaemonDownWarned(sessionId) {
    this.db.prepare('DELETE FROM meta WHERE key = ?').run(`daemon_down_warned:${sessionId}`);
  }

  // ──────────────────────────────────────────────────────────────────────
  // Consolidator-spawner persistence
  //
  // meta:consolidator_for:<requester_handle> stores the deterministic UUID
  // of the consolidator session spawned for a particular requester+project
  // pair. Cross-session: persists forever (or until /mindwright:reset).
  // We persist only the UUID; the wrightward handle is recomputed at
  // display time via deriveHandle(uuid) from lib/handles.js.
  // ──────────────────────────────────────────────────────────────────────

  getConsolidatorFor(requesterHandle) {
    const v = this._metaGet(`consolidator_for:${requesterHandle}`);
    if (v == null) return null;
    try {
      const obj = JSON.parse(v);
      if (obj && typeof obj === 'object' && typeof obj.session_id === 'string') return obj;
    } catch {
      /* fall through */
    }
    return null;
  }

  // List every consolidator-for record. Returns an array of
  // { requester_handle, session_id, first_seen, last_spawn } objects.
  // Used by the diagnostic /mindwright:status script, which (unlike the
  // MCP tool) has no caller handle and so cannot filter to a single
  // consolidator — listing all rows is the next-best diagnostic.
  listConsolidators() {
    const rows = this.db.prepare(
      `SELECT key, value FROM meta WHERE key LIKE 'consolidator_for:%'`,
    ).all();
    const out = [];
    for (const row of rows) {
      let v;
      try { v = JSON.parse(row.value); } catch { continue; }
      if (!v || typeof v.session_id !== 'string') continue;
      out.push({
        requester_handle: row.key.slice('consolidator_for:'.length),
        session_id: v.session_id,
        first_seen: v.first_seen || null,
        last_spawn: v.last_spawn || null,
      });
    }
    return out;
  }

  // Upsert the consolidator-for record. Callers should pass at minimum
  // { session_id, first_seen }; last_spawn is optional and tracked by
  // spawnConsolidator on each new spawn attempt.
  setConsolidatorFor(requesterHandle, value) {
    if (!value || typeof value.session_id !== 'string') {
      throw new Error('setConsolidatorFor: value must include session_id');
    }
    const key = `consolidator_for:${requesterHandle}`;
    this._metaSet(key, JSON.stringify(value));
  }
}
