import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function normalize(s) {
  if (s == null) return '';
  return String(s).toLowerCase().trim().replace(/\s+/g, ' ');
}

export function computeId(title, target_user) {
  const basis = `${normalize(title)}|${normalize(target_user)}`;
  return createHash('sha256').update(basis).digest('hex');
}

export function openDb({ repoRoot = process.cwd(), filename } = {}) {
  let path;
  if (filename) {
    path = filename;
  } else {
    const dir = join(repoRoot, '.claude', 'ideawright');
    mkdirSync(dir, { recursive: true });
    path = join(dir, 'ideas.db');
  }
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  const schema = readFileSync(resolve(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);
  return db;
}

export function insertIdea(db, idea) {
  const id = idea.id ?? computeId(idea.title, idea.target_user);
  const info = db.prepare(`
    INSERT OR IGNORE INTO ideas
      (id, title, summary, target_user, category, emerging_tech, pain_evidence, source_urls, status)
    VALUES
      (@id, @title, @summary, @target_user, @category, @emerging_tech, @pain_evidence, @source_urls, 'new')
  `).run({
    id,
    title: idea.title,
    summary: idea.summary ?? null,
    target_user: idea.target_user ?? null,
    category: idea.category ?? null,
    emerging_tech: idea.emerging_tech ?? null,
    pain_evidence: JSON.stringify(idea.pain_evidence ?? []),
    source_urls: JSON.stringify(idea.source_urls ?? []),
  });
  const inserted = Number(info.changes) > 0;
  if (inserted) logTransition(db, id, null, 'new', idea.source_module ?? 'miner', idea.note ?? null);
  return { id, inserted };
}

export function updateNovelty(db, id, novelty, newStatus) {
  const current = db.prepare('SELECT status FROM ideas WHERE id = ?').get(id);
  db.prepare(`
    UPDATE ideas
       SET novelty = @novelty, status = @status, updated_at = datetime('now')
     WHERE id = @id
  `).run({ id, novelty: JSON.stringify(novelty), status: newStatus });
  logTransition(db, id, current?.status ?? null, newStatus, 'novelty', null);
}

export function updateFeasibility(db, id, feasibility, composite_rank, newStatus, note = null) {
  const current = db.prepare('SELECT status FROM ideas WHERE id = ?').get(id);
  db.prepare(`
    UPDATE ideas
       SET feasibility = @feasibility, composite_rank = @rank, status = @status, updated_at = datetime('now')
     WHERE id = @id
  `).run({
    id,
    feasibility: JSON.stringify(feasibility),
    rank: composite_rank ?? null,
    status: newStatus,
  });
  logTransition(db, id, current?.status ?? null, newStatus, 'orchestrator', note);
}

export function getIdea(db, id) {
  const row = db.prepare('SELECT * FROM ideas WHERE id = ?').get(id);
  return row ? rowToIdea(row) : null;
}

// Returns ideas matching `status`, capped at `limit` (default 1000).
// Callers processing all ideas in a status should pass an explicit limit
// or call in a loop with increasing offsets if >1000 rows are expected.
export function listByStatus(db, status, limit = 1000) {
  const rows = db.prepare(
    `SELECT * FROM ideas WHERE status = ? ORDER BY updated_at DESC LIMIT ?`
  ).all(status, limit);
  return rows.map(rowToIdea);
}

export function listTopRanked(db, limit = 10) {
  const rows = db.prepare(`
    SELECT * FROM ideas
     WHERE status = 'promoted' AND composite_rank IS NOT NULL
     ORDER BY composite_rank DESC, updated_at DESC
     LIMIT ?
  `).all(limit);
  return rows.map(rowToIdea);
}

export function statusCounts(db) {
  return db.prepare(
    `SELECT status, COUNT(*) AS n FROM ideas GROUP BY status`
  ).all();
}

export function rowToIdea(row) {
  return {
    ...row,
    pain_evidence: JSON.parse(row.pain_evidence ?? '[]'),
    source_urls: JSON.parse(row.source_urls ?? '[]'),
    novelty: row.novelty ? JSON.parse(row.novelty) : null,
    feasibility: row.feasibility ? JSON.parse(row.feasibility) : null,
  };
}

export function getSourceCursor(db, source) {
  return db.prepare('SELECT * FROM sources WHERE source = ?').get(source) ?? null;
}

export function setSourceCursor(db, source, { last_seen_id, notes } = {}) {
  db.prepare(`
    INSERT INTO sources (source, last_seen_id, last_run_at, notes)
    VALUES (@source, @last_seen_id, datetime('now'), @notes)
    ON CONFLICT(source) DO UPDATE SET
      last_seen_id = excluded.last_seen_id,
      last_run_at = excluded.last_run_at,
      notes = excluded.notes
  `).run({ source, last_seen_id: last_seen_id ?? null, notes: notes ?? null });
}

// Heartbeat: update last_run_at without touching notes/last_seen_id.
// Lets the runner record "we attempted this source at T" even when errors
// prevent advancing the cursor. Distinct from setSourceCursor which is
// for recording forward progress.
export function touchSourceLastRun(db, source) {
  db.prepare(`
    INSERT INTO sources (source, last_run_at)
    VALUES (?, datetime('now'))
    ON CONFLICT(source) DO UPDATE SET last_run_at = excluded.last_run_at
  `).run(source);
}

function logTransition(db, idea_id, from_status, to_status, actor, note) {
  db.prepare(`
    INSERT INTO state_log (idea_id, from_status, to_status, actor, note)
    VALUES (?, ?, ?, ?, ?)
  `).run(idea_id, from_status, to_status, actor, note);
}

// Insert a raw observation BEFORE validation runs. Idempotent on
// (source, source_url) — re-mining the same signal is a no-op. Returns
// `{ id, validated }`: `validated=true` when the existing row already has
// `validated_at` set, so the caller can skip re-judging it.
export function insertRawObservation(db, obs) {
  const info = db.prepare(`
    INSERT OR IGNORE INTO raw_observations
      (source, source_url, title, quote, author, engagement, code_url)
    VALUES
      (@source, @source_url, @title, @quote, @author, @engagement, @code_url)
  `).run({
    source: obs.source,
    source_url: obs.source_url ?? null,
    title: obs.title ?? null,
    quote: obs.quote ?? null,
    author: obs.author ?? null,
    engagement: obs.engagement ? JSON.stringify(obs.engagement) : null,
    code_url: obs.code_url ?? null,
  });
  if (Number(info.changes) > 0) {
    return { id: Number(info.lastInsertRowid), validated: false };
  }
  const row = db.prepare(
    'SELECT id, validated_at FROM raw_observations WHERE source = ? AND source_url IS ?'
  ).get(obs.source, obs.source_url ?? null);
  if (!row) return null;
  return { id: row.id, validated: row.validated_at != null };
}

export function markRawObservationValidated(db, rowid, ideaId) {
  if (!rowid) return;
  db.prepare(`
    UPDATE raw_observations
       SET validated_at = datetime('now'),
           last_error = NULL,
           idea_id = ?
     WHERE id = ?
  `).run(ideaId ?? null, rowid);
}

export function markRawObservationError(db, rowid, errorMessage) {
  if (!rowid) return;
  db.prepare(`
    UPDATE raw_observations
       SET last_error = ?
     WHERE id = ?
  `).run(String(errorMessage ?? '').slice(0, 1000), rowid);
}
