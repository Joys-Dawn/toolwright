// Regression test for scripts/seed-loop.js — the detached transcript-bootstrap
// entrypoint. lib/seed-loop.js (the real loop logic) is covered in-process by
// test/seed-loop.test.js; THIS file covers the spawnable wrapper's one
// dependency-free responsibility: the deps-absent crash guard.
//
// maybeAutoSeed spawns this DETACHED and fire-and-forget. If a node_modules
// wipe races the spawn, the wrapper must degrade to a clean JSON no-op — never
// an ESM-load crash (the static `../lib/store.js` etc. are dynamic-imported
// AFTER the gate for exactly this reason). Nothing parses this particular
// stdout (it is detached), but the guard's contract — exit cleanly, emit the
// structured shape, never ERR_MODULE_NOT_FOUND — is what keeps a deps-less
// install dormant instead of crash-spamming, so it is asserted here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, cpSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PLUGIN_ROOT = resolve(__dirname, '..', '..');

test('deps-absent: exits cleanly with the deps_not_installed shape and never ESM-crashes', () => {
  // Every in-process seed-loop test runs in the deps-present dev tree, so the
  // deps-absent branch was never executed. Reproduce a faithful marketplace
  // copy: scripts/ + lib/ with NO node_modules → the copy's depsInstalled() is
  // false (paths.js derives PLUGIN_ROOT from its own location → the sandbox).
  // store.js/seed-loop.js/seed-consolidate.js are reached only via dynamic
  // import AFTER the gate, so they are intentionally NOT copied — if the guard
  // regressed to load them eagerly this test would fail with the very
  // ERR_MODULE_NOT_FOUND it asserts against. mcp/ is not in the static
  // dep-free graph (scripts/seed-loop.js imports only node:url + hook-log.js +
  // ready.js), unlike seed-from-repo.js — so it is not needed.
  const pluginCopy = mkdtempSync(join(tmpdir(), 'mindwright-seedloop-plugin-'));
  const projectDir = mkdtempSync(join(tmpdir(), 'mindwright-seedloop-da-proj-'));
  try {
    cpSync(join(PLUGIN_ROOT, 'lib'), join(pluginCopy, 'lib'), { recursive: true });
    cpSync(join(PLUGIN_ROOT, 'scripts'), join(pluginCopy, 'scripts'), { recursive: true });

    const res = spawnSync(process.execPath, [join(pluginCopy, 'scripts', 'seed-loop.js')], {
      encoding: 'utf8',
      timeout: 20000,
      env: {
        ...process.env,
        MINDWRIGHT_PROJECT_ROOT: projectDir,
      },
    });

    assert.equal(
      res.status,
      0,
      `guard returns (no process.exit); got status=${res.status} signal=${res.signal} stderr=${res.stderr}`,
    );
    assert.deepEqual(
      JSON.parse(res.stdout.trim()),
      { ok: false, error: 'deps_not_installed' },
      'stdout must be exactly the structured deps_not_installed no-op (no extra keys)',
    );
    assert.equal(res.stderr, '', 'the clean-no-op path writes nothing to stderr');
    assert.ok(
      !/ERR_MODULE_NOT_FOUND/.test(res.stderr),
      'the gate must short-circuit before the dynamic import of ../lib/store.js',
    );
    assert.equal(
      existsSync(join(projectDir, '.claude', 'mindwright', 'mindwright.db')),
      false,
      'deps-absent branch must return before openStore (no DB file created)',
    );
  } finally {
    for (const d of [pluginCopy, projectDir]) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* tmp */ }
    }
  }
});
