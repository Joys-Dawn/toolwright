// Coverage for scripts/install-worker.js — the detached dependency installer.
//
// Hard constraint (identical to auto-setup.test.js): this suite must NEVER run
// a real `npm install`, NEVER dynamic-import a real native binding, and NEVER
// write the real node_modules/.mindwright-health.json (a real-tree marker
// write races the parallel `node --test` workers). Every unit test injects the
// probe / npm / marker / removeLock collaborators via the established seam
// (defaults = the real impls → production unchanged) and runs inside a
// per-test MINDWRIGHT_INSTALL_LOCK_DIR sandbox, so lock / log I/O is hermetic.
//
// The worker was COLLAPSED alongside lib/auto-setup.js: no lock pid-adopt, no
// utimes heartbeat, no persisted bounded-backoff counter. The persistent data
// dir means the install runs ONCE and survives updates, so the every-update
// reinstall churn that machinery bounded no longer happens. What remains is
// the irreducible contract: skip npm ONLY when the deps both load (probe ok)
// AND match what this plugin version bundles (manifestUpToDate) — otherwise
// (probe fail OR manifest drift after a plugin update) prepare the persistent
// install dir + `npm install`, and ONLY if npm exited 0 re-probe + write the
// ABI marker (a non-zero npm exit ⇒ NO marker: a partial install where the
// two ABI deps landed but the pure-JS transformers/SDK did not must never
// masquerade as ready). ALWAYS release the lock on exit.
// prepareInstallDir()'s own behavior (mkdir + manifest copy + the
// source!==dest dev-tree guard) is unit-tested in auto-setup.test.js with a
// real CLAUDE_PLUGIN_DATA temp dir; here it is a guarded near-no-op (the dev
// tree has CLAUDE_PLUGIN_DATA unset ⇒ pluginDataDir() === PLUGIN_ROOT).
//
// The ONE end-to-end path — the copied-tree subprocess — is pinned to
// MINDWRIGHT_AUTO_INSTALL=false so it proves dep-free loadability + a clean
// exit WITHOUT ever reaching the probe/npm.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdtempSync, rmSync, cpSync, readdirSync } from 'node:fs';
import { main } from '../scripts/install-worker.js';
import { installLockPath } from '../lib/auto-setup.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(__dirname, '..');

const ENV_KEY = 'MINDWRIGHT_INSTALL_LOCK_DIR';
let sandboxDir;
let prevEnv;
let prevAutoInstall;

beforeEach(() => {
  prevEnv = process.env[ENV_KEY];
  prevAutoInstall = process.env.MINDWRIGHT_AUTO_INSTALL;
  sandboxDir = mkdtempSync(join(tmpdir(), 'mw-worker-'));
  process.env[ENV_KEY] = sandboxDir;
  // The seam-injected units must exercise the install path, not the opt-out;
  // tests that want the opt-out set it explicitly and this afterEach restores.
  delete process.env.MINDWRIGHT_AUTO_INSTALL;
});

