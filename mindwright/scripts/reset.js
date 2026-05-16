#!/usr/bin/env node
// Destructive reset for mindwright. Drops the SQLite DB and all markdown mirrors.
// Models in ~/.cache/huggingface/hub/ are intentionally LEFT IN PLACE — they
// take 5-15 min to download and survive across resets / clean rebuilds.
//
// Dry-run by default. Pass --yes to actually delete.
//
// Emptying memory re-arms the SessionStart auto-seed gate
// (lib/seed-trigger.js#shouldAutoSeed): the next session would re-ingest this
// project's local transcripts and re-spawn the background consolidator,
// re-spending subscription tokens to rebuild exactly what is being deleted.
// Both the dry-run and the post-delete path surface that so a user purging
// unwanted/sensitive memory knows to set MINDWRIGHT_AUTO_SEED=false first
// (behavior-3).

import { rmSync, existsSync, readdirSync } from 'node:fs';
import { dataDir, dbPath, mirrorsDir, transcriptsDir } from '../lib/paths.js';
import { isDaemonAlive } from '../lib/daemon-status.js';

// Mirrors the two preconditions of lib/seed-trigger.js#shouldAutoSeed that a
// reset can evaluate without a live DB or a session id: auto-seed not opted
// out, and at least one local transcript to re-ingest. The third precondition
// (memory empty) is exactly what a reset establishes, so when this returns
// true the next SessionStart WILL re-bootstrap. Kept in lockstep with the
// real gate's `.jsonl` predicate.
function autoSeedWouldRebootstrap() {
  if (process.env.MINDWRIGHT_AUTO_SEED === 'false') return false;
  try {
    return readdirSync(transcriptsDir()).some((n) => n.endsWith('.jsonl'));
  } catch {
    return false; // no transcript dir for this project → nothing to re-ingest
  }
}

function writeRebootstrapWarning() {
  process.stderr.write(
    '\nNote: mindwright auto-seeds when memory is empty. The next Claude Code\n' +
    '      session in this project will re-ingest your local transcript history\n' +
    '      and re-spawn the background consolidator — re-spending subscription\n' +
    '      tokens to rebuild the memory you are deleting now. To reset WITHOUT\n' +
    '      re-bootstrapping (e.g. you are purging unwanted or sensitive memory),\n' +
    '      set MINDWRIGHT_AUTO_SEED=false before the next session.\n',
  );
}

function main() {
  const args = process.argv.slice(2);
  const confirmed = args.includes('--yes');
  // --force bypasses the active-daemon check for diagnostic recovery — e.g.
  // a crashed session left a stale ticket file but the DB is truly idle.
  // Two-stage override: when isDaemonAlive() returns true AND the user only
  // passed --force, we still refuse — single-flag override of an irreversible
  // destructive operation is too coarse. The user must additionally pass
  // --bypass-live-daemon to acknowledge "I really do mean to delete the DB
  // out from under a daemon that the ticket files say is alive." This guards
  // against the common user error of mis-judging whether the daemon is dead.
  const forced = args.includes('--force');
  const bypassLiveDaemon = args.includes('--bypass-live-daemon');

  // Refuse to delete while a daemon is alive. Two failure modes if we ignore
  // this and the user runs reset from another shell while a session is open:
  //   - Windows: rmSync(dbPath()) fails because better-sqlite3 holds an
  //     exclusive lock. Mirrors get deleted but the DB stays. Half-reset, no
  //     warning. User believes they're clean.
  //   - POSIX: rmSync succeeds at the directory entry but the daemon's open
  //     fd keeps writing to the orphan inode. New hooks open a fresh DB at
  //     the same path. Two separated stores diverge silently — retrieval
  //     and consolidation now point at different data.
  // Both are worse than refusing.
  // Two-stage override: --bypass-live-daemon alone is intentionally NOT a
  // sufficient escape hatch. The docs and the refusal messages below
  // describe a ladder (--yes → --force → --bypass-live-daemon); accepting
  // --bypass-live-daemon by itself would let a single mistaken flag wipe
  // an actively-bound DB. Require BOTH override flags for the bypass to
  // fire.
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
    if (autoSeedWouldRebootstrap()) writeRebootstrapWarning();
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
  if (autoSeedWouldRebootstrap()) writeRebootstrapWarning();
}

main();
