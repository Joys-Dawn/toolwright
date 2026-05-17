// Coverage for lib/auto-setup.js — the dependency-free background installer,
// after the collapse from a heartbeat/pid-liveness/rename-steal lock state
// machine + a persisted bounded-backoff/escalation counter + a busy-wait sync
// sleep + a 10-minute wait-loop down to: a minimal fixed-window single-flight
// lock, a shared install-dir preparer, a fire-and-forget detached worker, and
// a synchronous user-invoked install.
//
// Hard constraint for this suite: it must NEVER spawn a real `npm install`
// (that would mutate the persistent node_modules, hit the network, take
// minutes). UNCONDITIONAL — it holds even on a deps-absent tree (a designed
// scenario: auto-setup.js IS the deps-absent machinery). Enforced by injected
// seams, never by ambient host node_modules:
//   - maybeAutoInstall() is called with depsCheck:()=>true (deps-present
//     guard) or a tripwire spawnWorker, so no detached child is ever launched;
//   - the npmAvailable() guard is exercised with npm forced off PATH so
//     runInstallSync() returns the structured error BEFORE the lock or spawn;
//   - the single-flight 'held' path plants a fresh lock at the exported
//     installLockPath() and asserts runInstallSync() yields (returns the
//     `pending` result) WITHOUT spawning — proving no second install races the
//     same dir; the 'acquired' path stubs spawnInstall/probe/writeHealthMarker.
//
// Isolation: the lock/log path is a MACHINE-GLOBAL singleton
// (tmpdir()/mindwright-install-<dataDirSlug>.{lock,log}). Every test runs
// inside a per-test mkdtemp sandbox via the MINDWRIGHT_INSTALL_LOCK_DIR seam,
// restored + removed afterEach, so the suite never reads or mutates the real
// install lock regardless of host state. The prepareInstallDir() tests
// additionally drive CLAUDE_PLUGIN_DATA at a per-test temp dir (restored in a
// local finally) to exercise the real persistent-dir copy + the dev-tree
// source!==dest self-copy guard.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  existsSync,
  writeFileSync,
  unlinkSync,
  mkdtempSync,
  rmSync,
  readFileSync,
  utimesSync,
} from 'node:fs';
import {
  installLogPath,
  installLockPath,
  npmAvailable,
  NPM_INSTALL_ARGS,
  prepareInstallDir,
  maybeAutoInstall,
  runInstallSync,
  acquireLock,
} from '../lib/auto-setup.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(__dirname, '..');

const ENV_KEY = 'MINDWRIGHT_INSTALL_LOCK_DIR';
let sandboxDir;
let prevEnv;

beforeEach(() => {
  prevEnv = process.env[ENV_KEY];
  sandboxDir = mkdtempSync(join(tmpdir(), 'mw-autosetup-'));
  process.env[ENV_KEY] = sandboxDir;
});

