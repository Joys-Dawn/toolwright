#!/usr/bin/env node
// Destructive reset: drops the SQLite DB and all markdown mirrors. Dry-run by
// default; pass --yes to actually delete. Models in the plugin's persistent
// data dir (${CLAUDE_PLUGIN_DATA}/model-cache) are left in place — they take
// 5-15 min to download and survive resets.

import { rmSync, existsSync } from 'node:fs';
import { dataDir, dbPath, mirrorsDir } from '../lib/paths.js';
import { isSessionLive } from '../lib/session-liveness.js';
import { isDbInUse } from '../lib/db-in-use.js';

async function main() {
  const args = process.argv.slice(2);
  const confirmed = args.includes('--yes');
  // Two-stage override (--force, then --bypass-live-daemon): a single-flag
  // override of an irreversible delete is too coarse — it guards against the
  // common user error of mis-judging whether anything is still bound.
  const forced = args.includes('--force');
  const bypassLiveDaemon = args.includes('--bypass-live-daemon');

  // Two complementary liveness signals (see session-liveness.js / db-in-use.js):
  //   - isSessionLive(): a Claude CLI process is bound via a live ticket PID
  //     (catches an alive-but-idle session — the common case).
  //   - isDbInUse(): some connection actively holds the SQLite lock RIGHT NOW
  //     (OS/SQLite-enforced; catches an active writer even with no live
  //     ticket). WAL cannot detect an idle reader — that is the session
  //     signal's job; together they are strictly safer than either alone.
  const liveBound = isSessionLive() || (await isDbInUse(dbPath()));

  // Refuse to delete while something is bound — both failure modes are worse
  // than refusing:
  //   - Windows: rmSync(dbPath()) fails on better-sqlite3's exclusive lock,
  //     leaving a half-reset (mirrors gone, DB stays) with no warning.
  //   - POSIX: rmSync removes the dir entry but a live connection's open fd
  //     keeps writing the orphan inode while new hooks open a fresh DB at the
  //     same path — two stores diverge silently.
  // Require BOTH override flags so a single mistaken flag can't wipe an
  // actively-bound DB.
  if (confirmed && liveBound && !(forced && bypassLiveDaemon)) {
    if (forced) {
      process.stderr.write(
        'mindwright reset: refusing to delete — still showing bound even with --force.\n' +
        '\n' +
        '  --force is meant for the recovery case where a crashed session left a stale ticket\n' +
        '  but the DB is truly idle. Right now either a live Claude session is bound or the\n' +
        '  database is actively in use, so deleting it could corrupt state.\n' +
        '\n' +
        '  Two options:\n' +
        '    1. Close the Claude Code session(s) in this project, then re-run with just --yes\n' +
        '       (the safe path — the guard clears as soon as nothing is bound).\n' +
        '    2. If you are certain nothing is actually using the DB (only a stale ticket is\n' +
        '       lingering), pass --bypass-live-daemon alongside --yes --force.\n',
      );
    } else {
      process.stderr.write(
        'mindwright reset: refusing to delete — a Claude session is bound to this project\n' +
        '  (or the database is actively in use).\n' +
        '\n' +
        '  Close the Claude Code session(s) in this project first, then re-run with --yes.\n' +
        '  Deleting the DB while it is in use would leave a running session writing to an\n' +
        '  orphan inode (POSIX) or fail mid-delete leaving half the files (Windows).\n' +
        '\n' +
        '  If you are sure nothing is actually using it (e.g. recovering from a crashed\n' +
        '  session whose ticket lingers), pass --force alongside --yes — and if --force\n' +
        '  still refuses, also add --bypass-live-daemon.\n',
      );
    }
    process.exitCode = 1;
    return;
  }

  const targets = [
    { path: dbPath(), label: 'database file', recursive: false },
    { path: mirrorsDir(), label: 'markdown mirrors directory', recursive: true },
  ];
  // Also nuke -wal / -shm sidecars left behind by WAL mode.
  for (const sfx of ['-wal', '-shm']) {
    targets.push({ path: `${dbPath()}${sfx}`, label: `WAL sidecar (${sfx})`, recursive: false });
  }

  const present = targets.filter((t) => existsSync(t.path));

  if (present.length === 0) {
    process.stderr.write(`Nothing to delete. data dir: ${dataDir()}\n`);
    return;
  }

  if (!confirmed) {
    process.stderr.write('mindwright reset — DRY RUN. Would delete:\n');
    for (const t of present) {
      process.stderr.write(`  ${t.path}    (${t.label})\n`);
    }
    process.stderr.write('\nPass --yes to actually delete. Cached models are not touched (they live in the plugin data dir, outside the project).\n');
    if (liveBound) {
      process.stderr.write(
        '\nNote: a Claude session is currently bound to this project (or the DB is in use) —\n' +
        '      close the Claude Code session before passing --yes, or add --force alongside\n' +
        '      --yes to bypass.\n',
      );
    }
    return;
  }

  process.stderr.write('mindwright reset — DELETING:\n');
  for (const t of present) {
    try {
      rmSync(t.path, { recursive: t.recursive, force: true });
      process.stderr.write(`  removed: ${t.path}\n`);
    } catch (e) {
      process.stderr.write(`  FAILED:  ${t.path} (${e.message})\n`);
      process.exitCode = 2;
    }
  }
  process.stderr.write('Done. Models cache is intact.\n');
}

main().catch((e) => {
  process.stderr.write(`mindwright reset crashed: ${(e && e.message) || e}\n`);
  process.exitCode = 1;
});
