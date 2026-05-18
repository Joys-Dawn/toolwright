// Coverage for the machine-wide model daemon's singleton election
// (lib/model-daemon-singleton.js). scripts/model-daemon.mjs gates on
// deps+cached-models before ever calling acquireSingleton, so it cannot be
// exercised end-to-end in the hermetic suite — the election logic was
// extracted into a dep-free, isPidAlive-injectable helper so the O_EXCL race
// and all three stale-lock self-heal branches are unit-testable without
// forking ONNX, plus one real two-process race for the cross-process
// invariant (exactly one live racer binds).
//
// Branches pinned here:
//   - no lock        → wins, writes {pid,protocol,startedAt}
//   - live owner     → returns false, lock untouched
//   - dead-pid lock  → stale: unlinks + wins
//   - wrong-protocol → stale (before the liveness probe even runs) + wins
//   - corrupt JSON   → stale: unlinks + wins
//   - holder.pid === our pid → stale (self defensive) + wins
//   - 5-attempt exhaustion (lock un-removable every iteration) → false
//   - two real processes racing one lock → exactly one WON

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { acquireSingleton } from '../../lib/model-daemon-singleton.js';
import { MODEL_DAEMON_PROTOCOL } from '../../lib/constants.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MODULE_ABS = join(HERE, '..', '..', 'lib', 'model-daemon-singleton.js');

function withTmp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'mindwright-modeld-singleton-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const ALIVE = () => true;
const DEAD = () => false;

test('no existing lock → wins and writes {pid,protocol,startedAt}', () => {
  withTmp((dir) => {
    const lock = join(dir, 'a.lock');
    const won = acquireSingleton(lock, { isPidAlive: ALIVE });
    assert.equal(won, true);
    const h = JSON.parse(readFileSync(lock, 'utf8'));
    assert.equal(h.pid, process.pid);
    assert.equal(h.protocol, MODEL_DAEMON_PROTOCOL);
    assert.ok(!Number.isNaN(Date.parse(h.startedAt)), `startedAt must be ISO, got ${h.startedAt}`);
  });
});

test('live owner (foreign pid, matching protocol, isPidAlive→true) → false, lock untouched', () => {
  withTmp((dir) => {
    const lock = join(dir, 'b.lock');
    const original = JSON.stringify({ pid: 424242, protocol: MODEL_DAEMON_PROTOCOL, startedAt: 'x' });
    writeFileSync(lock, original);
    const won = acquireSingleton(lock, { isPidAlive: ALIVE });
    assert.equal(won, false);
    assert.equal(readFileSync(lock, 'utf8'), original, 'a live owner must not have its lock rewritten');
  });
});

test('stale dead-pid lock (matching protocol, isPidAlive→false) → unlinks and wins', () => {
  withTmp((dir) => {
    const lock = join(dir, 'c.lock');
    writeFileSync(lock, JSON.stringify({ pid: 424242, protocol: MODEL_DAEMON_PROTOCOL, startedAt: 'x' }));
    const won = acquireSingleton(lock, { isPidAlive: DEAD });
    assert.equal(won, true);
    assert.equal(JSON.parse(readFileSync(lock, 'utf8')).pid, process.pid);
  });
});

test('wrong-protocol lock is stale even if its pid would be alive (protocol gate precedes liveness probe)', () => {
  withTmp((dir) => {
    const lock = join(dir, 'd.lock');
    writeFileSync(lock, JSON.stringify({ pid: 424242, protocol: 'NOT-OUR-PROTOCOL', startedAt: 'x' }));
    let probed = false;
    const won = acquireSingleton(lock, { isPidAlive: () => { probed = true; return true; } });
    assert.equal(won, true);
    assert.equal(probed, false, 'protocol mismatch must short-circuit before isPidAlive is consulted');
    assert.equal(JSON.parse(readFileSync(lock, 'utf8')).protocol, MODEL_DAEMON_PROTOCOL);
  });
});

test('corrupt (unparseable) lock → treated stale, unlinks and wins', () => {
  withTmp((dir) => {
    const lock = join(dir, 'e.lock');
    writeFileSync(lock, '{ this is : not json');
    const won = acquireSingleton(lock, { isPidAlive: ALIVE });
    assert.equal(won, true);
    assert.equal(JSON.parse(readFileSync(lock, 'utf8')).pid, process.pid);
  });
});

test("holder.pid === our own pid → stale (defensive self-check), wins", () => {
  withTmp((dir) => {
    const lock = join(dir, 'f.lock');
    writeFileSync(lock, JSON.stringify({ pid: process.pid, protocol: MODEL_DAEMON_PROTOCOL, startedAt: 'x' }));
    // isPidAlive→true would be irrelevant: the `holder.pid !== process.pid`
    // guard makes liveOwner false regardless, so this self-owned lock is
    // reclaimed rather than mistaken for a live peer.
    const won = acquireSingleton(lock, { isPidAlive: ALIVE });
    assert.equal(won, true);
  });
});