afterEach(() => {
  if (prevEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = prevEnv;
  try {
    rmSync(sandboxDir, { recursive: true, force: true });
  } catch {
    /* already gone */
  }
});

// --- path helpers -------------------------------------------------------

test('installLockPath/installLogPath honor MINDWRIGHT_INSTALL_LOCK_DIR and default to tmpdir()', () => {
  assert.ok(installLockPath().startsWith(sandboxDir), `${installLockPath()} not under ${sandboxDir}`);
  assert.ok(installLogPath().startsWith(sandboxDir), `${installLogPath()} not under ${sandboxDir}`);

  delete process.env[ENV_KEY];
  assert.ok(installLockPath().startsWith(tmpdir()), `${installLockPath()} not under ${tmpdir()}`);
  assert.ok(installLogPath().startsWith(tmpdir()), `${installLogPath()} not under ${tmpdir()}`);
});

test('installLogPath is a deterministic .log under the configured artifact dir', () => {
  const a = installLogPath();
  assert.equal(a, installLogPath()); // stable across calls (keyed by data dir, not time)
  assert.ok(a.startsWith(sandboxDir), `expected ${a} under ${sandboxDir}`);
  assert.match(a, /mindwright-install-.*\.log$/);
});

test('installLockPath is a deterministic .lock under the configured artifact dir', () => {
  const a = installLockPath();
  assert.equal(a, installLockPath());
  assert.ok(a.startsWith(sandboxDir), `expected ${a} under ${sandboxDir}`);
  assert.match(a, /mindwright-install-.*\.lock$/);
});

test('npmAvailable returns true — the suite itself runs under npm', () => {
  assert.equal(npmAvailable(), true);
});

test('NPM_INSTALL_ARGS is the shared runtime-only quiet install flag set', () => {
  // One source of truth shared by the detached worker and the sync setup path.
  assert.deepEqual(NPM_INSTALL_ARGS, ['install', '--omit=dev', '--no-audit', '--no-fund']);
});

// --- prepareInstallDir() -----------------------------------------------
// Puts the bundled manifest in the PERSISTENT data dir so `npm install` (cwd =
// pluginDataDir()) finds it, and that copy is also what ready.js#
// manifestUpToDate() diffs. The source!==dest guard is essential: in the dev
// tree / test suite CLAUDE_PLUGIN_DATA is unset ⇒ pluginDataDir() ===
// PLUGIN_ROOT ⇒ bundled and installed paths are the SAME file, and
// copyFileSync(p, p) truncates it. These pin both the real copy and the guard.

test('prepareInstallDir creates the persistent data dir and copies the bundled manifest into it', () => {
  const prevData = process.env.CLAUDE_PLUGIN_DATA;
  const dataDir = mkdtempSync(join(tmpdir(), 'mw-datadir-'));
  // A non-existent nested target proves the recursive mkdir, not just a copy.
  const target = join(dataDir, 'nested', 'plugin-data');
  process.env.CLAUDE_PLUGIN_DATA = target;
  try {
    assert.equal(existsSync(target), false, 'precondition: the data dir does not exist yet');

    prepareInstallDir();

    assert.equal(existsSync(target), true, 'prepareInstallDir must recursively create the persistent data dir');
    const copiedPkg = join(target, 'package.json');
    assert.equal(existsSync(copiedPkg), true, 'the bundled package.json must be copied into the data dir');
    assert.equal(
      readFileSync(copiedPkg, 'utf8'),
      readFileSync(join(PLUGIN_ROOT, 'package.json'), 'utf8'),
      'the copied manifest must be byte-identical to the bundled one (manifestUpToDate compares it)',
    );
    // The bundled lockfile exists in this repo; it must be copied too for a
    // reproducible install.
    const bundledLock = join(PLUGIN_ROOT, 'package-lock.json');
    if (existsSync(bundledLock)) {
      assert.equal(
        readFileSync(join(target, 'package-lock.json'), 'utf8'),
        readFileSync(bundledLock, 'utf8'),
        'the bundled lockfile must be copied for a reproducible install',
      );
    }
  } finally {
    if (prevData === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = prevData;
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* tmp */
    }
  }
});

test('prepareInstallDir is a safe no-op when bundled and installed paths are identical (dev-tree self-copy guard)', () => {
  // The data-loss hazard: with CLAUDE_PLUGIN_DATA unset pluginDataDir() ===
  // PLUGIN_ROOT, so bundledManifestPath() === installedManifestPath(). An
  // unguarded copyFileSync(p, p) opens the destination with O_TRUNC before
  // reading the source — it would zero the real package.json. The per-file
  // source!==dest guard must make this a no-op; assert the real manifest is
  // byte-unchanged across the call.
  const prevData = process.env.CLAUDE_PLUGIN_DATA;
  delete process.env.CLAUDE_PLUGIN_DATA; // pluginDataDir() === PLUGIN_ROOT
  const pkgPath = join(PLUGIN_ROOT, 'package.json');
  const before = readFileSync(pkgPath, 'utf8');
  try {
    assert.doesNotThrow(() => prepareInstallDir());
    assert.equal(
      readFileSync(pkgPath, 'utf8'),
      before,
      'the dev-tree self-copy guard must leave the real package.json byte-identical',
    );
  } finally {
    if (prevData === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = prevData;
  }
});

// --- maybeAutoInstall() -------------------------------------------------

test('maybeAutoInstall opts out cleanly when MINDWRIGHT_AUTO_INSTALL=false', () => {
  const prev = process.env.MINDWRIGHT_AUTO_INSTALL;
  process.env.MINDWRIGHT_AUTO_INSTALL = 'false';
  try {
    // The opt-out is the very first statement, before any fs/spawn — must
    // return undefined, never throw, and never take the single-flight lock.
    assert.equal(maybeAutoInstall(), undefined);
    assert.equal(existsSync(installLockPath()), false, 'the opt-out must not take the lock');
  } finally {
    if (prev === undefined) delete process.env.MINDWRIGHT_AUTO_INSTALL;
    else process.env.MINDWRIGHT_AUTO_INSTALL = prev;
  }
});

test('maybeAutoInstall is a no-op when deps are already installed (idempotent, never spawns/locks)', () => {
  // depsCheck:()=>true makes the "deps present → return at the second guard,
  // never reach acquireLock()/spawn" path deterministic, not contingent on the
  // host having node_modules. Twice proves idempotency.
  const seam = { depsCheck: () => true, spawnWorker: () => assert.fail('deps present: must not spawn') };
  assert.equal(maybeAutoInstall(seam), undefined);
  assert.equal(maybeAutoInstall(seam), undefined);
  assert.equal(existsSync(installLockPath()), false, 'a deps-present no-op must never take the lock');
});

test('maybeAutoInstall takes the single-flight lock, spawns the worker, and unrefs it (deps absent)', () => {
  // depsCheck:()=>false → deps genuinely absent so the deps-present guard does
  // not short-circuit; no pre-existing lock so the spawn path runs once. The
  // injected worker stands in for the detached child (this suite never spawns
  // a real installer). No pid handoff post-collapse — acquireLock no longer
  // does pid-liveness, so the plain fresh lock is the entire handoff.
  let unrefCalled = false;
  let spawnCalls = 0;
  const worker = {
    pid: 424242,
    unref() {
      unrefCalled = true;
    },
  };

  maybeAutoInstall({
    depsCheck: () => false,
    spawnWorker: () => {
      spawnCalls += 1;
      return worker;
    },
  });

  assert.equal(spawnCalls, 1, 'the exclusive winner spawns the detached worker exactly once');
  assert.equal(existsSync(installLockPath()), true, 'the exclusive winner takes the single-flight lock');
  assert.equal(unrefCalled, true, 'the child must be unref-ed so the install outlives the hook');
});

test('maybeAutoInstall does NOT spawn a second worker when a fresh lock is already held (single-flight)', () => {
  // The corruption this lock exists to prevent: two concurrent sessions both
  // spawning `npm install` into one node_modules. A fresh lock (just written,
  // mtime < the max-age window) ⇒ acquireLock 'held' ⇒ maybeAutoInstall must
  // return WITHOUT spawning. spawnWorker is a tripwire.
  writeFileSync(
    installLockPath(),
    JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
    { flag: 'wx' },
  );

  maybeAutoInstall({
    depsCheck: () => false,
    spawnWorker: () => assert.fail('a held single-flight lock must prevent a second spawn'),
  });
});

// --- acquireLock(): the minimal single-flight primitive -----------------
// Three outcomes — 'acquired', 'held', 'uncreatable' — plus the atomic
// stale-steal reclaim. The heartbeat/pid-liveness/grace/backoff machine that
// used to wrap this was deliberately removed; staleness is now a single mtime
// vs one fixed window. Exercised spawn-free inside the per-test sandbox.

test('acquireLock returns acquired and creates the lock when none exists', () => {
  const lock = installLockPath();
  assert.equal(existsSync(lock), false);

  assert.equal(acquireLock(), 'acquired');
  assert.equal(existsSync(lock), true);
});

test('acquireLock returns held and leaves a fresh lock byte-identical (never double-spawns)', () => {
  // A just-written lock is fresh (mtime < the max-age window) ⇒ 'held', and
  // the held path must never rewrite the lock (a concurrent session must not
  // disturb the in-flight install's lock).
  const lock = installLockPath();
  const fresh = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() });
  writeFileSync(lock, fresh, { flag: 'wx' });

  assert.equal(acquireLock(), 'held');
  assert.equal(readFileSync(lock, 'utf8'), fresh);
});

