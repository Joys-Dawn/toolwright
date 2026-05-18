// Direct unit tests for lib/db-in-use.js. isDbInUse() is the OS/SQLite-
// enforced second signal reset.js consults before the irreversible rmSync
// (alongside isSessionLive()). It must answer one narrow question honestly:
// is some connection holding a lock on this DB *right now*?
//
// The same-process two-connection setup here is the correct unit-level probe:
// better-sqlite3 hands back an independent SQLite connection per `new
// Database()`, and SQLite's file locking contends across connections even
// within one process. reset.test.js exercises the cross-PROCESS path (it
// spawns reset.js); this file pins the function itself. The documented WAL
// limitation (an idle reader holding NO lock is invisible here) is the PID
// gate's job, not this probe's — so it is intentionally not asserted.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDbInUse } from '../lib/db-in-use.js';
import { loadNativeDefault } from '../lib/native-require.js';

function withTmpDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'mindwright-dbinuse-'));
  let result;
  try {
    result = fn(dir);
  } catch (err) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* tmp */ }
    throw err;
  }
  if (result && typeof result.then === 'function') {
    return result.then(
      (v) => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* tmp */ } return v; },
      (err) => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* tmp */ } throw err; },
    );
  }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* tmp */ }
  return result;
}

test('non-string / empty argument → false (never throws)', async () => {
  const bads = [undefined, null, 0, 42, {}, [], ''];
  const results = await Promise.all(bads.map((b) => isDbInUse(b)));
  results.forEach((r, i) => assert.equal(
    r, false, `isDbInUse(${JSON.stringify(bads[i])}) must be false`,
  ));
});

test('a path that does not exist → false (nothing to be in use)', async () => {
  await withTmpDir(async (dir) => {
    assert.equal(await isDbInUse(join(dir, 'no-such.db')), false);
  });
});

test('a corrupt / non-SQLite file → false (reset is the recovery path; must not trap the user)', async () => {
  await withTmpDir(async (dir) => {
    const p = join(dir, 'garbage.db');
    writeFileSync(p, 'this is definitely not a sqlite database header');
    assert.equal(await isDbInUse(p), false);
  });
});

test('an idle real DB (no connection holding a lock) → false', async () => {
  await withTmpDir(async (dir) => {
    const Database = await loadNativeDefault('better-sqlite3');
    const p = join(dir, 'idle.db');
    const db = new Database(p);
    db.pragma('journal_mode = WAL');
    db.exec('CREATE TABLE t(x)');
    db.close(); // released — no lock holder remains
    assert.equal(await isDbInUse(p), false,
      'a closed DB has no lock holder → not in use');
  });
});

test('a DB with another connection holding BEGIN EXCLUSIVE → true', async () => {
  await withTmpDir(async (dir) => {
    const Database = await loadNativeDefault('better-sqlite3');
    const p = join(dir, 'locked.db');
    const held = new Database(p);
    held.pragma('journal_mode = WAL');
    held.exec('CREATE TABLE t(x)');
    held.pragma('busy_timeout = 0');
    held.exec('BEGIN EXCLUSIVE'); // hold the write lock
    try {
      assert.equal(await isDbInUse(p), true,
        'a held BEGIN EXCLUSIVE on a separate connection must read as in-use');
    } finally {
      try { held.exec('ROLLBACK'); } catch { /* */ }
      held.close();
    }
    // And once the lock is released, the same DB reads idle again.
    assert.equal(await isDbInUse(p), false,
      'after ROLLBACK + close the lock is gone → not in use');
  });
});