afterEach(() => {
  if (prevEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = prevEnv;
  if (prevAutoInstall === undefined) delete process.env.MINDWRIGHT_AUTO_INSTALL;
  else process.env.MINDWRIGHT_AUTO_INSTALL = prevAutoInstall;
  try {
    rmSync(sandboxDir, { recursive: true, force: true });
  } catch {
    /* already gone */
  }
});

// A removeLock spy: records every path it was handed without unlinking, so a
// test can assert the lock-release contract by call, independent of whether a
// lock file was ever planted.
function lockSpy() {
  const calls = [];
  return { spy: (p) => calls.push(p), get calls() { return calls; } };
}

test('deps present, probe ok AND manifest current → skips npm, writes the marker, releases the lock', async () => {
  // The dev-tree fast self-heal: node_modules is there and loads AND is the
  // set this plugin bundles, only the ABI marker is missing. `npm install` is
  // NEVER run here (the tripwire proves it), the marker is written, the lock
  // is released. manifestOk is injected explicitly so the skip condition is
  // self-documenting and not silently reliant on the dev-tree same-file path.
  let markerWritten = 0;
  const rm = lockSpy();

  await main({
    probe: async () => ({ ok: true }),
    manifestOk: () => true,
    runNpmInstall: () => assert.fail('deps present + manifest current: `npm install` must NOT run'),
    writeHealthMarker: () => {
      markerWritten += 1;
      return true;
    },
    removeLock: rm.spy,
  });

  assert.equal(markerWritten, 1, 'the ABI marker must be written on a passing probe');
  assert.deepEqual(rm.calls, [installLockPath()], 'the lock must be released exactly once on exit');
});

test('deps present + probe ok but manifest drifted (plugin update bumped a dep) → still runs npm once, re-probes, writes marker, releases lock', async () => {
  // The implementation-2 regression guard. A plugin update bumps a dependency
  // (incl. the non-native SDK/transformers the probe never even loads). The
  // OLD bindings still load so probe()=ok, but manifestUpToDate()=false. The
  // predicate that SPAWNED this worker (maybeAutoInstall → !depsInstalled →
  // !manifestUpToDate) is failing on exactly that, so gating the install on
  // the probe alone would skip npm forever → the gate never clears → permanent
  // dormancy + an idle worker respawned every session. The worker MUST run the
  // install on manifest drift even though the probe is green.
  let npmCalls = 0;
  let markerWritten = 0;
  const rm = lockSpy();

  await main({
    probe: async () => ({ ok: true }), // old bindings load fine
    manifestOk: () => false, // …but the bundled/installed dep sets differ
    runNpmInstall: () => {
      npmCalls += 1;
      return { ok: true, code: 0 };
    },
    writeHealthMarker: () => {
      markerWritten += 1;
      return true;
    },
    removeLock: rm.spy,
  });

  assert.equal(npmCalls, 1, 'manifest drift MUST trigger the reinstall even though the probe is green');
  assert.equal(markerWritten, 1, 'the re-probe passed → marker rewritten for the reconciled dep set');
  assert.deepEqual(rm.calls, [installLockPath()], 'the lock is released exactly once on exit');
});

test('deps-absent (probe fails, then ok) → runs npm once, re-probes, writes marker, releases the lock', async () => {
  // The fresh-marketplace path: first probe fails (no node_modules),
  // prepareInstallDir() + `npm install` run, the re-probe passes, the marker
  // is written, and the DEFAULT removeLock releases the lock on exit.
  let probeCalls = 0;
  let npmCalls = 0;
  let markerWritten = 0;

  await main({
    probe: async () => {
      probeCalls += 1;
      return { ok: probeCalls >= 2 }; // miss, then hit after the install
    },
    runNpmInstall: () => {
      npmCalls += 1;
      return { ok: true, code: 0 };
    },
    writeHealthMarker: () => {
      markerWritten += 1;
      return true;
    },
  });

  assert.equal(probeCalls, 2, 'probe-first then re-probe AFTER the awaited install');
  assert.equal(npmCalls, 1, '`npm install` runs exactly once when the first probe fails');
  assert.equal(markerWritten, 1, 'the re-probe passed → marker written');
  assert.equal(existsSync(installLockPath()), false, 'the default removeLock releases the lock on exit');
});

test('install fails (npm exits non-zero, nothing loadable) → NO marker, lock still released', async () => {
  // No compiler / no network: `npm` exits non-zero. The worker bails on the
  // non-zero exit WITHOUT re-probing (the npm-exit gate), so the marker is
  // NOT written (depsInstalled stays false ⇒ a later session retries) and the
  // lock is STILL removed so the next session is not blocked the whole
  // max-age window.
  let npmCalls = 0;
  const rm = lockSpy();

  await main({
    probe: async () => ({ ok: false, error: 'ERR_MODULE_NOT_FOUND' }),
    runNpmInstall: () => {
      npmCalls += 1;
      return { ok: false, code: 1 };
    },
    writeHealthMarker: () => assert.fail('no marker may be written when `npm` exits non-zero'),
    removeLock: rm.spy,
  });

  assert.equal(npmCalls, 1, 'a failing first probe still triggers one install attempt');
  assert.deepEqual(rm.calls, [installLockPath()], 'the lock is released even on failure (fast crash recovery)');
});

test('partial install (npm exits non-zero) → NO marker even though the re-probe of the two ABI deps WOULD pass, lock released', async () => {
  // The correctness-1 regression guard. A fresh install where `npm` compiled +
  // landed better-sqlite3 + sqlite-vec but a network/disk failure aborted it
  // before the pure-JS @huggingface/transformers / @modelcontextprotocol/sdk
  // (npm exits non-zero). loadProbe loads ONLY the two ABI deps, so a re-probe
  // WOULD falsely pass — but the MCP daemon needs all four. Writing the marker
  // here flips depsInstalled() permanently true while server.mjs crash-loops
  // with no self-heal and /mindwright:status lies. The worker MUST gate the
  // marker on npm's exit code (mirroring runInstallSync): a non-zero npm ⇒
  // SKIP the re-probe + marker entirely ⇒ depsInstalled() stays false ⇒ the
  // next session retries. (The pre-fix bug discarded the npm result and
  // re-probed: the false-then-true probe below would have written the marker.)
  let npmCalls = 0;
  let probeCalls = 0;
  const rm = lockSpy();

  await main({
    probe: async () => {
      probeCalls += 1;
      return { ok: probeCalls >= 2 }; // miss (no deps), then WOULD hit (the 2 ABI deps landed)
    },
    runNpmInstall: () => {
      npmCalls += 1;
      return { ok: false, code: 1 }; // aborted partway → non-zero exit
    },
    writeHealthMarker: () =>
      assert.fail('a non-zero npm exit must NOT write the marker (a partial install must not masquerade as ready)'),
    removeLock: rm.spy,
  });

  assert.equal(npmCalls, 1, 'one install attempt was made');
  assert.equal(
    probeCalls,
    1,
    'the re-probe is SKIPPED on a non-zero npm exit (it would have falsely passed on just the 2 ABI deps)',
  );
  assert.deepEqual(rm.calls, [installLockPath()], 'the lock is released even on a failed install');
});

test('MINDWRIGHT_AUTO_INSTALL=false → hard no-op before any fs/probe/npm', async () => {
  process.env.MINDWRIGHT_AUTO_INSTALL = 'false';

  await main({
    probe: () => assert.fail('opt-out: must not probe'),
    runNpmInstall: () => assert.fail('opt-out: must not install'),
    writeHealthMarker: () => assert.fail('opt-out: must not mark'),
    removeLock: () => assert.fail('opt-out: must return before the try/finally'),
  });

  assert.equal(existsSync(installLockPath()), false, 'the opt-out returns before touching the lock');
});

test('deps-absent subprocess on a node_modules-less copy: loads dep-free and exits cleanly (opt-out)', () => {
  // The runtime dormancy proof, mirroring test/scripts/seed-loop.test.js. A
  // faithful marketplace copy is lib/ + scripts/ with NO node_modules. The
  // worker's STATIC graph must load without ERR_MODULE_NOT_FOUND (the native
  // bindings are only reached via loadProbe's DYNAMIC import). Pinned to
  // MINDWRIGHT_AUTO_INSTALL=false so it returns before the probe/npm — proving
  // loadability + a clean exit WITHOUT running a real install in the copy.
  const pluginCopy = mkdtempSync(join(tmpdir(), 'mw-worker-copy-'));
  const lockDir = mkdtempSync(join(tmpdir(), 'mw-worker-copy-locks-'));
  try {
    cpSync(join(PLUGIN_ROOT, 'lib'), join(pluginCopy, 'lib'), { recursive: true });
    cpSync(join(PLUGIN_ROOT, 'scripts'), join(pluginCopy, 'scripts'), { recursive: true });
    assert.equal(existsSync(join(pluginCopy, 'node_modules')), false, 'the copy must have NO node_modules');

    const res = spawnSync(process.execPath, [join(pluginCopy, 'scripts', 'install-worker.js')], {
      encoding: 'utf8',
      timeout: 20000,
      env: {
        ...process.env,
        MINDWRIGHT_AUTO_INSTALL: 'false',
        MINDWRIGHT_INSTALL_LOCK_DIR: lockDir,
      },
    });

    assert.equal(
      res.status,
      0,
      `worker must exit 0 on a deps-less copy; status=${res.status} signal=${res.signal} stderr=${res.stderr}`,
    );
    assert.ok(
      !/ERR_MODULE_NOT_FOUND/.test(res.stderr || ''),
      `the static graph must be dep-free (no ERR_MODULE_NOT_FOUND); stderr=${res.stderr}`,
    );
    assert.ok(
      !/install-worker crashed/.test(res.stderr || ''),
      `the worker must not crash; stderr=${res.stderr}`,
    );
    // The opt-out returns before the lock ⇒ NO artifact of any name in the
    // subprocess's lock dir (robust regardless of the copy's data-dir slug).
    assert.deepEqual(readdirSync(lockDir), [], 'the opt-out path creates no lock/log artifact');
  } finally {
    for (const d of [pluginCopy, lockDir]) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* tmp */
      }
    }
  }
});