test('acquireLock steals a stale lock (older than the max-age window) and re-creates a fresh one', () => {
  const lock = installLockPath();
  const stale = JSON.stringify({ pid: 999, startedAt: '2000-01-01T00:00:00.000Z' });
  writeFileSync(lock, stale, { flag: 'wx' });
  // Backdate a full day — unambiguously past the max-age window without
  // coupling the test to the exact constant value.
  const longAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  utimesSync(lock, longAgo, longAgo);

  assert.equal(acquireLock(), 'acquired');
  assert.equal(existsSync(lock), true);
  assert.notEqual(readFileSync(lock, 'utf8'), stale); // replaced with this caller's payload
});

test('acquireLock returns uncreatable when the lock cannot be created for a non-EEXIST reason', () => {
  // Point the artifact dir at a regular FILE so join(file, '<slug>.lock')
  // makes writeFileSync fail with ENOTDIR (not EEXIST) → the uncreatable
  // branch — deterministic and cross-platform (no chmod, unreliable on
  // Windows). afterEach restores the env and rms the sandbox.
  const notADir = join(sandboxDir, 'i-am-a-file');
  writeFileSync(notADir, 'x');
  process.env[ENV_KEY] = notADir;

  assert.equal(acquireLock(), 'uncreatable');
});

test('acquireLock yields exactly one winner against a single stale lock (single-flight invariant)', () => {
  // acquireLock is synchronous, so true concurrency is impossible in-process
  // and renameSync atomicity is an OS guarantee — not something a unit test
  // should re-prove. The deterministic single-process proxy for "exactly one
  // winner": against ONE stale lock the first call steals and re-creates a
  // FRESH lock, so the second call now sees a fresh lock → 'held'. One
  // 'acquired', one 'held' — never two 'acquired'.
  const lock = installLockPath();
  writeFileSync(lock, JSON.stringify({ pid: 999, stale: true }), { flag: 'wx' });
  const longAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  utimesSync(lock, longAgo, longAgo);

  assert.equal(acquireLock(), 'acquired');
  assert.equal(acquireLock(), 'held');
});

