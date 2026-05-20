-- mindwright initial schema.
-- One unified entries table with tier + category + scope, vec_index virtual table
-- for ANN, FTS5 for keyword search, entities for graph retrieval, offsets for per-
-- session transcript bookmark, consolidations for audit, meta for role assignments
-- and per-session retrieval state.

CREATE TABLE IF NOT EXISTS entries (
  id INTEGER PRIMARY KEY,
  tier TEXT NOT NULL CHECK(tier IN ('short', 'long')),
  category TEXT CHECK(category IS NULL OR category IN ('raw', 'procedural', 'episodic', 'fact')),
  scope TEXT CHECK(scope IS NULL OR scope='user' OR scope='project' OR scope LIKE 'role:%'),
  kind TEXT NOT NULL,
  content TEXT NOT NULL,
  source_ref TEXT,
  session_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  -- Provenance/event time: when the underlying exchange ACTUALLY happened
  -- (from JSONL rec.timestamp), vs created_at = when the row was written.
  -- NULL for live-captured rows (drift is seconds — created_at suffices) and
  -- for non-transcript seed sources. Populated only for rows distilled/seeded
  -- from historical transcripts, where collapsing every memory to seed-run
  -- time would destroy retrieval recency and temporal ordering.
  --
  -- GOVERNING INVARIANT: event_ts governs relevance/recency ranking ONLY
  -- (retrieval ORDER BY COALESCE(event_ts, created_at)). created_at remains
  -- the SOLE basis for all lifecycle/operational logic — drain ordering, the
  -- (created_at,id) drain cursor, finalizeDrain re-query, safety-net age,
  -- idle reminders. event_ts is NULL for live rows and non-monotonic within
  -- a seeded batch; it must NEVER enter the drain cursor or any lifecycle SQL.
  event_ts TEXT,
  supersedes INTEGER REFERENCES entries(id),
  -- Probability-like score used by retainHandler for user-scoped fact rows
  -- (category='fact', scope='user') and by retrieval-side ranking. The
  -- application layer validates the range
  -- (mcp/tools.mjs#retainHandler); the DB CHECK is defense-in-depth so a
  -- direct insert (e.g., scripts/seed-from-repo or a test) cannot smuggle in
  -- 100, -1, or otherwise out-of-range values.
  confidence REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  -- Sweeper-side counter: per-row embedding attempts that failed. Rows whose
  -- counter exceeds SWEEPER_MAX_EMBED_FAILURES are excluded from the next
  -- pendingEmbedSweep so a poison row (un-tokenizable / oversized content)
  -- can't block the backfill queue forever. mindwright_status surfaces the
  -- skipped count.
  embed_failures INTEGER NOT NULL DEFAULT 0,
  -- Staging marker for short-tier rows captured live but not yet "in" memory.
  -- NULL = real short-term (visible to retrieval, drain, all counts). NOT NULL
  -- = pending: the row was captured by the hooks during this session
  -- (`pending_session_id` = the live session id) and is held back from
  -- retrieval/drain/cap so the just-typed prompt/thinking can't echo back as
  -- its own recall hit. Promoted to NULL at PreCompact / SessionEnd by the
  -- shared flush handler (lib/promote-pending.js) once the originating
  -- session's context window is about to be lost — that's when memory
  -- actually needs to know about it. The orphan-pending sweep at SessionStart
  -- promotes rows whose owning session went stale (crashed before flushing)
  -- so abandoned content still consolidates instead of stranding.
  pending_session_id TEXT,
  -- Self-supersedes would corrupt audit traversal (a cycle of length 1).
  -- SQLite evaluates row-level CHECKs against the inserted/updated row's
  -- column values, so `supersedes <> id` is safe on modern SQLite.
  CHECK (supersedes IS NULL OR supersedes <> id),
  -- Tier ⇄ (category, scope) partition. The views and consolidator/retain code
  -- assume:
  --   - tier='short' rows have no distilled category and no scope. category is
  --     either NULL or the 'raw' marker for streamed chunker output; scope is
  --     always NULL.
  --   - tier='long' rows ALWAYS have one of the three distilled categories AND
  --     a scope. The category|scope axes are orthogonal: a 'fact' can be
  --     user-scoped or project-scoped; a 'procedural' is almost always
  --     role-scoped; an 'episodic' is typically project-scoped.
  -- A row that satisfies neither half is invisible to every view and likely
  -- the result of a code bug; reject at the DB layer.
  --
  -- Implemented as a CASE expression because SQLite CHECK constraints that
  -- evaluate to NULL are treated as satisfied. A naive `category IN (...)`
  -- returns NULL when category is NULL, and the surrounding AND propagates
  -- that NULL — letting a long-tier row with NULL category slip through.
  -- The `category IS NOT NULL AND ...` and `scope IS NOT NULL AND ...`
  -- prefixes short-circuit to a concrete FALSE before IN/LIKE see NULL.
  CHECK (
    CASE tier
      WHEN 'short' THEN (category IS NULL OR category = 'raw') AND scope IS NULL
      WHEN 'long'  THEN category IS NOT NULL
                       AND category IN ('procedural', 'episodic', 'fact')
                       AND scope IS NOT NULL
                       AND (scope='user' OR scope='project' OR scope LIKE 'role:%')
      ELSE 0
    END
  )
);

CREATE INDEX IF NOT EXISTS idx_entries_tier_session ON entries(tier, session_id);
CREATE INDEX IF NOT EXISTS idx_entries_category ON entries(category) WHERE category IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_entries_scope ON entries(scope) WHERE scope IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_entries_active_created ON entries(active, created_at);
-- Recency-ordering index for the COALESCE(event_ts, created_at) retrieval
-- path. temporalSearch (lib/store.js) runs on every retrieve() and orders
-- ALL active in-scope rows by COALESCE(event_ts, created_at) DESC, id DESC
-- before LIMIT — without an expression index matching that exact ordering,
-- SQLite falls back to a full active-row scan + temp-B-tree filesort (verified
-- via EXPLAIN QUERY PLAN: "USE TEMP B-TREE FOR ORDER BY"). idx_entries_active_created
-- only covers the plain created_at ordering, not the COALESCE expression. The
-- seeding overhaul is explicitly designed to grow long-term large (a whole
-- transcript corpus distilled), so this hot path must stay index-ordered.
-- SQLite supports expression indexes (>=3.9.0); the leading `active` column
-- also serves the `WHERE active=1` predicate.
CREATE INDEX IF NOT EXISTS idx_entries_active_effective_ts
  ON entries(active, COALESCE(event_ts, created_at) DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_entries_embed_failures ON entries(embed_failures) WHERE embed_failures > 0;
-- Partial index over the orphan-sweep lookup: SessionStart scans pending rows
-- grouped by pending_session_id to find sessions whose latest row is older
-- than ORPHAN_FLUSH_THRESHOLD_MS. The partial WHERE keeps the index size
-- proportional to live pending volume, not the whole table.
CREATE INDEX IF NOT EXISTS idx_entries_pending_session
  ON entries(pending_session_id, created_at) WHERE pending_session_id IS NOT NULL;

-- sqlite-vec virtual table. int8 quantization gives ~2.7x faster brute-force scan
-- at 1024-dim vs float32. vec_index.rowid mirrors entries.id.
CREATE VIRTUAL TABLE IF NOT EXISTS vec_index USING vec0(
  embedding int8[1024] distance_metric=cosine
);

-- FTS5 keyword index. content='entries' makes it a contentless table mirroring
-- entries(content); triggers below keep it in sync.
CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(content, content='entries', content_rowid='id');

CREATE TRIGGER IF NOT EXISTS entries_ai AFTER INSERT ON entries BEGIN
  INSERT INTO fts(rowid, content) VALUES (new.id, new.content);
END;

CREATE TRIGGER IF NOT EXISTS entries_ad AFTER DELETE ON entries BEGIN
  INSERT INTO fts(fts, rowid, content) VALUES ('delete', old.id, old.content);
END;

-- AFTER UPDATE OF content (NOT plain AFTER UPDATE): SQLite only fires this when
-- the UPDATE's SET clause names `content`. Hot UPDATE paths that touch other
-- columns — soft-delete (active=0), embed_failures counter, supersedes backfill
-- — would otherwise pay a wasted FTS5 delete+reinsert against unchanged content.
-- The WHEN guard additionally suppresses no-op same-value writes.
CREATE TRIGGER IF NOT EXISTS entries_au AFTER UPDATE OF content ON entries
WHEN old.content IS NOT new.content BEGIN
  INSERT INTO fts(fts, rowid, content) VALUES ('delete', old.id, old.content);
  INSERT INTO fts(rowid, content) VALUES (new.id, new.content);
END;

CREATE TABLE IF NOT EXISTS entities (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS entry_entities (
  entry_id INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  PRIMARY KEY (entry_id, entity_id)
);

-- Many-to-many supersede graph. entries.supersedes is a single FK to one
-- parent — fine for prefer_a/prefer_b/update_memory/scope_both (1:1), but it
-- cannot record a `merge` where two originals (A and B) collapse into one new
-- row M (a single FK loses the second link). This join table records every
-- (new_id, old_id) pair so the merge audit trail is complete; entries.supersedes
-- is retained as the denormalized most-recent parent for the 1:1 case.
CREATE TABLE IF NOT EXISTS entry_supersedes (
  new_id     INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  old_id     INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  created_at TEXT    NOT NULL,
  reason     TEXT,
  PRIMARY KEY (new_id, old_id),
  -- Self-supersedes (new_id == old_id) are nonsensical and would corrupt the
  -- audit graph (a cycle of length 1). Reject them at the DB layer.
  CHECK (new_id <> old_id)
);

CREATE INDEX IF NOT EXISTS idx_entry_supersedes_new ON entry_supersedes(new_id);
CREATE INDEX IF NOT EXISTS idx_entry_supersedes_old ON entry_supersedes(old_id);

CREATE TABLE IF NOT EXISTS offsets (
  session_id TEXT PRIMARY KEY,
  last_read_byte INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS consolidations (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL,
  fired_at TEXT NOT NULL,
  drained_count INTEGER NOT NULL,
  drained_bytes INTEGER NOT NULL,
  produced_count INTEGER NOT NULL
);

-- Enforce the "one drain at a time" invariant promised by DESIGN.md and the
-- /mindwright:dream skill. Without it, two concurrent dream sessions both
-- grab the same oldest 70% of short-term and double-write long-term facts.
--
-- drainBatch claims its slice by inserting a row per entry into drain_locks
-- (PK = entry_id, so an entry can only be in one drain). finalizeDrain hard-
-- deletes the entries, which CASCADEs the lock rows away. Abandoned drains
-- (process died mid-cycle) self-recover at the next drainBatch via a stale-
-- threshold filter.
CREATE TABLE IF NOT EXISTS drain_locks (
  entry_id INTEGER NOT NULL PRIMARY KEY REFERENCES entries(id) ON DELETE CASCADE,
  drain_id TEXT NOT NULL,
  acquired_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_drain_locks_drain ON drain_locks(drain_id);
CREATE INDEX IF NOT EXISTS idx_drain_locks_acquired ON drain_locks(acquired_at);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Views are explicit column lists (not SELECT *) so that future ALTER TABLE
-- on `entries` doesn't silently widen the view projection. When a new column
-- needs to be exposed, add it to each view here (DB never created in prod —
-- this file is edited in place, not migrated).
-- Order matches the entries CREATE above for readability.
-- `observations` excludes pending rows by design — pending content is held
-- in `entries` for staging only; it must not surface in any "what's in
-- short-term?" view. Promotion (lib/promote-pending.js) flips pending to
-- NULL and the row appears here. The long-tier views never need the filter
-- (consolidator output is always real, never pending).
CREATE VIEW IF NOT EXISTS observations AS
  SELECT id, tier, category, scope, kind, content, source_ref, session_id, created_at, event_ts, supersedes, confidence, active
  FROM entries WHERE tier='short' AND active=1 AND pending_session_id IS NULL;
CREATE VIEW IF NOT EXISTS facts AS
  SELECT id, tier, category, scope, kind, content, source_ref, session_id, created_at, event_ts, supersedes, confidence, active
  FROM entries WHERE tier='long' AND active=1;
CREATE VIEW IF NOT EXISTS heuristics AS
  SELECT id, tier, category, scope, kind, content, source_ref, session_id, created_at, event_ts, supersedes, confidence, active
  FROM entries WHERE tier='long' AND category='procedural' AND scope LIKE 'role:%' AND active=1;
CREATE VIEW IF NOT EXISTS preferences AS
  SELECT id, tier, category, scope, kind, content, source_ref, session_id, created_at, event_ts, supersedes, confidence, active
  FROM entries WHERE tier='long' AND category='fact' AND scope='user' AND active=1;
CREATE VIEW IF NOT EXISTS project_facts AS
  SELECT id, tier, category, scope, kind, content, source_ref, session_id, created_at, event_ts, supersedes, confidence, active
  FROM entries WHERE tier='long' AND category='fact' AND scope='project' AND active=1;
CREATE VIEW IF NOT EXISTS episodes AS
  SELECT id, tier, category, scope, kind, content, source_ref, session_id, created_at, event_ts, supersedes, confidence, active
  FROM entries WHERE tier='long' AND category='episodic' AND active=1;
