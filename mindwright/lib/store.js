// SQLite + sqlite-vec + FTS5 store; owns every read/write path.
// Int8 vectors: embeddings are L2-normalized Float32 in [-1, 1]; quantize by
// *127+round and bind through vec_int8(?) (a bare buffer is rejected as
// float32). Rowids bind as BigInt (better-sqlite3 binds JS Number as float64,
// which sqlite-vec rejects).

// Native deps resolve from the persistent node_modules via native-require.js,
// not a bare import (which would resolve against the ephemeral PLUGIN_ROOT that
// has no node_modules). Top-level await is safe: store.js is only reached by a
// dynamic import() after the readiness gate.
import { loadNative, loadNativeDefault } from './native-require.js';
const Database = await loadNativeDefault('better-sqlite3');
const sqliteVec = await loadNative('sqlite-vec');
import { readdirSync, readFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { dbPath, migrationsDir } from './paths.js';
import { tierScopeClause } from './scope-filter.js';
import { UNBOUND_SESSION_ID, TOOL_MAP_TTL_MS } from './constants.js';

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
  // Owner-only (0o700) on POSIX so a co-located local user can't read the DB
  // or the markdown mirrors sharing this dir. Windows uses ACLs.
  const isNew = !existsSync(dir);
  if (isNew) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } else if (process.platform !== 'win32') {
    try { chmodSync(dir, 0o700); } catch (e) {
      process.stderr.write(
        `[mindwright/store] chmod(${dir}, 0o700) failed — owner-only defense not active: ${e && e.message ? e.message : e}\n`,
      );
    }
  }

  const db = new Database(path, { readonly });
  // Database() takes no mode, so tighten the DB file to owner-only after open.
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

// Module-level (not Store methods) because runMigrations runs before
// `new Store()` with only the raw `db` handle.
function metaSet(db, key, value) {
  db.prepare(`
    INSERT INTO meta(key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
  `).run(key, value, new Date().toISOString());
}

// `value` is NOT NULL, so a null return unambiguously means "no row".
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

  // meta may not exist yet on first run (0001 creates it), so tolerate a
  // missing table here.
  let applied = new Set();
  try {
    const v = metaGet(db, SCHEMA_VERSION_KEY);
    if (v != null) applied = new Set(JSON.parse(v));
  } catch {
    // meta doesn't exist yet — nothing applied
  }

  // Cross-process WAL race: two callers can both see an empty applied set and
  // re-apply 0001, producing "duplicate column name" on ALTER TABLE (no IF NOT
  // EXISTS in SQLite). .immediate() takes the write lock at BEGIN so the in-txn
  // re-read of the applied set is authoritative and a peer's commit is seen.
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
        // Peer committed this one while we waited on the write lock.
        applied.add(file);
        return;
      }
      db.exec(sql);
      inTxnApplied.add(file);
      const value = JSON.stringify([...inTxnApplied]);
      metaSet(db, SCHEMA_VERSION_KEY, value);
      applied = inTxnApplied;
    });
    applyTxn.immediate();
  }
}

class Store {
  constructor(db, { sessionId = null } = {}) {
    this.db = db;
    this.sessionId = sessionId;
  }

  setSessionId(sessionId) {
    this.sessionId = sessionId || null;
  }

  close() {
    this.db.close();
  }

