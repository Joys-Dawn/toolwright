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

export function archive(db, id, reason, actor = 'orchestrator') {
  const current = db.prepare('SELECT status FROM ideas WHERE id = ?').get(id);
  db.prepare(`UPDATE ideas SET status = 'archived', updated_at = datetime('now') WHERE id = ?`).run(id);
  logTransition(db, id, current?.status ?? null, 'archived', actor, reason);
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

function logTransition(db, idea_id, from_status, to_status, actor, note) {
  db.prepare(`
    INSERT INTO state_log (idea_id, from_status, to_status, actor, note)
    VALUES (?, ?, ?, ?, ?)
  `).run(idea_id, from_status, to_status, actor, note);
}
