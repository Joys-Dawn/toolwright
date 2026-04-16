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