// --- runInstallSync(): npm-gate / single-flight / install+probe+marker --

test('runInstallSync returns a structured npm-not-found error WITHOUT spawning when npm is off PATH', async () => {
  const prevPath = process.env.PATH;
  // Emptying PATH makes the `npm --version` probe fail, so npmAvailable() is
  // false and runInstallSync() must short-circuit BEFORE the `npm install`
  // spawn — proving no real install can run here.
  process.env.PATH = '';
  try {
    const r = await runInstallSync();
    assert.equal(r.ok, false);
    assert.equal(r.code, null);
    assert.match(r.error, /npm not found on PATH/);
  } finally {
    if (prevPath === undefined) delete process.env.PATH;
    else process.env.PATH = prevPath;
  }
});

test('runInstallSync yields a `pending` result (never a competing install) when a background install holds the lock', async () => {
  // The documented quick-start race: plugin install → SessionStart fires the
  // detached maybeAutoInstall() (holds the lock) → user runs /mindwright:setup
  // while it is still going. A FRESH lock in the per-test sandbox simulates the
  // in-flight install. deps not yet present (depsCheck:()=>false) ⇒
  // runInstallSync must return the distinct `pending` result and NOT spawn a
  // second `npm install` into the same dir (the 10-min busy-wait poll was
  // deliberately removed). spawnInstall is a tripwire.
  const lock = installLockPath();
  writeFileSync(
    lock,
    JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
    { flag: 'wx' },
  );

  const r = await runInstallSync({
    depsCheck: () => false,
    spawnInstall: () => assert.fail('a held lock must not spawn a competing install'),
  });

  assert.equal(r.ok, false);
  assert.equal(r.pending, true, 'the held-lock case is in-progress, NOT a failure (setup.js relies on this)');
  assert.match(r.error, /already running/);
  assert.ok(r.error.includes(installLogPath()), 'the pending message points the user at the install log');
  assert.equal(existsSync(lock), true, 'runInstallSync only unlinks a lock IT acquired; the foreign lock is untouched');
  try {
    unlinkSync(lock);
  } catch {
    /* afterEach also rms the sandbox */
  }
});

