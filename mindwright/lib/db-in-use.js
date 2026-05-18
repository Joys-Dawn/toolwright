// Belt-and-suspenders for the destructive reset path: is the SQLite DB
// actively locked by another connection RIGHT NOW?
//
// The authoritative "is a session bound" signal is session-liveness.js
// (a live Claude PID in a ticket). This is the OS/SQLite-enforced second
// signal, used ONLY by reset.js before the irreversible rmSync: even when no
// ticket names a live PID, if some connection actively holds the DB lock we
// must not delete it.
//
// Mechanism is the SQLite-documented one: open a throwaway connection and
// `BEGIN EXCLUSIVE`. If another connection holds a write/exclusive lock it
// fails SQLITE_BUSY (busy_timeout=0 → immediate, no wait); we never acquire
// or hold a lock that could disturb a live writer (immediate ROLLBACK).
//
// KNOWN LIMITATION (by SQLite design, not a defect): in WAL mode this CANNOT
// detect a connection that merely has the DB open for *reading* and holds no
// lock — only a lock-holder is detectable. That idle-but-alive session is
// exactly what the PID-liveness gate in reset.js covers; the two signals are
// complementary, and `--force --bypass-live-daemon` remains the escape hatch
// for the residual. Hence: a `false` here does NOT prove "nobody is using
// it" — it only proves "no connection is holding a lock". reset.js treats
// `isSessionLive() || isDbInUse()` as the refuse condition for that reason.

import { existsSync } from 'node:fs';
import { depsInstalled } from './ready.js';
import { loadNativeDefault } from './native-require.js';

/**
 * @param {string} dbFilePath absolute path to the SQLite db file
 * @returns {Promise<boolean>} true ONLY if a live connection holds a lock on
 *   the DB. false when: the file is absent, native deps aren't installed (no
 *   mindwright connection can exist without better-sqlite3), the file isn't a
 *   valid database (corrupt — reset is the recovery path, must not block), or
 *   any non-BUSY error. Never throws.
 */
export async function isDbInUse(dbFilePath) {
  if (typeof dbFilePath !== 'string' || !dbFilePath) return false;
  // No file → nothing to be in use. No native deps → no better-sqlite3, so
  // no mindwright session can be holding a connection: definitively idle.
  if (!existsSync(dbFilePath)) return false;
  if (!depsInstalled()) return false;

  let Database;
  try {
    Database = await loadNativeDefault('better-sqlite3');
  } catch {
    // deps marker passed but the module won't load — can't probe; the PID
    // gate in reset.js is the primary signal, don't wedge reset on this.
    return false;
  }

  let db;
  try {
    // RW (a readonly handle cannot take the write lock BEGIN EXCLUSIVE
    // needs); fileMustExist so a race-delete can't recreate it.
    db = new Database(dbFilePath, { readonly: false, fileMustExist: true });
    db.pragma('busy_timeout = 0'); // SQLITE_BUSY immediately, never wait
    db.exec('BEGIN EXCLUSIVE');
    // We got the lock → no other connection holds one. Release at once.
    db.exec('ROLLBACK');
    return false;
  } catch (e) {
    if (e && (e.code === 'SQLITE_BUSY' || e.code === 'SQLITE_BUSY_SNAPSHOT')) {
      return true; // another live connection holds the lock
    }
    // SQLITE_NOTADB / corrupt / anything else: NOT "in use". reset is how a
    // corrupt DB is recovered — refusing here would trap the user.
    return false;
  } finally {
    try {
      if (db) db.close();
    } catch {
      /* already gone */
    }
  }
}
