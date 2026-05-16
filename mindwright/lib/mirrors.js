// Markdown audit mirrors.
//
// Every write path that mutates `entries` (consolidator finalize, explicit retain,
// deferred-embed sweeper, hook fallback resync) calls renderAll(store) to
// regenerate the markdown reflection of the active tier. Mirrors are intended
// to be gitignored locally and diff-readable: every fact ends up under a
// human-readable header.
//
// Layout (all paths under .claude/mindwright/mirrors/):
//   recent.md           — last 50 short-term observations, newest first
//   preferences.md      — active fact rows with scope='user'
//   project.md          — active fact rows with scope='project'
//   episodes.md         — active episodic rows (typically scope='project')
//   agents/<role>/heuristics.md — active procedural rows scoped to role:<role>

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

  // Heuristics: one file per role. Role list comes from Store so raw SQL
  // stays out of this file.
  for (const role of store.listActiveProceduralRoles()) {
    // Defense-in-depth: handlers validate at the write boundary, but a role
    // that somehow landed in the DB without the whitelist passing (direct
    // SQL, legacy row, future code path) would otherwise turn this loop
    // into a path-traversal primitive. Skip anything not path-safe.
    if (typeof role !== 'string' || !ROLE_PATTERN.test(role)) continue;
    const p = join(dir, 'agents', role, 'heuristics.md');
    mkdirSync(dirname(p), { recursive: true });
    writeIfChanged(p, renderHeuristics(store, role));
  }
}

// Shared scaffolding: head + (empty-marker | rows.map(...).join). Each tier
// renderer is now a config (rows / head / emptyMarker / formatRow) passed in.
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

// Audit archive for /mindwright:dream. finalizeDrain hard-deletes rows after
// the calling Claude session finishes distilling — if the consolidator decided
// nothing was worth retaining, that data is otherwise gone with no recourse.
// Before the DELETE we write a markdown copy here so the user can grep / diff
// / hand-re-import anything that turned out to matter. Set
// MINDWRIGHT_DROPPED_ARCHIVE=off to skip if you want zero on-disk residue.
//
// Layout: <mirrorsDir>/dropped/<YYYY-MM-DD>-<drainId>.md
export function writeDroppedArchive({ drainId, sessionId, firedAt, rows, producedCount }) {
  if (process.env.MINDWRIGHT_DROPPED_ARCHIVE === 'off') return null;
  if (!Array.isArray(rows) || rows.length === 0) return null;

  const dir = join(mirrorsDir(), 'dropped');
  mkdirSync(dir, { recursive: true });

  // drainId is internal and not user-controlled, but keep the path-safe
  // guarantee anyway — defense-in-depth, same as the role whitelist above.
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

// Windows-only transient rename failures. Unlike POSIX rename(2) — which
// atomically replaces the destination — Windows MoveFileEx fails with
// EPERM/EACCES/EBUSY when another process has the destination briefly open
// (a racing renderAll writer, antivirus, or the Search indexer). The
// contention clears within milliseconds, so a bounded retry with linear
// backoff turns a hard failure into a short wait. This is the same approach
// npm's write-file-atomic and graceful-fs take for the documented Windows
// rename race. On POSIX the first attempt always succeeds for this pattern,
// so the loop is a no-op there. Safe to retry because the source is a
// pid-scoped temp (`.tmp.<pid>`) — no other process can be racing THIS
// source path; only the shared destination is contended.
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
      // Synchronous backoff (writeIfChanged is sync, called from sync
      // renderAll): 5,10,15,…,50 ms — worst case ~275 ms total across 10
      // tries, far below user-perceptible mirror latency and far rarer
      // than once per run. Atomics.wait on a fresh zeroed SAB is the
      // canonical dependency-free synchronous sleep.
      const ms = 5 * (i + 1);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    }
  }
}

// Avoid rewriting a file whose content hasn't changed (no spurious mtime churn
// when consolidator runs but nothing actually changed in a tier).
//
// Defense-in-depth: refuse to follow a symlink at the target. The mirrors dir
// is supposed to be project-local plain files; a planted symlink (e.g. by a
// co-located local user, or a stray prior run) could redirect a writeFileSync
// through it onto an arbitrary path the owning user can write. Mirror content
// includes partially-controllable text (retained fact bodies), so following a
// symlink here is a real surface even at low likelihood.
//
// TOCTOU note: the lstat-then-rename pair has a small race window. We rely on
// two structural guarantees that make this residual gap acceptable:
//   1. The mirrors directory (`.claude/mindwright/mirrors/`) is owned by the
//      project user and only this plugin writes to it — there is no other
//      process with legitimate write access racing against us.
//   2. Even if a symlink IS injected between lstat and rename, `rename(2)` on
//      POSIX and `MoveFileEx` on Windows both replace the symlink-as-link,
//      they do not follow it. The worst case is overwriting a planted
//      symlink with a regular file containing the mirror content — no
//      escape to an arbitrary target. The lstat is therefore primarily
//      diagnostic (loud failure when the directory has been tampered with)
//      rather than the sole defense.
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
  // Atomic replace via temp-file + rename. Direct writeFileSync is NOT
  // atomic — a concurrent reader sees partial bytes mid-write, and two
  // concurrent writers (consolidator's renderAll plus a user-triggered
  // mindwright_retain renderAll) can produce a torn file with interleaved
  // fragments. The .tmp.<pid> suffix scopes the temp file to the calling
  // process so two parallel writes don't clobber each other's temp.
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
