// Coverage for scripts/setup.js — the deps-absent synchronous-install gate
// of the one-stop /mindwright:setup command. This is the user's primary
// failure-messaging surface when a marketplace copy (or a plugin update that
// wiped node_modules) needs deps installed. The shim has THREE
// observable outcomes in the deps-absent branch:
//   1. runInstallSync() returns !ok            → "dependency install FAILED"
//      + installLogPath(), exit(1)
//   2. runInstallSync() ok but deps STILL absent → "npm ci reported
//      success but ... not resolvable", exit(1)  (a defensive double-check)
//   3. ok + deps now present                    → falls through to the model
//      download (the real heavy impl — out of scope here; that's the
//      deps-present path the dev tree already exercises end-to-end).
//
// Outcome 1 is verified end-to-end via a real subprocess on a faithful
// node_modules-less copy with npm forced off PATH (the same proven
// mechanism as auto-setup.test.js's npm-not-found test — runInstallSync
// short-circuits BEFORE any spawn, so NO real `npm ci` ever runs).
// Outcome 2 is a defensive guard not deterministically reachable from a
// subprocess without a flaky filesystem race, so it is driven in-process
// through setup.js's injectable seam (run({ depsCheck, install })). The
// invokedDirectly guard makes importing setup.js side-effect-free.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from '../../scripts/setup.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PLUGIN_ROOT = resolve(__dirname, '..', '..');

// Run fn() with process.exit and process.stderr.write intercepted: setup.js
// calls process.exit(1), which would kill the test runner. Stub it to throw a
// sentinel, swallow ONLY that sentinel, and restore both in finally.
async function captureExit(fn) {
  const errChunks = [];
  const origWrite = process.stderr.write;
  const origExit = process.exit;
  let exitCode;
  process.stderr.write = (s) => {
    errChunks.push(String(s));
    return true;
  };
  process.exit = (c) => {
    exitCode = c;
    throw new Error('__setup_exit__');
  };
  try {
    await fn();
  } catch (e) {
    if (!e || e.message !== '__setup_exit__') throw e;
  } finally {
    process.stderr.write = origWrite;
    process.exit = origExit;
  }
  return { exitCode, stderr: errChunks.join('') };
}

test('deps-absent + npm off PATH: real subprocess exits 1 with the FAILED message and the install-log path', () => {
  // End-to-end truth for outcome 1. Faithful marketplace copy: scripts/ +
  // lib/ with NO node_modules → the copy's depsInstalled() is false (paths.js
  // derives PLUGIN_ROOT from its own location → the sandbox). PATH='' makes
  // runInstallSync()'s npmAvailable() probe fail, so it returns the structured
  // npm-not-found error WITHOUT spawning (proven in auto-setup.test.js) — no
  // real `npm ci` can run here. setup-impl.js is copied but never
  // imported (the branch exits before the dynamic import).
  const pluginCopy = mkdtempSync(join(tmpdir(), 'mindwright-setup-plugin-'));
  const projectDir = mkdtempSync(join(tmpdir(), 'mindwright-setup-proj-'));
  try {
    cpSync(join(PLUGIN_ROOT, 'lib'), join(pluginCopy, 'lib'), { recursive: true });
    cpSync(join(PLUGIN_ROOT, 'scripts'), join(pluginCopy, 'scripts'), { recursive: true });

    const res = spawnSync(process.execPath, [join(pluginCopy, 'scripts', 'setup.js')], {
      encoding: 'utf8',
      timeout: 20000,
      env: {
        ...process.env,
        PATH: '',
        MINDWRIGHT_PROJECT_ROOT: projectDir,
        MINDWRIGHT_INSTALL_LOCK_DIR: pluginCopy,
      },
    });

    assert.equal(res.status, 1, `expected exit 1; got status=${res.status} signal=${res.signal} stderr=${res.stderr}`);
    assert.match(res.stderr, /native dependencies not installed/);
    assert.match(res.stderr, /dependency install FAILED:/);
    assert.match(res.stderr, /npm not found on PATH/);
    assert.match(res.stderr, /install log \(if any\): .*mindwright-install-.*\.log/);
  } finally {
    for (const d of [pluginCopy, projectDir]) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* tmp */ }
    }
  }
});

test('run() injected install {ok:false}: exits 1 with the FAILED message and installLogPath', async () => {
  const prevLockDir = process.env.MINDWRIGHT_INSTALL_LOCK_DIR;
  const lockDir = mkdtempSync(join(tmpdir(), 'mindwright-setup-lock-'));
  process.env.MINDWRIGHT_INSTALL_LOCK_DIR = lockDir;
  try {
    const { exitCode, stderr } = await captureExit(() =>
      run({
        depsCheck: () => false,
        install: () => ({ ok: false, code: null, error: 'simulated npm failure' }),
      }),
    );

    assert.equal(exitCode, 1);
    assert.match(stderr, /dependency install FAILED: simulated npm failure/);
    assert.match(stderr, /install log \(if any\): .*mindwright-install-.*\.log/);
    // The defensive second message must NOT appear — we took the first exit.
    assert.ok(!/reported success but/.test(stderr), 'must not also emit the success-but-unresolvable message');
  } finally {
    if (prevLockDir === undefined) delete process.env.MINDWRIGHT_INSTALL_LOCK_DIR;
    else process.env.MINDWRIGHT_INSTALL_LOCK_DIR = prevLockDir;
    try { rmSync(lockDir, { recursive: true, force: true }); } catch { /* tmp */ }
  }
});

test('run() injected install {ok:true} but deps still absent: exits 1 with the success-but-unresolvable message', async () => {
  // The defensive double-check (outcome 2): npm claimed success yet the native
  // deps are still not resolvable (partial/failed native build). depsCheck is
  // false at BOTH the entry gate and the post-install re-check, so the entry
  // condition holds and the second exit(1) fires — never the first (install
  // returned ok) and never the model-download fallthrough.
  const { exitCode, stderr } = await captureExit(() =>
    run({
      depsCheck: () => false,
      install: () => ({ ok: true, code: 0 }),
    }),
  );

  assert.equal(exitCode, 1);
  assert.match(stderr, /npm ci reported success but the native deps still are not resolvable/);
  assert.ok(!/dependency install FAILED/.test(stderr), 'must not emit the FAILED message — install returned ok');
});