test('5-attempt exhaustion (lock un-removable every iteration) → false', () => {
  withTmp((dir) => {
    // A directory at lockPath: openSync('wx') → EEXIST every attempt (so the
    // non-EEXIST rethrow is skipped), readFileSync → EISDIR (holder=null →
    // not a live owner), unlinkSync → EPERM (caught; the dir survives). Every
    // one of the 5 iterations therefore loops, and the post-loop `return
    // false` fires — the "lost every race to a peer that keeps reclaiming"
    // path, deterministically.
    const lock = join(dir, 'g.lock');
    mkdirSync(lock);
    const won = acquireSingleton(lock, { isPidAlive: ALIVE });
    assert.equal(won, false);
    assert.ok(existsSync(lock), 'the un-removable lock dir must still be present');
  });
});

test('non-EEXIST openSync error propagates (not swallowed as stale)', () => {
  withTmp((dir) => {
    // lockPath under a *file* (not a dir): openSync → ENOTDIR, which is not
    // EEXIST, so acquireSingleton must rethrow rather than treat it as a
    // stale lock to clear.
    const notADir = join(dir, 'plain-file');
    writeFileSync(notADir, 'x');
    const lock = join(notADir, 'nested.lock');
    assert.throws(
      () => acquireSingleton(lock, { isPidAlive: ALIVE }),
      (err) => err && err.code !== 'EEXIST',
    );
  });
});

// --- Cross-process invariant: two real processes, one lock --------------

// The worker reports the election result as a discrete stdout line, then —
// if it WON — blocks on stdin and exits only when the parent closes it. That
// gives the test two deterministic signals (no wall-clock): "worker has
// finished electing" (its first line) and "winner is still alive" (it cannot
// exit until we release its stdin).
const WORKER = `
import { pathToFileURL } from 'node:url';
const [, , modAbs, lockPath] = process.argv;
const { acquireSingleton } = await import(pathToFileURL(modAbs).href);
const won = acquireSingleton(lockPath);
process.stdout.write(won ? 'WON\\n' : 'LOST\\n');
if (won) {
  // Stay alive until the parent ends our stdin, so a racing loser
  // deterministically observes a LIVE owner — no winner-alive timer.
  process.stdin.resume();
  const bye = () => process.exit(0);
  process.stdin.on('end', bye);
  process.stdin.on('close', bye);
} else {
  process.exit(0);
}
`;

// Spawn a worker; expose its first complete stdout line and its exit as
// promises so the test orchestrates by handshake, never by elapsed time.
function spawnWorker(workerPath, lockPath) {
  const child = spawn(process.execPath, [workerPath, MODULE_ABS, lockPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  let resolveLine;
  const firstLine = new Promise((res) => { resolveLine = res; });
  child.stdout.on('data', (d) => {
    out += d;
    const nl = out.indexOf('\n');
    if (nl !== -1) resolveLine(out.slice(0, nl)); // idempotent: first line wins
  });
  child.stderr.on('data', (d) => { err += d; });
  const exit = new Promise((res, rej) => {
    child.on('error', rej);
    child.on('close', (code) => res({ code, out: out.trim(), err: err.trim(), pid: child.pid }));
  });
  return { child, firstLine, exit };
}

test('two real processes race one lock → exactly one WON (deterministic handshake, no wall-clock)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mindwright-modeld-race-'));
  const workerPath = join(dir, 'worker.mjs');
  const lockPath = join(dir, 'race.lock');
  writeFileSync(workerPath, WORKER);
  try {
    // Worker 1 is uncontested → must WIN. Worker 2 is spawned ONLY after
    // worker 1's first line proves it acquired the lock — that handshake,
    // not a fixed timer, is the ordering guarantee.
    const w1 = spawnWorker(workerPath, lockPath);
    const line1 = await w1.firstLine;
    assert.equal(line1, 'WON', `uncontested acquire must win, got ${line1}`);
    assert.ok(existsSync(lockPath), 'lock file must exist once worker 1 reports WON');

    // Worker 1 is now blocked on stdin (provably alive — it cannot exit
    // until we end its stdin below). Worker 2 therefore races a guaranteed
    // -live owner and must LOSE: no winner-alive sleep involved.
    const w2 = spawnWorker(workerPath, lockPath);
    const line2 = await w2.firstLine;
    const r2 = await w2.exit;
    assert.equal(line2, 'LOST', `a racer against a live owner must lose, got ${line2}`);
    assert.equal(r2.code, 0, `loser exits cleanly; stderr=${r2.err}`);

    // Release worker 1 deterministically (close its stdin → it exits 0).
    w1.child.stdin.end();
    const r1 = await w1.exit;
    assert.equal(r1.code, 0, `winner exits cleanly; stderr=${r1.err}`);
    assert.equal(r1.out, 'WON');

    const holder = JSON.parse(readFileSync(lockPath, 'utf8'));
    assert.equal(holder.protocol, MODEL_DAEMON_PROTOCOL);
    assert.equal(holder.pid, w1.child.pid, 'the lock must be owned by the winner (worker 1)');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