  // Tier-shape contract (also enforced by the DB CHECK):
  //   - tier='short': category null/'raw', scope null.
  //   - tier='long':  category in {procedural,episodic,fact}, scope in
  //                   {user,project,role:<role>}.
  //
  // `pendingSessionId`: short-tier staging marker. NULL = real short-term
  // (visible to retrieval/drain/counts). Non-NULL = the row is captured live
  // by the named session's hooks and must NOT leak into retrieval until that
  // session's PreCompact / SessionEnd promotes it (the design that
  // eliminates the self-echo class structurally). Long-tier rows must always
  // pass NULL — the consolidator's output is never staged.
  insertEntry({
    tier,
    category = null,
    scope = null,
    kind,
    content,
    sourceRef = null,
    sessionId,
    // INVARIANT: event_ts feeds recency ranking only; created_at alone drives
    // drain/finalize/safety-net lifecycle. Never thread it into a lifecycle
    // query. NULL → recency COALESCEs to created_at.
    eventTs = null,
    supersedes = null,
    confidence = null,
    embedding = null,
    pendingSessionId = null,
  }) {
    if (pendingSessionId != null && tier !== 'short') {
      // Long-tier rows produced by the consolidator MUST be visible to
      // retrieval immediately; staging them silently would freeze the
      // consolidator's output behind a flush that may never fire (long-tier
      // distillation is not tied to PreCompact). Reject at the boundary so a
      // bad caller fails loud instead of leaving phantom long-term rows.
      throw new Error(`insertEntry: pendingSessionId is only valid for tier='short' (got tier='${tier}')`);
    }
    const now = new Date().toISOString();
    const txn = this.db.transaction(() => {
      const info = this.db.prepare(`
        INSERT INTO entries (tier, category, scope, kind, content, source_ref, session_id, created_at, event_ts, supersedes, confidence, active, pending_session_id)
        VALUES (@tier, @category, @scope, @kind, @content, @sourceRef, @sessionId, @createdAt, @eventTs, @supersedes, @confidence, 1, @pendingSessionId)
      `).run({ tier, category, scope, kind, content, sourceRef, sessionId, createdAt: now, eventTs, supersedes, confidence, pendingSessionId });

      const id = info.lastInsertRowid;
      if (embedding) {
        this.writeEmbedding(id, embedding);
      }
      return id;
    });
    return txn();
  }

  // Promote every pending row owned by `sessionId` to real short-term (set
  // pending_session_id = NULL). The shared lib/promote-pending.js handler
  // calls this at the PreCompact / SessionEnd / orphan-sweep boundaries; the
  // row's id, embedding, FTS5 entry, and entity links all survive untouched
  // — the only change is that retrieval and drain queries stop filtering it
  // out. Returns the count moved (0 ⇒ nothing was pending).
  //
  // `maxCreatedAt` (optional ISO string) caps the promotion to rows older
  // than the cutoff. The orphan-sweep MUST pass this — without it, an
  // "orphan" session that wakes up via /resume between the orphan SELECT and
  // this UPDATE could have FRESH pending rows promoted out from under it,
  // reintroducing the self-echo class the pending-staging design eliminates.
  // PreCompact and SessionEnd operate on their own session and don't need a
  // bound (the session can't race itself within the same hook).
  promotePendingForSession(sessionId, { maxCreatedAt = null } = {}) {
    if (typeof sessionId !== 'string' || !sessionId) return 0;
    if (maxCreatedAt != null) {
      if (typeof maxCreatedAt !== 'string' || !Number.isFinite(Date.parse(maxCreatedAt))) {
        throw new Error('promotePendingForSession: maxCreatedAt must be an ISO date string');
      }
      const info = this.db.prepare(
        'UPDATE entries SET pending_session_id = NULL WHERE pending_session_id = ? AND active = 1 AND created_at < ?',
      ).run(sessionId, maxCreatedAt);
      return info.changes;
    }
    const info = this.db.prepare(
      'UPDATE entries SET pending_session_id = NULL WHERE pending_session_id = ? AND active = 1',
    ).run(sessionId);
    return info.changes;
  }

