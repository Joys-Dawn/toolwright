// Regression test for scripts/ensure-health-marker.js — the npm `pretest`
// lifecycle entrypoint that re-establishes the ABI health marker through the
// production loadProbe → writeMarker contract. lib/health-marker.js's
// primitives are unit-covered in test/health-marker.test.js; THIS file covers
// the spawnable wrapper's two dependency-free responsibilities:
//
//   (a) deps-less plugin copy (lib/ + scripts/, no node_modules): the static
//       import graph (node:url + ../lib/health-marker.js → paths.js +
//       constants.js, all dep-free) must load cleanly, the dynamic
//       loadProbe('better-sqlite3') must FAIL into the probe-fail branch (not
//       an uncaught ESM crash), the warn must fire, NO marker is written, and —
//       the load-bearing contract — the process ALWAYS exits 0 so it can never
//       abort `npm test` on a machine with no native deps.
//   (b) pre-planted valid marker: markerValid()'s idempotent fast path returns
//       BEFORE the probe — proven here on a deps-less copy where any probe
//       attempt would necessarily fail and warn; an empty stderr + a
//       byte-identical marker is only reachable via the early return.
//
// Mirrors test/scripts/seed-loop.test.js / test/install-worker.test.js's
// copied-tree subprocess pattern: paths.js derives PLUGIN_ROOT from its own
// location, so a lib/+scripts/ copy with no node_modules is a faithful
// deps-less marketplace install.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, cpSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NATIVE_DEPS } from '../../lib/constants.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PLUGIN_ROOT = resolve(__dirname, '..', '..');
const MARKER_REL = join('node_modules', '.mindwright-health.json');

function makePluginCopy() {
  // lib/ + scripts/ only, NO node_modules → the copy's markerValid() is false
  // (no marker) and loadProbe()'s dynamic import('better-sqlite3') cannot
  // resolve from a tmpdir sandbox (the real node_modules is not an ancestor),
  // exactly the deps-less marketplace state. The static graph (health-marker.js
  // → paths.js → constants.js) IS copied — a regression to eager-load a native
  // dep would surface as the ERR_MODULE_NOT_FOUND this asserts against.
  const pluginCopy = mkdtempSync(join(tmpdir(), 'mindwright-ehm-plugin-'));
  cpSync(join(PLUGIN_ROOT, 'lib'), join(pluginCopy, 'lib'), { recursive: true });
  cpSync(join(PLUGIN_ROOT, 'scripts'), join(pluginCopy, 'scripts'), { recursive: true });
  return pluginCopy;
}

function runEnsure(pluginCopy) {
  return spawnSync(
    process.execPath,
    [join(pluginCopy, 'scripts', 'ensure-health-marker.js')],
    { encoding: 'utf8', timeout: 20000 },
  );
}

test('deps-less copy: probe fails, marker NOT written, ALWAYS exits 0, no ESM crash', () => {
  const pluginCopy = makePluginCopy();
  try {
    const res = runEnsure(pluginCopy);

    assert.equal(
      res.status,
      0,
      `the best-effort contract is .finally(process.exit(0)); got status=${res.status} `
        + `signal=${res.signal} stderr=${res.stderr}`,
    );
    // Reaching this warn proves the dep-free static graph loaded AND main()
    // ran to the loadProbe-fail branch (impossible if ESM load had crashed).
    assert.match(
      res.stderr,
      /\[mindwright:ensure-health-marker\] native binding load-probe failed/,
      `expected the probe-fail warn; got stderr=${JSON.stringify(res.stderr)}`,
    );
    assert.match(res.stderr, /marker NOT written/, 'warn must state the marker was not written');
    // A static-load crash prints Node's loader form `Error [ERR_MODULE_NOT_FOUND]:`
    // + a non-zero exit. The clean probe-fail embeds only e.message ("Cannot find
    // package 'better-sqlite3' …"), which does NOT contain the bracketed code —
    // so this still distinguishes clean-fail from static-crash.
    assert.ok(
      !/ERR_MODULE_NOT_FOUND/.test(res.stderr),
      `static dep-free graph must not crash-load; stderr=${JSON.stringify(res.stderr)}`,
    );
    assert.equal(
      existsSync(join(pluginCopy, MARKER_REL)),
      false,
      'probe failed ⇒ writeMarker must not have run ⇒ no marker file',
    );
  } finally {
    try { rmSync(pluginCopy, { recursive: true, force: true }); } catch { /* tmp */ }
  }
});

test('pre-planted valid marker: idempotent fast path returns before the probe (no-op)', () => {
  const pluginCopy = makePluginCopy();
  try {
    // Forge a marker valid for THIS Node ABI (the child is process.execPath →
    // identical process.versions.modules). markerValid() also re-reads each
    // dep's installed version from node_modules/<dep>/package.json, so plant a
    // matching package.json per NATIVE_DEPS (the single source of truth — keeps
    // this test correct if the dep set changes).
    const nm = join(pluginCopy, 'node_modules');
    mkdirSync(nm, { recursive: true });
    const deps = {};
    for (const dep of NATIVE_DEPS) {
      const v = `9.9.9-fixture-${dep}`;
      mkdirSync(join(nm, dep), { recursive: true });
      writeFileSync(
        join(nm, dep, 'package.json'),
        JSON.stringify({ name: dep, version: v }),
      );
      deps[dep] = v;
    }
    const markerPath = join(pluginCopy, MARKER_REL);
    writeFileSync(
      markerPath,
      JSON.stringify(
        {
          abi: process.versions.modules,
          deps,
          node: process.version,
          writtenAt: '2026-01-01T00:00:00.000Z',
        },
        null,
        2,
      ),
    );
    const before = readFileSync(markerPath);

    const res = runEnsure(pluginCopy);

    assert.equal(res.status, 0, `fast path must still exit 0; stderr=${res.stderr}`);
    // On this deps-less copy a probe attempt would necessarily fail and warn.
    // An EMPTY stderr therefore proves neither loadProbe nor writeMarker ran —
    // markerValid()'s `if (markerValid()) return;` short-circuited first.
    assert.equal(
      res.stderr,
      '',
      `valid marker ⇒ silent no-op (no probe-fail / write-fail warn); got ${JSON.stringify(res.stderr)}`,
    );
    // writeMarker() would rewrite `writtenAt`; a byte-identical marker is hard
    // proof the file was never touched.
    assert.deepEqual(
      readFileSync(markerPath),
      before,
      'fast-path no-op must leave the existing marker byte-identical',
    );
  } finally {
    try { rmSync(pluginCopy, { recursive: true, force: true }); } catch { /* tmp */ }
  }
});
