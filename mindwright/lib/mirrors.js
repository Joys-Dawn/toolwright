// Markdown audit mirrors: every write path that mutates `entries` calls
// renderAll(store) to regenerate the diff-readable markdown reflection of the
// active tier under .claude/mindwright/mirrors/.

import { writeFileSync, mkdirSync, existsSync, readFileSync, lstatSync, renameSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { mirrorsDir } from './paths.js';
import { ROLE_PATTERN } from './constants.js';
import { pluralize } from './grammar.js';

export function renderAll(store) {
  const dir = mirrorsDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  writeIfChanged(join(dir, 'recent.md'), renderRecent(store));
  writeIfChanged(join(dir, 'preferences.md'), renderPreferences(store));
  writeIfChanged(join(dir, 'project.md'), renderProjectFacts(store));
  writeIfChanged(join(dir, 'episodes.md'), renderEpisodes(store));

  // Heuristics: one file per role.
  for (const role of store.listActiveProceduralRoles()) {
    // Defense-in-depth: a role that landed in the DB without the whitelist
    // passing would otherwise make this loop a path-traversal primitive.
    if (typeof role !== 'string' || !ROLE_PATTERN.test(role)) continue;
    const p = join(dir, 'agents', role, 'heuristics.md');
    mkdirSync(dirname(p), { recursive: true });
    writeIfChanged(p, renderHeuristics(store, role));
  }
}

function renderTier({ rows, head, emptyMarker, formatRow }) {
  if (!rows.length) return head + emptyMarker;
  return head + rows.map(formatRow).join('\n');
}

export function renderRecent(store, { limit = 50 } = {}) {
  const rows = store.listShortTermRecent(limit);
  return renderTier({
    rows,
    head:
      `# Recent observations\n\n` +
      `Last ${rows.length} short-term entries, newest first. Auto-generated; do not edit.\n\n`,
    emptyMarker: `_(none)_\n`,
    formatRow: (r) =>
      `## #${r.id} · ${r.kind} · ${r.created_at}\n` +
      `_session_: \`${r.session_id}\`\n\n` +
      `${r.content}\n`,
  });
}

export function renderPreferences(store) {
  return renderTier({
    rows: store.listLongTermByCategoryScope('fact', 'user'),
    head:
      `# User preferences\n\n` +
      `Active facts scoped to the user (preferences, environment, identity). ` +
      `Auto-generated from \`mindwright.db\`; do not edit.\n\n`,
    emptyMarker: `_(none yet — run \`/mindwright:dream\` to consolidate.)_\n`,
    formatRow: (r) =>
      `## #${r.id} · confidence ${formatConfidence(r.confidence)} · ${r.created_at}\n` +
      `${r.content}\n`,
  });
}

export function renderProjectFacts(store) {
  return renderTier({
    rows: store.listLongTermByCategoryScope('fact', 'project'),
    head:
      `# Project facts\n\n` +
      `Active facts scoped to the project. Auto-generated; do not edit.\n\n`,
    emptyMarker: `_(none yet.)_\n`,
    formatRow: (r) => `## #${r.id} · ${r.created_at}\n${r.content}\n`,
  });
}

export function renderEpisodes(store) {
  return renderTier({
    rows: store.listLongTermEpisodes(),
    head:
      `# Episodes\n\n` +
      `Active episodic memories — lessons learned, incidents, post-mortems. ` +
      `Auto-generated; do not edit.\n\n`,
    emptyMarker: `_(none yet.)_\n`,
    formatRow: (r) =>
      `## #${r.id} · scope \`${r.scope || '?'}\` · ${r.created_at}\n${r.content}\n`,
  });
}

export function renderHeuristics(store, role) {
  return renderTier({
    rows: store.listLongTermByCategoryScope('procedural', `role:${role}`),
    head:
      `# Heuristics for role \`${role}\`\n\n` +
      `Active procedural facts scoped to \`role:${role}\`. Auto-generated; do not edit.\n\n`,
    emptyMarker: `_(none yet.)_\n`,
    formatRow: (r) => `## #${r.id} · ${r.created_at}\n${r.content}\n`,
  });
}

function formatConfidence(c) {
  if (c == null) return '—';
  return c.toFixed(2);
}

// Audit archive written before finalizeDrain hard-deletes rows, so the user
// can grep/diff/re-import anything that turned out to matter.
// MINDWRIGHT_DROPPED_ARCHIVE=off skips it.
export function writeDroppedArchive({ drainId, sessionId, firedAt, rows, producedCount }) {
  if (process.env.MINDWRIGHT_DROPPED_ARCHIVE === 'off') return null;
  if (!Array.isArray(rows) || rows.length === 0) return null;

  const dir = join(mirrorsDir(), 'dropped');
  mkdirSync(dir, { recursive: true });

  // drainId is internal, but keep the path-safe guarantee anyway.
  const safeDrainId = String(drainId || 'unknown').replace(/[^A-Za-z0-9._-]/g, '_');
  const day = (firedAt && typeof firedAt === 'string' ? firedAt : new Date().toISOString()).slice(0, 10);
  const path = join(dir, `${day}-${safeDrainId}.md`);

  const header =
    `# Drained short-term rows · ${safeDrainId}\n\n` +
    `Captured before /mindwright:dream's finalize step hard-deleted these ` +
    `entries. The consolidator produced ${pluralize(producedCount, 'fact')} ` +
    `from this batch; everything below is what was discarded (either folded ` +
    `into those facts or judged not worth retaining). Audit and hand-re-import ` +
    `anything you want back.\n\n` +
    `- drain_id: \`${safeDrainId}\`\n` +
    `- session_id: \`${sessionId || 'all'}\`\n` +
    `- fired_at: ${firedAt || '?'}\n` +
    `- drained_count: ${rows.length}\n` +
    `- produced_count: ${producedCount}\n\n`;

  const body = rows.map((r) => (
    `## #${r.id} · ${r.kind || 'unknown'} · ${r.created_at}\n` +
    `_session_: \`${r.session_id || '?'}\`\n\n` +
    `${r.content || ''}\n`
  )).join('\n');

  writeFileSync(path, header + body, 'utf8');
  return path;
}

// Windows MoveFileEx (unlike POSIX rename(2)) fails with EPERM/EACCES/EBUSY
// when another process has the destination briefly open (racing writer,
// antivirus, indexer); the contention clears within ms so a bounded backoff
// retry turns a hard failure into a short wait. Safe to retry because the
// source is a pid-scoped temp — only the shared destination is contended.
const TRANSIENT_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
function renameWithRetry(from, to, attempts = 10) {
  for (let i = 0; ; i++) {
    try {
      renameSync(from, to);
      return;
    } catch (err) {
      if (i >= attempts - 1 || !err || !TRANSIENT_RENAME_CODES.has(err.code)) {
        throw err;
      }
      // Synchronous backoff (writeIfChanged is sync). Atomics.wait on a fresh
      // zeroed SAB is the canonical dep-free synchronous sleep.
      const ms = 5 * (i + 1);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    }
  }
}

// Skip rewriting unchanged content (no spurious mtime churn).
//
// Defense-in-depth: refuse to follow a symlink at the target — a planted
// symlink could redirect this writeFileSync (which includes partially
// user-controllable retained fact bodies) onto an arbitrary path. The
// lstat-then-rename pair has a small TOCTOU window, but rename(2)/MoveFileEx
// replace the symlink-as-link rather than following it, so the worst case is
// overwriting the planted symlink with a regular file — no escape. The lstat
// is therefore primarily a loud-failure diagnostic.
function writeIfChanged(path, content) {
  let isSymlink = false;
  try {
    const st = lstatSync(path);
    isSymlink = st.isSymbolicLink();
  } catch (err) {
    if (err && err.code !== 'ENOENT') throw err;
  }
  if (isSymlink) {
    throw new Error(`mindwright mirrors: refusing to write through symlink at ${path}`);
  }
  try {
    const existing = readFileSync(path, 'utf8');
    if (existing === content) return false;
  } catch {
    // file doesn't exist — fall through and write
  }
  // Atomic replace via temp + rename: direct writeFileSync is not atomic
  // (concurrent reader sees partial bytes; two concurrent writers tear the
  // file). The .tmp.<pid> suffix scopes the temp to this process.
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, content, 'utf8');
  try {
    renameWithRetry(tmp, path);
  } catch (err) {
    // Rename still failed after the transient-retry budget (or failed with
    // a non-transient code) — best-effort cleanup of the orphan temp so we
    // don't leak files into the mirrors dir.
    try { unlinkSync(tmp); } catch { /* */ }
    throw err;
  }
  return true;
}
