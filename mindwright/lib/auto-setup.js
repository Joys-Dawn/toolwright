// Dependency-free background dependency installer.
//
// The marketplace plugin copy ships WITHOUT node_modules. The deps are
// installed ONCE into the PERSISTENT plugin data dir
// (${CLAUDE_PLUGIN_DATA}/node_modules — lib/paths.js#nodeModulesDir), which
// survives plugin updates, so unlike the old ephemeral-PLUGIN_ROOT install
// they are NOT wiped every update and re-install is needed only on a genuine
// dependency-set change (manifest diff) or a Node-ABI bump (the health
// marker). When a gated entrypoint sees deps missing it fires this: a
// single-flight, DETACHED `npm install` into the data dir. The session stays
// dormant; the plugin is live again the next session. Zero user action.
//
// This module was deliberately collapsed from a heartbeat/pid-liveness/
// rename-steal lock state machine + a persisted bounded-backoff/escalation
// counter + a busy-wait sync sleep + a 10-minute wait-loop down to: a minimal
// fixed-window single-flight lock, a shared install-dir preparer, a
// fire-and-forget detached worker, and a synchronous user-invoked install.
// The persistent data dir removed the original churn (install once, persists)
// that the backoff machinery existed to bound; the simpler lock is the
// approved tradeoff (see the INSTALL_LOCK_MAX_AGE_MS note for its one limit).
//
// HARD RULE (same as lib/ready.js): `node:` builtins + lib/paths.js +
// lib/ready.js + lib/health-marker.js only — all four are dep-free. No import
// here may transitively pull a native dep: this code runs precisely when the
// native deps are ABSENT.

import { spawn, spawnSync } from 'node:child_process';
import {
  writeFileSync,
  statSync,
  unlinkSync,
  renameSync,
  mkdirSync,
  copyFileSync,
  existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  PLUGIN_ROOT,
  pluginDataDir,
  bundledManifestPath,
  installedManifestPath,
} from './paths.js';
import { depsInstalled } from './ready.js';
import { loadProbe, probeAndMarkIfOk, writeMarker } from './health-marker.js';

// A genuinely-slow native install (better-sqlite3 compiling from source on a
// machine with no prebuilt binary) can take minutes. The lock is mtime-based
// single-flight: while it is fresher than this window a second entrypoint will
// NOT launch a competing `npm install` (concurrent installs in one dir corrupt
// node_modules). Past the window the lock is treated as abandoned (a crashed
// or killed install) and a later session atomically reclaims it. No explicit
// cleanup is required for correctness: a SUCCESSFUL install makes
// depsInstalled() true, so callers short-circuit before the lock is consulted
// again; the worker also removes the lock on every exit as a tidy-up.
//
// COLLAPSE TRADEOFF: with the heartbeat removed the lock's mtime is its
// CREATION time, not a refreshed liveness beat — so the window must cover the
// whole worst-case install. The realistic case is a PREBUILT better-sqlite3
// (install is seconds); a from-source compile racing a second concurrent
// session past a 15-minute window is the one accepted residual risk of the
// approved simplification, far rarer than the every-update churn the old
// machinery added to bound it. node_modules now persisting (install once)
// makes that churn — and the backoff counter that bounded it — unnecessary.
const INSTALL_LOCK_MAX_AGE_MS = 15 * 60 * 1000;

// Coordinate across EVERY project that shares this one plugin install: the
// lock / log live in the OS temp dir keyed by the install TARGET (the
// persistent data dir), not under any single project's .claude/mindwright/.
// Two projects opening sessions at once must not both spawn `npm install`
// into the same node_modules.
function installTargetSlug() {
  return pluginDataDir().replace(/[^a-zA-Z0-9]/g, '-');
}

// Base dir for the lock/log. Defaults to the OS temp dir.
// MINDWRIGHT_INSTALL_LOCK_DIR overrides it — two real uses: (1) an ops escape
// hatch when the default tmpdir is unwritable (locked-down/CI host), symmetric
// with acquireLock's 'uncreatable' handling; (2) test isolation — these paths
// are a machine-global singleton, so a suite MUST be able to point them at a
// per-test sandbox dir or it pollutes / asserts against the real install lock.
// A missing/unwritable dir is NOT created here: writeFileSync(wx)/openSync
// degrade through the existing best-effort + 'uncreatable' paths as designed.
function installArtifactDir() {
  return process.env.MINDWRIGHT_INSTALL_LOCK_DIR || tmpdir();
}

