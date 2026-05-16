-- ideawright SQLite schema v1
-- Miners (A) INSERT ideas with status='new'.
-- Novelty engine (B) UPDATE novelty + status ('scored' → 'verified' or 'archived').
-- Orchestrator (C) UPDATE feasibility + composite_rank + status ('gated' → 'promoted' or 'archived').

CREATE TABLE IF NOT EXISTS ideas (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  summary TEXT,
  target_user TEXT,
  category TEXT,
  emerging_tech TEXT,
  pain_evidence TEXT NOT NULL DEFAULT '[]',
  source_urls TEXT NOT NULL DEFAULT '[]',
  novelty TEXT,
  feasibility TEXT,
  composite_rank REAL,
  status TEXT NOT NULL CHECK(status IN ('new','scored','verified','gated','promoted','archived')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_ideas_status ON ideas(status);
CREATE INDEX IF NOT EXISTS idx_ideas_composite_rank ON ideas(composite_rank DESC);
CREATE INDEX IF NOT EXISTS idx_ideas_updated_at ON ideas(updated_at DESC);

CREATE TABLE IF NOT EXISTS sources (
  source TEXT PRIMARY KEY,
  last_seen_id TEXT,
  last_run_at TEXT,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS state_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  idea_id TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT NOT NULL,
  actor TEXT NOT NULL,
  note TEXT,
  ts TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(idea_id) REFERENCES ideas(id)
);

CREATE INDEX IF NOT EXISTS idx_state_log_idea ON state_log(idea_id, ts DESC);

-- Raw observations from miners, persisted BEFORE validation. If validation
-- fails (e.g., the 5-hour Claude usage cap zeroes out a whole source), the
-- raw signal is still recoverable here for re-validation later.
-- One row per (source, source_url) — re-mining the same URL is a no-op.
-- `validated_at` is set when the signal has been judged at least once;
-- `last_error` is set when the most recent attempt failed (rate limit, etc.).
CREATE TABLE IF NOT EXISTS raw_observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  source_url TEXT,
  title TEXT,
  quote TEXT,
  author TEXT,
  engagement TEXT,
  code_url TEXT,
  observed_at TEXT NOT NULL DEFAULT (datetime('now')),
  validated_at TEXT,
  last_error TEXT,
  idea_id TEXT,
  UNIQUE(source, source_url)
);

CREATE INDEX IF NOT EXISTS idx_raw_obs_unvalidated ON raw_observations(source, validated_at);

-- SQLite treats every NULL as DISTINCT in a UNIQUE constraint, so the inline
-- UNIQUE(source, source_url) above does NOT collide two source_url-less
-- observations from the same source: each re-mine would insert — and re-judge,
-- burning LLM budget — a fresh row, and never reach insertRawObservation's
-- recovery SELECT. This expression index normalizes NULL → '' so a url-less
-- signal dedupes like any other. Additive + IF NOT EXISTS, and verified to
-- build cleanly over pre-fix data (no existing row violates it).
CREATE UNIQUE INDEX IF NOT EXISTS idx_raw_obs_source_url
  ON raw_observations(source, COALESCE(source_url, ''));