  // Distinct session_ids that currently own at least one pending row whose
  // latest created_at is older than `nowMs - thresholdMs`. SessionStart's
  // orphan sweep iterates these and promotes each — the owning session
  // crashed before its PreCompact / SessionEnd fired, so the content would
  // otherwise sit forever invisible to retrieval. The caller's own
  // `currentSessionId` is always excluded so we never steal a live session's
  // pending bucket; a /resume after lunch would otherwise lose its half-typed
  // turn to a peer's startup. Returns `[{ session_id, last_ts, n }]` sorted
  // oldest-first so the caller can decide whether to bound the per-pass
  // workload.
  orphanPendingSessions({ now = Date.now(), thresholdMs, currentSessionId = null } = {}) {
    if (!Number.isFinite(thresholdMs) || thresholdMs <= 0) {
      throw new Error('orphanPendingSessions: thresholdMs must be a positive finite number');
    }
    const cutoff = new Date(now - thresholdMs).toISOString();
    // SQL bindings positionally: the WHERE filter (pending_session_id != ?)
    // comes BEFORE the HAVING MAX(created_at) < ?, so bind in that order too.
    const whereParams = [];
    let whereExtra = '';
    if (typeof currentSessionId === 'string' && currentSessionId) {
      whereExtra = ' AND pending_session_id != ?';
      whereParams.push(currentSessionId);
    }
    return this.db.prepare(`
      SELECT pending_session_id AS session_id,
             MAX(created_at) AS last_ts,
             COUNT(*) AS n
        FROM entries
       WHERE pending_session_id IS NOT NULL${whereExtra}
       GROUP BY pending_session_id
      HAVING MAX(created_at) < ?
       ORDER BY MAX(created_at) ASC
    `).all(...whereParams, cutoff);
  }

  // Pending-row count for a session (any tier — pending only ever lands on
  // short-tier rows in practice, but the count is honest about the column).
  // Used by lib/promote-pending.js to short-circuit the cap check when
  // nothing actually moved.
  countPendingFor(sessionId) {
    if (typeof sessionId !== 'string' || !sessionId) return 0;
    return this.db.prepare(
      'SELECT COUNT(*) AS n FROM entries WHERE pending_session_id = ? AND active = 1',
    ).get(sessionId).n;
  }

  // Existence check + insert in one transaction so a concurrent
  // hardDeleteShortTerm can't leave an orphan vec_index row (the sweeper
  // awaits the slow embedder between reading pending ids and calling here).
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
      // DELETE-then-INSERT: vec0 tables don't support UPSERT.
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

  // NOT exactly-k for tier-filtered queries: vec_index MATCH picks the k
  // cosine-closest across ALL tiers, then the JOIN drops non-matching rows, so
  // a tier filter yields ≤ k rows. Callers needing exactly-k must over-request.
  //
  // `e.pending_session_id IS NULL` is what makes a pending live-staged row
  // structurally invisible to retrieval — the self-echo class disappears
  // before excludeIds ever runs.
  semanticSearch(queryFloat32, k, tier = null, roles = null) {
    const int8 = quantizeToInt8(queryFloat32);
    const ts = tierScopeClause(tier, roles);
    return this.db.prepare(`
      SELECT v.rowid AS id, v.distance
        FROM vec_index v
        JOIN entries e ON e.id = v.rowid AND e.active = 1 AND e.pending_session_id IS NULL
       WHERE v.embedding MATCH vec_int8(?)
         AND v.k = ?${ts.clause}
       ORDER BY v.distance
    `).all(Buffer.from(int8.buffer), k, ...ts.params);
  }

  // rank is the BM25 score (more-negative = better).
  bm25Search(queryText, k, tier = null, roles = null) {
    const ts = tierScopeClause(tier, roles);
    return this.db.prepare(`
      SELECT f.rowid AS id, bm25(fts) AS rank
        FROM fts f
        JOIN entries e ON e.id = f.rowid AND e.active = 1 AND e.pending_session_id IS NULL
       WHERE fts MATCH ?${ts.clause}
       ORDER BY rank
       LIMIT ?
    `).all(queryText, ...ts.params, k);
  }

  // Recency = COALESCE(event_ts, created_at) so a row seeded from a historical
  // transcript ranks by its true event time, not its seed-run created_at.
  temporalSearch(k, tier = null, roles = null) {
    const ts = tierScopeClause(tier, roles);
    return this.db.prepare(`
      SELECT e.id FROM entries e
       WHERE e.active = 1 AND e.pending_session_id IS NULL${ts.clause}
       ORDER BY COALESCE(e.event_ts, e.created_at) DESC, e.id DESC
       LIMIT ?
    `).all(...ts.params, k);
  }