// Exported (symmetric with installLogPath) so the single-flight path is
// deterministically testable — a test can plant a fresh/stale lock to assert
// the held/abandoned branches without spawning a real `npm install`.
export function installLockPath() {
  return join(installArtifactDir(), `mindwright-install-${installTargetSlug()}.lock`);
}

// Exported so /mindwright:status can point the user at the install transcript
// when the background install failed (npm error, no network, no compiler).
export function installLogPath() {
  return join(installArtifactDir(), `mindwright-install-${installTargetSlug()}.log`);
}

// Quick dep-free probe: is `npm` resolvable on PATH? Used by the user-facing
// setup/status paths to print an actionable message ("install Node.js/npm")
// instead of a silent perpetual-dormancy. maybeAutoInstall itself does NOT
// gate on this — it just attempts the spawn and lets the log capture any
// failure (the probe is best-effort and adds latency to the hot path).
export function npmAvailable() {
  try {
    const r = spawnSync('npm', ['--version'], {
      stdio: 'ignore',
      shell: true,
      windowsHide: true,
      timeout: 10_000,
    });
    return r.status === 0;
  } catch {
    return false;
  }
}

// npm args shared by the detached worker and the synchronous setup path.
// --omit=dev: defensive — the plugin declares no devDependencies (tests run on
// the built-in `node --test`), a no-op today but keeps an unattended install
// runtime-only if any are ever added. --no-audit/--no-fund: quiet + faster for
// an unattended install. Exported so scripts/install-worker.js installs with
// the EXACT same flags — one source of truth, no drift across install paths.
export const NPM_INSTALL_ARGS = ['install', '--omit=dev', '--no-audit', '--no-fund'];

// Prepare the PERSISTENT install dir so `npm install` (run with cwd =
// pluginDataDir()) has the manifest it needs there: ensure the dir exists and
// copy the bundled package.json (the source of truth for what SHOULD be
// installed, shipped read-only in the ephemeral PLUGIN_ROOT) into it, plus the
// bundled lockfile when present so the install is reproducible. The copied
// package.json is ALSO what lib/ready.js#manifestUpToDate() compares against —
// copying it before the install means a half-finished/killed install leaves
// the gate false (no health marker) while a completed one flips it true, and a
// plugin update that changed deps is detected because the bundled copy now
// differs from the last successfully-installed one.
//
// The per-file source!==dest guard is essential: in the dev tree and the whole
// test suite CLAUDE_PLUGIN_DATA is unset ⇒ pluginDataDir() === PLUGIN_ROOT ⇒
// bundled and installed paths are the SAME file, and copyFileSync(p, p) opens
// the destination with O_TRUNC before reading the source — it would zero the
// real package.json. Guarded, prepareInstallDir() is a safe near-no-op there
// (mkdir of an existing dir with recursive:true). Dep-free; never throws on a
// benign already-exists. Shared single source so the detached worker and the
// synchronous setup path prepare the dir identically.
export function prepareInstallDir() {
  const dataDir = pluginDataDir();
  mkdirSync(dataDir, { recursive: true });
  const bundledPkg = bundledManifestPath();
  const installedPkg = installedManifestPath();
  if (bundledPkg !== installedPkg) copyFileSync(bundledPkg, installedPkg);
  const bundledLock = join(PLUGIN_ROOT, 'package-lock.json');
  const installedLock = join(dataDir, 'package-lock.json');
  if (bundledLock !== installedLock && existsSync(bundledLock)) {
    copyFileSync(bundledLock, installedLock);
  }
}

