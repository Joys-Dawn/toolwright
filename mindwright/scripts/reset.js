#!/usr/bin/env node
// Destructive reset: drops the SQLite DB and all markdown mirrors. Dry-run by
// default; pass --yes to actually delete. Models in ~/.cache/huggingface/hub/
// are left in place — they take 5-15 min to download and survive resets.

import { rmSync, existsSync } from 'node:fs';
import { dataDir, dbPath, mirrorsDir } from '../lib/paths.js';
import { isDaemonAlive } from '../lib/daemon-status.js';

function main() {
  const args = process.argv.slice(2);
  const confirmed = args.includes('--yes');
  // Two-stage override (--force, then --bypass-live-daemon): a single-flag
  // override of an irreversible delete is too coarse — it guards against the
  // common user error of mis-judging whether the daemon is dead.
  const forced = args.includes('--force');
  const bypassLiveDaemon = args.includes('--bypass-live-daemon');

  // Refuse to delete while a daemon is alive — both failure modes are worse
  // than refusing:
  //   - Windows: rmSync(dbPath()) fails on better-sqlite3's exclusive lock,
  //     leaving a half-reset (mirrors gone, DB stays) with no warning.
  //   - POSIX: rmSync removes the dir entry but the daemon's open fd keeps
  //     writing the orphan inode while new hooks open a fresh DB at the same
  //     path — two stores diverge silently.
  // Require BOTH override flags so a single mistaken flag can't wipe an
  // actively-bound DB.
  if (confirmed && isDaemonAlive() && !(forced && bypassLiveDaemon)) {
    if (forced) {
      process.stderr.write(
        'mindwright reset: refusing to delete — daemon is still showing alive even with --force.\n' +
        '\n' +
        '  --force is meant for the recovery case where a crashed session left a stale ticket\n' +
        '  but the DB is truly idle. Right now the ticket files are fresh, which means a session\n' +
        '  could actively be writing. Deleting the DB underneath it would corrupt state.\n' +
        '\n' +
        '  Two options:\n' +
        '    1. Close the Claude Code session(s) in this project, wait ~10s for the tickets\n' +
        '       to expire, then re-run with just --yes (the safe path).\n' +
        '    2. If you are certain the daemon process is actually dead (only the ticket file\n' +
        '       is lingering), pass --bypass-live-daemon alongside --yes --force.\n',
      );
    } else {
      process.stderr.write(
        'mindwright reset: refusing to delete — an active daemon is bound to this project root.\n' +
        '\n' +
        '  Close the Claude Code session(s) in this project first, wait ~10s for the ticket\n' +
        '  to expire, then re-run with --yes. The daemon proxies retrieval and embedding;\n' +
        '  deleting the DB underneath it would leave the running session writing to an\n' +
        '  orphan inode (POSIX) or fail mid-delete leaving half the files (Windows).\n' +
        '\n' +
        '  If you are sure no session is actually writing (e.g. recovering from a crashed\n' +
        '  daemon whose ticket is still fresh), pass --force alongside --yes — and if --force\n' +
        '  still refuses because the ticket really is fresh, also add --bypass-live-daemon.\n',
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
    process.stderr.write('\nPass --yes to actually delete. Models in ~/.cache/huggingface/hub/ are not touched.\n');
    if (isDaemonAlive()) {
      process.stderr.write(
        '\nNote: an active daemon is currently bound to this project — close the Claude Code\n' +
        '      session before passing --yes, or add --force alongside --yes to bypass.\n',
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

main();
