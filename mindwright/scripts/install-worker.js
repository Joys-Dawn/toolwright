#!/usr/bin/env node
// Detached dependency installer.
//
// maybeAutoInstall() acquireLock()s then spawns THIS, detached and
// fire-and-forget; the millisecond-lived hook process that spawned it is
// already gone. The worker:
//
//   - PROBES the native bindings, then checks the bundled-vs-installed
//     dependency manifest. `npm install` is skipped ONLY when the probe passes
//     AND the manifest matches (deps present, load under this Node ABI, and
//     are the set this plugin version bundles — the dev-tree self-heal after a
//     depsInstalled tightening). It runs the install when the probe fails
//     (deps absent OR an ABI-stale build after a Node upgrade) OR the manifest
//     drifted (a plugin update bumped a dependency — including the non-native
//     SDK/transformers the probe never even loads). Gating on the probe alone
//     would be blind to manifest drift: the OLD bindings still load, so the
//     gate that spawned this worker (depsInstalled → manifestUpToDate) would
//     never clear and an idle worker would respawn every session forever.
//   - writes the ABI health marker (the capability token depsInstalled()
//     requires) into the persistent data dir ONLY after `npm` exited 0 AND a
//     real post-install load-probe passed. A non-zero `npm` exit ⇒ NO marker:
//     a partial install (the two compiled ABI deps landed but the pure-JS
//     transformers/SDK did not) must never masquerade as ready, since the MCP
//     daemon would then crash-loop with no self-heal. Mirrors the synchronous
//     /mindwright:setup path (lib/auto-setup.js#runInstallSync).
//   - on ANY exit removes the lock so the next session's retry is not blocked
//     for the whole max-age window.
//
// The heartbeat/pid-adopt/bounded-backoff machine the supervised worker used
// to carry was deliberately removed alongside the auto-setup.js collapse: the
// persistent data dir means the install runs ONCE and survives updates, so the
// every-update reinstall churn that machinery bounded no longer happens. The
// lock is a plain fixed-window file owned by the spawner; this worker only
// tidies it up on exit (see lib/auto-setup.js for the single-flight contract).
//
// HARD DEP-FREE RULE (same as ready.js / auto-setup.js / health-marker.js):
// this file's STATIC import graph is `node:` builtins + the already-proven
// dep-free libs only. The native bindings are touched solely by loadProbe(),
// and only through its DYNAMIC import() — never the static graph. This script
// IS in the hook-shim ENTRYPOINTS dormancy list: a deps-less marketplace copy
// must be able to LOAD it without ERR_MODULE_NOT_FOUND (it then runs the very
// install that ends the deps-less state).

import { spawn } from 'node:child_process';
import { unlinkSync, openSync, closeSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { logHookError } from '../lib/hook-log.js';
import { pluginDataDir } from '../lib/paths.js';
import { installLockPath, installLogPath, NPM_INSTALL_ARGS, prepareInstallDir } from '../lib/auto-setup.js';
import { loadProbe, probeAndMarkIfOk, writeMarker } from '../lib/health-marker.js';
// ready.js is already in this file's transitive static graph (auto-setup.js
// imports depsInstalled from it) and is proven dep-free — adding this direct
// import introduces no new module and cannot taint the dormancy graph.
import { manifestUpToDate } from '../lib/ready.js';

// The real `npm install`, cwd = the PERSISTENT data dir (prepareInstallDir()
// copied the manifest there), output appended to the install log so
// /mindwright:status can show why a build failed. Same flags and
// shell/windowsHide posture as the synchronous setup path (NPM_INSTALL_ARGS is
// the shared single source). Resolves {ok, code}; never rejects — a spawn
// failure is just a not-ok result the re-probe will reflect.
//
// child_process.spawn + awaiting 'close' (not spawnSync) keeps the event loop
// free; it costs nothing here (detached background process) and avoids
// freezing the loop for a minutes-long from-source compile.
function defaultRunNpmInstall() {
  return new Promise((resolveResult) => {
    let logFd;
    try {
      logFd = openSync(installLogPath(), 'a');
    } catch {
      logFd = null;
    }
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (logFd !== null) {
        try {
          closeSync(logFd);
        } catch {
          /* best-effort */
        }
        logFd = null;
      }
      resolveResult(result);
    };
    let child;
    try {
      child = spawn('npm', NPM_INSTALL_ARGS, {
        cwd: pluginDataDir(),
        stdio: logFd === null ? 'ignore' : ['ignore', logFd, logFd],
        shell: true, // resolves npm.cmd on Windows / npm on POSIX
        windowsHide: true,
      });
    } catch (e) {
      finish({ ok: false, code: null, error: e && e.message ? e.message : String(e) });
      return;
    }
    // 'error' (npm not on PATH, EACCES, …) → not-ok; 'close' fires after the
    // child fully exits AND its stdio (the log fd) is flushed.
    child.on('error', (e) => finish({ ok: false, code: null, error: e && e.message ? e.message : String(e) }));
    child.on('close', (code) => finish({ ok: code === 0, code }));
  });
}