// Acquire the single-flight lock. Returns one of three states:
//   'acquired'    — THIS caller created the lock and may run/spawn the install.
//   'held'        — a FRESH lock exists: another install is genuinely in
//                    flight; the caller must NOT double-spawn.
//   'uncreatable' — the lock could not be created for a reason OTHER than an
//                    existing lock (unwritable tmp, EPERM, a read-only /
//                    locked-down / CI filesystem). No competing install can
//                    exist here — the detached maybeAutoInstall self-suppresses
//                    in this same environment — so the user-invoked sync path
//                    may proceed straight to install instead of falsely
//                    treating a phantom lock as in-flight.
//
// `wx` is an atomic exclusive-create on a local filesystem, so concurrent
// entrypoints racing the common path resolve to exactly one winner. A lock
// older than INSTALL_LOCK_MAX_AGE_MS is abandoned (its install crashed or was
// killed before the worker's finally could remove it); it is reclaimed by an
// atomic rename to a unique name — of N concurrent stealers exactly one
// rename of the stale path succeeds, the rest get ENOENT and back off, so the
// reclaim cannot let two `npm install` into one dir (the corruption the lock
// exists to prevent). This is the irreducible correctness core of the lock;
// the heartbeat/pid-liveness/grace/backoff machine that used to wrap it was
// deliberately removed (see the module header).
export function acquireLock() {
  const lock = installLockPath();
  const payload = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() });
  try {
    writeFileSync(lock, payload, { flag: 'wx' });
    return 'acquired';
  } catch (e) {
    // Non-EEXIST → the lock could not be created AT ALL (unwritable tmp,
    // EPERM, locked-down/CI fs). This is NOT "an install is running".
    if (!e || e.code !== 'EEXIST') return 'uncreatable';
  }
  let st;
  try {
    st = statSync(lock);
  } catch {
    return 'held'; // vanished/!stat-able under us — treat as in-flight; another pass retries
  }
  if (Date.now() - st.mtimeMs < INSTALL_LOCK_MAX_AGE_MS) {
    return 'held'; // a fresh install is genuinely in flight
  }
  // Abandoned (older than the window ⇒ its install crashed/was killed). Steal
  // it ATOMICALLY: unlink-then-create is a check-then-act race (two callers
  // that both saw the same stale lock can each delete the other's freshly
  // created one and both spawn `npm install`). renameSync to a unique name is
  // atomic — exactly one concurrent stealer wins; the losers get ENOENT.
  const stolen = `${lock}.${process.pid}.${Date.now()}.stale`;
  try {
    renameSync(lock, stolen);
  } catch {
    return 'held'; // lost the steal race — another caller owns it now
  }
  try {
    unlinkSync(stolen);
  } catch {
    /* best-effort: the stolen marker is inert if it lingers */
  }
  try {
    writeFileSync(lock, payload, { flag: 'wx' });
    return 'acquired';
  } catch {
    return 'held'; // a fresh caller won the normal path in the gap — defer to it
  }
}

// Spawn the detached installer (scripts/install-worker.js), exactly the
// scripts/seed-loop.js posture (process.execPath + a dep-free script +
// detached + unref). The worker — not this millisecond-lived hook process —
// runs `npm install`, probes, writes the ABI marker, and removes the lock on
// exit, so stdio is 'ignore' here (the worker owns the install log). The
// script itself is a bundled, read-only plugin file ⇒ located via PLUGIN_ROOT;
// it installs into the persistent data dir via prepareInstallDir().
function defaultSpawnWorker() {
  return spawn(process.execPath, [join(PLUGIN_ROOT, 'scripts', 'install-worker.js')], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env },
  });
}

// Fire-and-forget the detached background install. Idempotent and
// single-flight. Never throws and never blocks — auto-install must never
// disrupt the SessionStart/hook turn that triggered it.
//
// MINDWRIGHT_AUTO_INSTALL=false opts out (the escape hatch for an air-gapped
// or vendored environment that manages node_modules out-of-band).
//
// `depsCheck`/`spawnWorker` are test seams (defaults = the real impls →
// production unchanged). depsCheck proves the "deps already installed → no-op,
// never spawns/locks" guarantee; spawnWorker lets the detached spawn be
// exercised WITHOUT launching a real subprocess. No pid is handed to the
// worker: acquireLock no longer does pid-liveness, so a plain fresh lock
// (created here, removed by the worker's finally, aged out if the worker is
// killed) is the entire handoff.
export function maybeAutoInstall({ depsCheck = depsInstalled, spawnWorker = defaultSpawnWorker } = {}) {
  try {
    if (process.env.MINDWRIGHT_AUTO_INSTALL === 'false') return;
    if (depsCheck()) return;
    // Only the exclusive winner spawns. 'held' (another install in flight) and
    // 'uncreatable' (no writable tmp for the lock) both mean "do not spawn a
    // detached install here" — the latter because an unattended background
    // install with nowhere to lock would race itself across sessions.
    if (acquireLock() !== 'acquired') return;
    const child = spawnWorker();
    // Detach from the hook's lifetime: the install must outlive the
    // millisecond-lived hook process.
    try {
      if (child && typeof child.unref === 'function') child.unref();
    } catch {
      /* */
    }
  } catch {
    // Best-effort: any failure here is invisible to the user by design.
    // depsInstalled() stays false → status/setup still report not-ready and
    // a later session retries once the lock ages out.
  }
}

