#!/usr/bin/env node
// Detached dependency installer, spawned fire-and-forget under the
// single-flight lock; on any exit it removes the lock so a retry is not
// blocked for the whole max-age window.
//
// Gate the install on probe AND manifest: a passing probe alone is blind to
// manifest drift — after a plugin update bumps a dependency the OLD bindings
// still load, so depsInstalled() would never clear and a worker would respawn
// every session forever. Write the health marker only after `npm` exited 0
// AND a post-install probe passed, so a partial install (compiled ABI deps
// landed but pure-JS transformers/SDK did not) can't masquerade as ready.
//
// STATIC import graph is dep-free; native bindings touched only via
// loadProbe()'s DYNAMIC import(), so a deps-less copy loads and runs the
// install that ends the deps-less state.

import { spawn } from 'node:child_process';
import { unlinkSync, openSync, closeSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { logHookError } from '../lib/hook-log.js';
import { pluginDataDir } from '../lib/paths.js';
import { installLockPath, installLogPath, NPM_INSTALL_ARGS, prepareInstallDir } from '../lib/auto-setup.js';
import { loadProbe, probeAndMarkIfOk, writeMarker } from '../lib/health-marker.js';
import { manifestUpToDate } from '../lib/ready.js';

// Real `npm ci` in the persistent data dir; output appended to the
// install log so /mindwright:status can show why a build failed. Never
// rejects — a spawn failure is a not-ok result the re-probe reflects. Async
// spawn keeps the event loop free for the minutes-long from-source compile.
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
    // 'close' (not 'exit') so the log fd is flushed before we resolve.
    child.on('error', (e) => finish({ ok: false, code: null, error: e && e.message ? e.message : String(e) }));
    child.on('close', (code) => finish({ ok: code === 0, code }));
  });
}

// The options arg is a test seam (defaults = the real implementations).
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
  // Opt-out before any fs/probe/spawn so a deps-less copy can return
  // immediately without running a real install.
  if (process.env.MINDWRIGHT_AUTO_INSTALL === 'false') return;

  const lockPath = installLockPath();
  try {
    // Skip `npm ci` only when deps both LOAD and match the bundled
    // manifest (see header for why probe-alone is insufficient).
    let r = await probe();
    if (!r.ok || !manifestOk()) {
      prepareInstallDir();
      const npmResult = await runNpmInstall();
      // Non-zero npm exit ⇒ possible partial install; write nothing and bail
      // so the next session retries (finally still releases the lock).
      if (!npmResult || !npmResult.ok) return;
      r = await probe();
    }
    // Stamp the capability token via the shared never-throw tail so this path
    // and runInstallSync cannot drift; pass `r` so the tail does not re-probe.
    await probeAndMarkIfOk(r, { writeHealthMarker });
  } finally {
    removeLock(lockPath);
  }
}

// Only run when executed directly (the detached spawn), not when a test
// imports main.
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
    // Detached fire-and-forget: always exit 0.
    .finally(() => process.exit(0));
}