// The options arg is the established repo test seam (defaults = the real
// implementations → production behavior unchanged). It lets the probe / npm /
// marker / lock-removal collaborators be driven deterministically with NO real
// `npm install`, NO real broken binding, and NO real subprocess.
export async function main({
  probe = loadProbe,
  runNpmInstall = defaultRunNpmInstall,
  writeHealthMarker = writeMarker,
  manifestOk = manifestUpToDate,
  removeLock = (p) => {
    try {
      unlinkSync(p);
    } catch {
      /* already gone */
    }
  },
} = {}) {
  // Opt-out FIRST, before any fs/probe/spawn — symmetric with maybeAutoInstall.
  // Also the clean dep-free-load proof the copied-tree dormancy test uses: a
  // deps-less marketplace copy must LOAD this entrypoint without crashing; with
  // the opt-out set it returns immediately, proving loadability without ever
  // running a real install.
  if (process.env.MINDWRIGHT_AUTO_INSTALL === 'false') return;

  const lockPath = installLockPath();
  try {
    // Skip `npm install` ONLY when the deps both LOAD (probe ok) AND are the
    // set this plugin version bundles (manifestUpToDate). A passing probe
    // alone is NOT sufficient: after a plugin update bumps a dependency the
    // OLD bindings still load (probe ok) but the installed set is stale —
    // manifestUpToDate() is exactly what depsInstalled() (the predicate that
    // spawned this worker) is failing on, so gating on the probe alone would
    // leave the gate false forever and respawn an idle worker every session.
    let r = await probe();
    if (!r.ok || !manifestOk()) {
      // Put the (possibly updated) manifest in the persistent data dir, then
      // install there. The re-probe runs only AFTER npm has actually exited.
      prepareInstallDir();
      const npmResult = await runNpmInstall();
      // Gate on npm's EXIT CODE, mirroring the synchronous /mindwright:setup
      // path (auto-setup.js#runInstallSync's `if (r && r.ok)`) — the check the
      // collapse dropped from the detached worker. A non-zero exit means a
      // PARTIAL install: `npm` can have compiled+landed better-sqlite3 +
      // sqlite-vec (all loadProbe loads) yet never reached the pure-JS
      // @huggingface/transformers / @modelcontextprotocol/sdk. Re-probing only
      // the two ABI deps would then pass and writeHealthMarker() would flip
      // depsInstalled() PERMANENTLY true while the MCP daemon can never load
      // (ERR_MODULE_NOT_FOUND ∉ isNativeBindingError ⇒ server.mjs crash-loops
      // with no self-heal and /mindwright:status falsely reports ready). So on
      // a non-zero npm exit write NOTHING and bail — depsInstalled() stays
      // false and the next session retries. (finally still releases the lock.)
      if (!npmResult || !npmResult.ok) return;
      r = await probe();
    }
    // Stamp the capability token depsInstalled() requires via the SHARED
    // never-throw tail so this path and runInstallSync cannot drift again
    // (the drift that caused the implementation-2/correctness-1 silent-
    // dormancy bug). `r` is the probe we ALREADY ran — the post-npm re-probe,
    // or the pre-npm one when the install was skipped because deps were
    // loadable + manifest-current (the deliberate marker-rewrite self-heal).
    // Pass it so the tail does NOT re-probe (this path's exact probe count is
    // asserted). probe not ok (npm exited 0 but the binding will not load —
    // wrong platform/ABI) ⇒ no marker ⇒ depsInstalled() stays false ⇒ retry.
    await probeAndMarkIfOk(r, { writeHealthMarker });
  } finally {
    // Remove the lock so a retry is NOT blocked the full max-age window. On
    // success the marker already makes depsInstalled() true so callers
    // short-circuit before the lock anyway; this still tidies up.
    removeLock(lockPath);
  }
}

// Only run when executed directly (the detached spawn), not when a test
// imports main — mirrors scripts/seed-loop.js / scripts/ensure-health-marker.js.
const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main()
    .catch((err) => {
      try {
        logHookError('install-worker', 'crashed', err);
      } catch {
        /* best-effort */
      }
      process.stderr.write(`mindwright install-worker crashed: ${err && err.message}\n${(err && err.stack) || ''}\n`);
    })
    // Detached fire-and-forget: the exit code is unobserved. Always exit 0 —
    // a non-zero code on a best-effort background process is meaningless noise.
    .finally(() => process.exit(0));
}
