// Dependency-free background dependency installer.
//
// HARD RULE: this module's import graph must stay dep-free (`node:` builtins +
// paths.js + ready.js + health-marker.js only) — it runs precisely when the
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

// Single-flight window. Concurrent installs in one dir corrupt node_modules.
// The lock's mtime is its CREATION time (no heartbeat), so the window must
// cover the whole worst-case install (a from-source better-sqlite3 compile can
// take minutes); past it the lock is treated as abandoned and reclaimed.
const INSTALL_LOCK_MAX_AGE_MS = 15 * 60 * 1000;

// Lock/log keyed by the install TARGET so two projects sharing one plugin
// install cannot both spawn `npm install` into the same node_modules.
function installTargetSlug() {
  return pluginDataDir().replace(/[^a-zA-Z0-9]/g, '-');
}

// MINDWRIGHT_INSTALL_LOCK_DIR overrides the OS temp dir — escape hatch when
// tmpdir is unwritable, and test isolation (these paths are machine-global).
function installArtifactDir() {
  return process.env.MINDWRIGHT_INSTALL_LOCK_DIR || tmpdir();
}

export function installLockPath() {
  return join(installArtifactDir(), `mindwright-install-${installTargetSlug()}.lock`);
}

export function installLogPath() {
  return join(installArtifactDir(), `mindwright-install-${installTargetSlug()}.log`);
}

// Is `npm` resolvable on PATH? Used by user-facing setup/status to print an
// actionable message; maybeAutoInstall does NOT gate on this (hot-path latency).
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

// Single source of truth for npm args so the install paths cannot drift.
export const NPM_INSTALL_ARGS = ['install', '--omit=dev', '--no-audit', '--no-fund'];

// Copy the bundled package.json (also what ready.js#manifestUpToDate compares
// against) + lockfile into the persistent install dir.
//
// The per-file source!==dest guard is essential: when CLAUDE_PLUGIN_DATA is
// unset (dev tree / test suite) pluginDataDir() === PLUGIN_ROOT, so bundled and
// installed paths are the SAME file, and copyFileSync(p, p) opens the dest with
// O_TRUNC before reading the source — it would zero the real package.json.
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
//   'uncreatable' — lock uncreatable for a reason OTHER than an existing lock
//                    (unwritable filesystem). No competing install can exist
//                    here (the detached maybeAutoInstall self-suppresses in
//                    this same environment), so the sync path may proceed.
//
// `wx` is an atomic exclusive-create → exactly one winner under concurrency. A
// stale lock is reclaimed by an atomic rename to a unique name (exactly one
// stealer wins, losers get ENOENT) so the reclaim cannot let two `npm install`
// into one dir.
export function acquireLock() {
  const lock = installLockPath();
  const payload = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() });
  try {
    writeFileSync(lock, payload, { flag: 'wx' });
    return 'acquired';
  } catch (e) {
    // Non-EEXIST → the lock could not be created at all, not "an install is
    // running".
    if (!e || e.code !== 'EEXIST') return 'uncreatable';
  }
  let st;
  try {
    st = statSync(lock);
  } catch {
    return 'held'; // not stat-able under us — treat as in-flight; another pass retries
  }
  if (Date.now() - st.mtimeMs < INSTALL_LOCK_MAX_AGE_MS) {
    return 'held';
  }
  // Steal it ATOMICALLY: unlink-then-create is a check-then-act race;
  // renameSync to a unique name is atomic — exactly one stealer wins.
  const stolen = `${lock}.${process.pid}.${Date.now()}.stale`;
  try {
    renameSync(lock, stolen);
  } catch {
    return 'held'; // lost the steal race
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
    return 'held'; // a fresh caller won the normal path in the gap
  }
}

// Spawn the detached installer. The worker (not this millisecond-lived hook
// process) runs `npm install`, probes, writes the ABI marker, and removes the
// lock on exit; the worker owns the install log so stdio is 'ignore' here.
function defaultSpawnWorker() {
  return spawn(process.execPath, [join(PLUGIN_ROOT, 'scripts', 'install-worker.js')], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env },
  });
}

// Fire-and-forget the detached background install. Idempotent, single-flight,
// never throws and never blocks — must not disrupt the triggering hook turn.
// MINDWRIGHT_AUTO_INSTALL=false opts out (air-gapped/vendored node_modules).
export function maybeAutoInstall({ depsCheck = depsInstalled, spawnWorker = defaultSpawnWorker } = {}) {
  try {
    if (process.env.MINDWRIGHT_AUTO_INSTALL === 'false') return;
    if (depsCheck()) return;
    // Only the exclusive winner spawns. 'held' and 'uncreatable' both mean
    // "do not spawn a detached install here" — the latter because an
    // unattended background install with nowhere to lock would race itself
    // across sessions.
    if (acquireLock() !== 'acquired') return;
    const child = spawnWorker();
    // The install must outlive the millisecond-lived hook process.
    try {
      if (child && typeof child.unref === 'function') child.unref();
    } catch {
      /* */
    }
  } catch {
    /* best-effort: depsInstalled() stays false → a later session retries
       once the lock ages out */
  }
}

// The real blocking `npm install` for /mindwright:setup, cwd = the persistent
// data dir. Extracted so runInstallSync's seam can substitute a stub; owns
// only the spawn + its error→result mapping (lock lifecycle stays in caller).
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

// Blocking install for the user-invoked /mindwright:setup path: the user asked
// to "make it work" and expects it to take a while, so blocking is the right
// UX here — unlike the hooks, which must never block. Returns a structured
// result instead of throwing so the caller can print a clean message.
//
// Single-flight: a background maybeAutoInstall() may already be running a
// detached `npm install` into the same node_modules, which two concurrent
// installs would corrupt. So this path participates in the SAME lock: if a
// fresh background install holds it, this returns a `pending` result so the
// caller can ask the user to re-run shortly — NEVER a competing install.
// depsCheck() is re-checked first in case it just landed.
//
// async because a successful install must run the same load-probe the detached
// worker does and write the ABI marker depsInstalled() requires (loadProbe is
// irreducibly async — a dynamic native import). Options are hermetic test
// seams (defaults = real impls).
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
  // 'acquired' or 'uncreatable': in both cases running the install now is
  // correct — for 'uncreatable' the detached maybeAutoInstall self-suppresses
  // in this same environment so there is no competing install, and there is
  // simply no lock for the finally to remove.
  try {
    prepareInstallDir();
    const r = spawnInstall();
    if (r && r.ok) {
      // Stamp the ABI capability token depsInstalled() requires, via the SAME
      // never-throw tail the detached worker uses (probeAndMarkIfOk) so the
      // two install paths cannot drift. A FAILING probe leaves NO marker on
      // purpose: npm "succeeded" but the binding will not load (wrong
      // platform/ABI); the {ok} npm result is still returned and setup.js's
      // post-install depsCheck() guard surfaces the clear message. No result
      // is passed so the tail runs the probe itself and swallows any throw.
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