// The real blocking `npm install` for the user-invoked /mindwright:setup path,
// cwd = the PERSISTENT data dir (prepareInstallDir() put the manifest there).
// Extracted so runInstallSync's seam can substitute a stub (no network, no
// minutes-long compile). Owns ONLY the spawn + its error→result mapping; the
// lock lifecycle stays in the caller.
function defaultSpawnInstall() {
  try {
    const r = spawnSync('npm', NPM_INSTALL_ARGS, {
      cwd: pluginDataDir(),
      stdio: 'inherit',
      shell: true,
      windowsHide: true,
    });
    if (r.status === 0) return { ok: true, code: 0 };
    return { ok: false, code: r.status, error: `npm install exited with code ${r.status}` };
  } catch (e) {
    return { ok: false, code: null, error: e && e.message ? e.message : String(e) };
  }
}

// Blocking install for the user-invoked /mindwright:setup path: the user
// explicitly asked to "make it work" and expects setup to take a while (the
// model download alone is minutes), so blocking is the right UX here — unlike
// the hooks, which must never block. Returns a structured result instead of
// throwing so the caller can print a clean message.
//
// Single-flight: a SessionStart-triggered maybeAutoInstall() may already be
// running a DETACHED `npm install` into the same node_modules. Two concurrent
// installs in one dir corrupt it (the whole reason acquireLock guards the
// detached path), and the documented quick-start — install plugin → background
// install starts → user runs /mindwright:setup while it is still going — hits
// exactly that race. So this path participates in the SAME lock: if a fresh
// background install holds it, this returns a distinct `pending` result (the
// 10-minute busy-wait poll was deliberately removed) so scripts/setup.js can
// tell the user it is in progress and to re-run shortly — NEVER a competing
// install. depsCheck() is re-checked first in case it just landed.
//
// async because a genuine install must, on success, run the same load-probe
// the detached worker does and write the ABI marker depsInstalled() requires
// (loadProbe is irreducibly async — a dynamic native import). Options are test
// seams (defaults = real impls → production unchanged): they keep the
// on-success marker write hermetic (no real binding, no real-tree marker
// write) and let the npm spawn be stubbed.
export async function runInstallSync({
  depsCheck = depsInstalled,
  spawnInstall = defaultSpawnInstall,
  probe = loadProbe,
  writeHealthMarker = writeMarker,
} = {}) {
  if (!npmAvailable()) {
    return {
      ok: false,
      code: null,
      error: 'npm not found on PATH — install Node.js (npm ships with it), then re-run /mindwright:setup.',
    };
  }

  const lockState = acquireLock();

  if (lockState === 'held') {
    // A background install genuinely holds a FRESH lock. It may have just
    // finished — check once before declining.
    if (depsCheck()) return { ok: true, code: 0 };
    return {
      ok: false,
      code: null,
      pending: true,
      error:
        'a background dependency install is already running — wait a minute, then re-run '
        + `/mindwright:setup (progress log: ${installLogPath()}).`,
    };
  }
  // 'acquired' (we exclusively hold the lock) or 'uncreatable' (tmp unwritable
  // so no lock could be taken — but the detached maybeAutoInstall
  // self-suppresses in this same environment, so there is NO competing install
  // and a direct synchronous install is both safe and the only way setup can
  // succeed on a locked-down/CI host). Running the install now is correct in
  // both cases; for 'uncreatable' there is simply no lock for the finally to
  // remove.
  try {
    prepareInstallDir();
    const r = spawnInstall();
    if (r && r.ok) {
      // npm succeeded — stamp the ABI capability token depsInstalled()
      // requires so /mindwright:setup actually flips the gate, via the SAME
      // never-throw tail the detached worker uses (health-marker.js#
      // probeAndMarkIfOk) so the two install paths cannot drift apart again
      // (that drift caused the implementation-2/correctness-1 silent-dormancy
      // bug). A FAILING probe leaves NO marker on purpose: npm "succeeded"
      // but the binding will not load (wrong platform/ABI); the {ok} npm
      // result is still returned and setup.js's post-install depsCheck()
      // guard then surfaces the clear "reported success but not resolvable"
      // message. No result is passed so the tail runs the probe itself, and
      // it swallows any throw — runInstallSync's never-throw contract holds.
      await probeAndMarkIfOk(undefined, { probe, writeHealthMarker });
    }
    return r;
  } finally {
    if (lockState === 'acquired') {
      try {
        unlinkSync(installLockPath());
      } catch {
        /* best-effort */
      }
    }
  }
}