test('runInstallSync held lock but deps already present → ok without installing', async () => {
  // The background install holding the lock may have JUST finished — a single
  // depsCheck() before declining returns ok rather than a spurious pending.
  const lock = installLockPath();
  writeFileSync(
    lock,
    JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
    { flag: 'wx' },
  );

  const r = await runInstallSync({
    depsCheck: () => true,
    spawnInstall: () => assert.fail('deps already present: must not install'),
  });

  assert.deepEqual(r, { ok: true, code: 0 });
  assert.equal(existsSync(lock), true, 'it yielded — never acquired — so the foreign lock is untouched');
  try {
    unlinkSync(lock);
  } catch {
    /* afterEach also rms the sandbox */
  }
});

test('runInstallSync acquires, installs, probes, writes the marker, and the finally unlinks the lock', async () => {
  // No lock present → the real acquireLock() inside runInstallSync returns
  // 'acquired' and CREATES the lock. spawnInstall (stubbed — no real npm)
  // asserts the lock is held DURING the install; a passing probe writes the
  // marker; the finally must then remove the owned lock. probe/writeHealthMarker
  // are stubbed because this is the ONLY runInstallSync test that reaches a
  // SUCCESSFUL spawnInstall: un-seamed, the real loadProbe would dynamic-import
  // the dev tree's real better-sqlite3 and the real writeMarker would write
  // node_modules/.mindwright-health.json — the real-tree-marker hazard that
  // races the parallel test workers.
  const lock = installLockPath();
  assert.equal(existsSync(lock), false, 'precondition: no lock');
  let probed = 0;
  let marked = 0;

  const r = await runInstallSync({
    spawnInstall: () => {
      assert.equal(existsSync(lock), true, 'lock must be held while the install runs');
      return { ok: true, code: 0 };
    },
    probe: async () => {
      probed += 1;
      return { ok: true };
    },
    writeHealthMarker: () => {
      marked += 1;
      return true;
    },
  });

  assert.deepEqual(r, { ok: true, code: 0 });
  assert.equal(existsSync(lock), false, 'finally must unlink the lock this call acquired');
  assert.deepEqual([probed, marked], [1, 1], 'a successful install probes then writes the ABI marker');
});

test('runInstallSync: npm succeeds but the load-probe fails → no marker, npm result still returned', async () => {
  // npm "succeeded" yet the native binding will not load (wrong platform/ABI):
  // the probe fails ⇒ NO marker (so depsInstalled() stays false and setup.js's
  // post-install guard surfaces the "reported success but not resolvable"
  // message), and the npm {ok} result is STILL returned verbatim —
  // runInstallSync reports what npm did; the marker write is a best-effort
  // add-on.
  const r = await runInstallSync({
    spawnInstall: () => ({ ok: true, code: 0 }),
    probe: async () => ({ ok: false, error: 'NODE_MODULE_VERSION mismatch (stub)' }),
    writeHealthMarker: () => assert.fail('a failing probe must NOT write the health marker'),
  });

  assert.deepEqual(r, { ok: true, code: 0 }, 'runInstallSync still reports the npm result verbatim');
  assert.equal(existsSync(installLockPath()), false, 'the owned lock is still unlinked in the finally');
});