  softArchive(id) {
    this.db.prepare('UPDATE entries SET active = 0 WHERE id = ?').run(id);
  }

  // Safe by construction: soft-archive never deletes, so the row + embedding +
  // entity links are intact and the active flip suffices.
  restore(id) {
    this.db.prepare('UPDATE entries SET active = 1 WHERE id = ?').run(id);
  }

  // The (new_id, old_id) edge goes to entry_supersedes so a merge of two
  // originals records BOTH parents; the entries.supersedes column would lose
  // one (last-wins) — the join table is the truth.
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

  // Full audit chain including merges, which the entries.supersedes column
  // can't represent.
  supersedeParents(newId) {
    return this.db.prepare(
      'SELECT old_id, created_at, reason FROM entry_supersedes WHERE new_id = ? ORDER BY created_at ASC',
    ).all(newId);
  }

  hardDeleteShortTerm(ids) {
    if (!ids.length) return;
    // Chunk to stay under SQLite's compile-time variable cap (999 on bundles
    // built with the old default).
    const CHUNK = 500;
    const bigIds = ids.map((id) => (typeof id === 'bigint' ? id : BigInt(id)));
    // entries triggers sync FTS; vec_index needs explicit cleanup. One
    // transaction so partial failure rolls back cleanly.
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

  getOffset(sessionId) {
    const row = this.db.prepare('SELECT last_read_byte FROM offsets WHERE session_id = ?').get(sessionId);
    return row ? row.last_read_byte : 0;
  }

  // EXISTENCE, not value: getOffset() returns 0 for both "no row" and
  // last_read_byte=0, so it can't tell "deliberately left at 0" from "never
  // seen". The offset-init latch (lib/offset-init.js) needs that distinction
  // to fire its EOF-default backstop exactly once per unknown session.
  hasOffsetRow(sessionId) {
    return !!this.db.prepare('SELECT 1 FROM offsets WHERE session_id = ?').get(sessionId);
  }

  setOffset(sessionId, byte) {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO offsets(session_id, last_read_byte, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET last_read_byte=excluded.last_read_byte, updated_at=excluded.updated_at
    `).run(sessionId, byte, now);
  }

  // Entries with no embedding yet (written in degraded mode), back-filled by
  // the daemon sweeper. Rows past the embed_failures threshold are excluded:
  // they are poison content that reliably crashes the tokenizer and would
  // otherwise block the head of the queue on every retry.
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

  bumpEmbedFailure(entryId) {
    const rowid = typeof entryId === 'bigint' ? entryId : BigInt(entryId);
    this.db.prepare('UPDATE entries SET embed_failures = embed_failures + 1 WHERE id = ?').run(rowid);
  }

  // True outstanding total (no LIMIT cap, unlike pendingEmbedSweep).
  countPendingEmbeds({ maxFailures = 5 } = {}) {
    return this.db.prepare(`
      SELECT COUNT(*) AS n
        FROM entries e
        LEFT JOIN vec_index v ON v.rowid = e.id
       WHERE v.rowid IS NULL AND e.embed_failures < ?
    `).get(maxFailures).n;
  }

  // Rows past the retry threshold — surfaced so persistent poison content is
  // observable rather than silently degrading recall.
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

  // Every "short-term" count/age/byte method below filters
  // `pending_session_id IS NULL` so pending staging rows never inflate the
  // cap, the safety-net trigger, the mirrors, or the bytes budget. Pending
  // rows are addressed via countPendingFor / orphanPendingSessions; mixing
  // the two would silently cap-cross on rows nothing else can see.
  countShortTermFor(sessionId) {
    return this.db.prepare(
      'SELECT COUNT(*) AS n FROM entries WHERE tier = ? AND session_id = ? AND active = 1 AND pending_session_id IS NULL',
    ).get('short', sessionId).n;
  }

  // Short-term rows under OTHER bound sessions, excluding the synthetic
  // UNBOUND_SESSION_ID bucket.
  countShortTermInOtherSessions(currentSessionId) {
    return this.db.prepare(
      `SELECT COUNT(*) AS n FROM entries
        WHERE active = 1 AND tier = 'short' AND pending_session_id IS NULL
          AND session_id != ?
          AND session_id != ?`,
    ).get(currentSessionId, UNBOUND_SESSION_ID).n;
  }

  // Project-wide count: the nudge evaluator triggers on this so many short
  // sessions can't each stay under the per-session cap while rows pile up
  // project-wide.
  countShortTermAllSessions() {
    return this.db.prepare(
      'SELECT COUNT(*) AS n FROM entries WHERE tier = ? AND active = 1 AND pending_session_id IS NULL',
    ).get('short').n;
  }

  // UTF-8 BYTES, not chars: must match the unit the seed-loop backpressure
  // accumulates (Buffer.byteLength utf8). CAST(content AS BLOB) makes LENGTH()
  // the byte length (LENGTH() on TEXT is the UTF-16 char count); COALESCE
  // handles the empty-table NULL.
  shortTermBytes() {
    return this.db.prepare(
      `SELECT COALESCE(SUM(LENGTH(CAST(content AS BLOB))), 0) AS b
         FROM entries WHERE tier = 'short' AND active = 1 AND pending_session_id IS NULL`,
    ).get().b;
  }

  // Active rows parked under the synthetic UNBOUND_SESSION_ID — these land
  // when the CLI runs with no --session-id. Surfaced by mindwright_status as
  // a warning so the user knows to drain. The filter excludes pending rows
  // because mindwright_status describes promoted state to the user; pending
  // rows belong to a different lifecycle and are reported separately.
  countUnboundActive() {
    return this.db.prepare(
      'SELECT COUNT(*) AS n FROM entries WHERE session_id = ? AND active = 1 AND pending_session_id IS NULL',
    ).get(UNBOUND_SESSION_ID).n;
  }

  // Short-term subset of countUnboundActive.
  countUnboundShortTerm() {
    return this.db.prepare(
      "SELECT COUNT(*) AS n FROM entries WHERE session_id = ? AND active = 1 AND tier = 'short' AND pending_session_id IS NULL",
    ).get(UNBOUND_SESSION_ID).n;
  }

  // Oldest active short-term created_at (ISO8601 or null). The Stop hook
  // checks this against SAFETY_NET_DAYS so a quiet session below CAP_EXCHANGES
  // still drains aging content.
  oldestShortTermCreatedAt(sessionId) {
    const row = this.db.prepare(
      'SELECT MIN(created_at) AS oldest FROM entries WHERE tier = ? AND session_id = ? AND active = 1 AND pending_session_id IS NULL',
    ).get('short', sessionId);
    return row && row.oldest ? row.oldest : null;
  }

  // Project-wide oldest short-term row: the safety-net trigger fires globally
  // so a stale row in session B nudges session A on its next Stop.
  oldestShortTermAcrossAllSessions() {
    const row = this.db.prepare(
      'SELECT MIN(created_at) AS oldest FROM entries WHERE tier = ? AND active = 1 AND pending_session_id IS NULL',
    ).get('short');
    return row && row.oldest ? row.oldest : null;
  }

  // Oldest active long-term user-scoped fact's created_at (ISO8601 or null).
  // Preferences don't auto-decay, so status warns when this gets stale.
  oldestUserPreference() {
    const row = this.db.prepare(
      `SELECT created_at FROM entries
        WHERE tier='long' AND active=1 AND category='fact' AND scope='user'
        ORDER BY created_at ASC LIMIT 1`,
    ).get();
    return row && row.created_at ? row.created_at : null;
  }

  countByTier() {
    // Pending rows are tier='short' but not yet "real" short-term; they
    // wouldn't be visible to retrieval anyway and counting them here would
    // make mindwright_status's `short:` number diverge from the cap counter.
    const rows = this.db.prepare(
      'SELECT tier, COUNT(*) AS n FROM entries WHERE active = 1 AND pending_session_id IS NULL GROUP BY tier',
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

  // Per (category, scope) bucket count: surfaces the orthogonal-axis split
  // (e.g. fact/user vs fact/project) that countByCategory alone can't show.
  countByCategoryScope() {
    return this.db.prepare(
      'SELECT category, scope, COUNT(*) AS n FROM entries WHERE tier = ? AND active = 1 AND category IS NOT NULL AND scope IS NOT NULL GROUP BY category, scope',
    ).all('long');
  }

  // Mirror-rendering accessors for lib/mirrors.js. DESC (newest first) so
  // mirrors read like a reverse-chronological journal, not a diff-friendly
  // log. Kept on Store so raw db.prepare doesn't leak into mirrors.js.
  listShortTermRecent(limit) {
    // The mirror renderer reads this; pending rows must NOT appear in the
    // mirror because they correspond to live in-context content that hasn't
    // been "saved" yet from the user's perspective.
    return this.db.prepare(
      `SELECT id, kind, content, session_id, created_at
         FROM entries
        WHERE tier = 'short' AND active = 1 AND pending_session_id IS NULL
        ORDER BY created_at DESC, id DESC
        LIMIT ?`,
    ).all(limit);
  }

  listLongTermByCategoryScope(category, scope) {
    return this.db.prepare(
      `SELECT id, content, confidence, created_at, session_id
         FROM entries
        WHERE tier = 'long' AND category = ? AND scope = ? AND active = 1
        ORDER BY created_at DESC, id DESC`,
    ).all(category, scope);
  }

  // No scope filter: episodes can carry any scope, so select it for the
  // renderer.
  listLongTermEpisodes() {
    return this.db.prepare(
      `SELECT id, content, scope, created_at, session_id
         FROM entries
        WHERE tier = 'long' AND category = 'episodic' AND active = 1
        ORDER BY created_at DESC, id DESC`,
    ).all();
  }

  // Strips the 'role:' prefix; callers must still gate writes through the
  // role whitelist (defense in depth).
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

  // Every meta access in this class goes through these two so the SQL +
  // timestamp live in exactly one place.
  _metaSet(key, value) { metaSet(this.db, key, value); }
  _metaGet(key) { return metaGet(this.db, key); }

  setRoles(sessionId, roles) {
    this._metaSet(`roles:${sessionId}`, JSON.stringify([...new Set(roles)]));
  }

  getRoles(sessionId) {
    const v = this._metaGet(`roles:${sessionId}`);
    return v != null ? JSON.parse(v) : [];
  }

  // Stop can't surface additionalContext (Claude Code only honors it from
  // UserPromptSubmit / SessionStart / PreToolUse), so the nudge is staged here
  // and the next UserPromptSubmit hook drains it.
  setPendingNudge(sessionId, message) {
    this._metaSet(`pending_nudge:${sessionId}`, message);
  }

  // Read-and-clear in one transaction. Returns null if none.
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

  // Project-wide (NOT per-session) edge-trigger state for the cap-reached
  // nudge — a single shared key, because the triggers are project-wide; a
  // per-session key would re-fire each time a new session opened on the same
  // cap-crossed state. Values are NUDGE_STATES; null ⟺ ARMED (first run).
  getNudgeState() {
    return this._metaGet('nudge_state');
  }

  setNudgeState(state) {
    this._metaSet('nudge_state', state);
  }

  // Per-session tool_use_id → { name, input, source_ref, timestamp } map for
  // the chunker. tool_use and its matching tool_result land in different
  // transcript records seen by different hook passes, so the map MUST persist
  // across passes or:
  //   - a late inbox tool_result can't be classified (silent event drop), AND
  //   - a paired tool_call chunk can't be emitted because the originating
  //     tool_use's input/source_ref are no longer in memory.
  // Stored shape is uniformly the object form. Legacy rows from before the
  // pairing change carried `id → name` as a bare string and are migrated on
  // read into `{ name: <string> }` — those entries lack input so they can
  // still classify a late inbox event, but they can't emit a paired tool_call
  // (acceptable: a one-time loss for any in-flight tool_use that spanned the
  // upgrade).
  loadToolMap(sessionId, { now = Date.now() } = {}) {
    const v = this._metaGet(`tool_map:${sessionId}`);
    if (v == null) return new Map();
    try {
      const obj = JSON.parse(v);
      if (!obj || typeof obj !== 'object') return new Map();
      const out = new Map();
      // A tool_use older than TOOL_MAP_TTL_MS without a paired tool_result is
      // almost certainly abandoned (user-interrupted Bash, killed Agent
      // subtask, MCP timeout, transcript truncation between assistant turn
      // and result). Drop it on load so the persisted blob doesn't grow
      // unbounded across a long session. Entries without a parseable
      // timestamp (legacy bare-string form) are kept — they pre-date the
      // pairing schema and won't be re-inserted by current code, so they're
      // a finite, one-time tail.
      for (const [id, val] of Object.entries(obj)) {
        if (typeof val === 'string') {
          // Legacy: bare name string. Wrap so the rest of the code only sees
          // the object shape.
          out.set(id, { name: val });
        } else if (val && typeof val === 'object' && typeof val.name === 'string') {
          if (typeof val.timestamp === 'string') {
            const t = Date.parse(val.timestamp);
            if (Number.isFinite(t) && now - t > TOOL_MAP_TTL_MS) continue;
          }
          out.set(id, val);
        }
        // Anything else (number, null, bad shape) is silently dropped — same
        // safety stance as the JSON.parse failure path.
      }
      return out;
    } catch (e) {
      // Reset recovers, but log so repeated parse failures (a real defect)
      // aren't hidden behind a quiet "next pass works".
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

  // Drop the persisted tool_map blob for a session. Called by SessionEnd
  // (clean shutdown) and by the SessionStart orphan-sweep (crashed-session
  // cleanup) so an abandoned session's buffer doesn't sit in meta forever.
  // No-ops if the row doesn't exist.
  clearToolMap(sessionId) {
    this.db.prepare('DELETE FROM meta WHERE key = ?').run(`tool_map:${sessionId}`);
  }

  // Per-session retrieval-injection state (injected_fact_ids + last query
  // embedding). SessionStart clears both rows so a fresh boot starts cold.
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

  // Dedup + FIFO-trim to `cap` (new ids at the tail, head dropped first).
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

  getLastQueryEmb(sessionId) {
    const v = this._metaGet(`last_retrieval_query_emb:${sessionId}`);
    if (v == null) return null;
    try {
      const buf = Buffer.from(v, 'base64');
      if (buf.byteLength !== 1024 * 4) return null;
      // Copy into a fresh ArrayBuffer: a view onto Buffer's shared pool slice
      // could be corrupted by an unrelated write.
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

  // Per-session latch so the "model daemon unreachable" warning surfaces
  // exactly once per session (degraded recall is otherwise indistinguishable
  // from no-relevant-facts). SessionStart clears it so a fresh boot re-warns.
  wasDaemonDownWarned(sessionId) {
    // `value` is NOT NULL, so a non-null _metaGet ⟺ the row exists.
    return this._metaGet(`daemon_down_warned:${sessionId}`) !== null;
  }

  markDaemonDownWarned(sessionId) {
    this._metaSet(`daemon_down_warned:${sessionId}`, '1');
  }

  clearDaemonDownWarned(sessionId) {
    this.db.prepare('DELETE FROM meta WHERE key = ?').run(`daemon_down_warned:${sessionId}`);
  }

  // meta:consolidator_for:<requester_handle> persists the consolidator
  // session UUID per requester+project until /mindwright:reset. Only the UUID
  // is stored; the handle is recomputed at display time via deriveHandle().
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

  // Every consolidator-for record. /mindwright:status has no caller handle to
  // filter by, so it lists all rows.
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

  // Callers pass at minimum { session_id, first_seen }; last_spawn is
  // optional and tracked by spawnConsolidator per spawn attempt.
  setConsolidatorFor(requesterHandle, value) {
    if (!value || typeof value.session_id !== 'string') {
      throw new Error('setConsolidatorFor: value must include session_id');
    }
    const key = `consolidator_for:${requesterHandle}`;
    this._metaSet(key, JSON.stringify(value));
  }
}
