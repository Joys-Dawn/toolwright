// Coverage for lib/ready.js — the dependency-free readiness gate every
// auto-firing entrypoint checks BEFORE importing any native-dep module.
// The crash-safety of the whole plugin rests on this predicate, so its
// three exported forms (depsInstalled / modelsReady / isReady) are pinned
// here against a synthetic node_modules tree rather than the real one.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { depsInstalled, modelsReady, isReady } from '../lib/ready.js';
import { markerPath } from '../lib/health-marker.js';

// Pinned version stamped into every synthetic dep's package.json so a planted
// "valid" marker can vouch for an exact version (markerValid compares the
// marker's recorded version against node_modules/<dep>/package.json).
const NM_VERSION = '1.0.0';

// Temp plugin roots are registered by makeRoot and torn down HERE — in an
// afterEach, not as a trailing statement, so a failing assertion can't leak
// the dir under tmpdir(). Matches the beforeEach/afterEach teardown hygiene
// the sibling test files added in the same change (auto-setup/offset-init/
// install-worker) already use.
const createdRoots = [];
afterEach(() => {
  while (createdRoots.length) {
    try { rmSync(createdRoots.pop(), { recursive: true, force: true }); }
    catch { /* best-effort tmp cleanup */ }
  }
});

// Build a temp dir that looks like a plugin root with `node_modules` populated
// for the given native-dep names (each with a package.json so the health
// marker is checkable). `marker` controls the planted ABI marker:
//   'valid' (default) — a marker valid for the running ABI vouching for both
//                        canonical deps at NM_VERSION (so depsInstalled's new
//                        marker half passes for an otherwise-good tree).
//   'none'            — plant no marker at all (dirs-present-but-unvouched).
//   <object>          — plant this exact object as the marker JSON (used for
//                        the abi-mismatch / version-mismatch negative cases).
// Returns the root path.
function makeRoot(deps, { marker = 'valid' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mw-ready-'));
  for (const d of deps) {
    mkdirSync(join(root, 'node_modules', d), { recursive: true });
    writeFileSync(
      join(root, 'node_modules', d, 'package.json'),
      JSON.stringify({ name: d, version: NM_VERSION }),
    );
  }
  if (marker === 'valid') {
    mkdirSync(join(root, 'node_modules'), { recursive: true });
    writeFileSync(
      markerPath(root),
      JSON.stringify({
        abi: process.versions.modules,
        deps: { 'better-sqlite3': NM_VERSION, 'sqlite-vec': NM_VERSION },
        node: process.version,
        writtenAt: new Date().toISOString(),
      }),
    );
  } else if (marker && typeof marker === 'object') {
    mkdirSync(join(root, 'node_modules'), { recursive: true });
    writeFileSync(markerPath(root), JSON.stringify(marker));
  }
  createdRoots.push(root);
  return root;
}

function withStubModels(value, fn) {
  const prev = process.env.MINDWRIGHT_USE_STUB_MODELS;
  if (value === undefined) delete process.env.MINDWRIGHT_USE_STUB_MODELS;
  else process.env.MINDWRIGHT_USE_STUB_MODELS = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.MINDWRIGHT_USE_STUB_MODELS;
    else process.env.MINDWRIGHT_USE_STUB_MODELS = prev;
  }
}

// Run fn() with MINDWRIGHT_MODEL_CACHE_DIR pointed at a throwaway dir (so the
// modelCacheDir() that modelsReady()→embedderCached() consults is fully
// controlled, without perturbing pluginDataDir()-derived dependency
// resolution) and stub mode OFF (so the real existsSync model-presence check
// is what decides, not the escape hatch). `planted` controls whether the
// bge-m3 repo dir exists in that cache. Restores all env + removes the dir.
function withModelCache(planted, fn) {
  const prevCacheDir = process.env.MINDWRIGHT_MODEL_CACHE_DIR;
  const prevStub = process.env.MINDWRIGHT_USE_STUB_MODELS;
  const cacheDir = mkdtempSync(join(tmpdir(), 'mw-ready-cache-'));
  if (planted) {
    // transformers.js <org>/<name> layout — NOT the Python-hub models--org--name.
    mkdirSync(join(cacheDir, 'Xenova', 'bge-m3'), { recursive: true });
  }
  process.env.MINDWRIGHT_MODEL_CACHE_DIR = cacheDir;
  delete process.env.MINDWRIGHT_USE_STUB_MODELS;
  try {
    return fn();
  } finally {
    if (prevCacheDir === undefined) delete process.env.MINDWRIGHT_MODEL_CACHE_DIR;
    else process.env.MINDWRIGHT_MODEL_CACHE_DIR = prevCacheDir;
    if (prevStub === undefined) delete process.env.MINDWRIGHT_USE_STUB_MODELS;
    else process.env.MINDWRIGHT_USE_STUB_MODELS = prevStub;
    rmSync(cacheDir, { recursive: true, force: true });
  }
}

test('depsInstalled is true when both native deps are present AND a valid ABI marker exists', () => {
  const root = makeRoot(['better-sqlite3', 'sqlite-vec']); // default: valid marker

  assert.equal(depsInstalled(root), true);
});

test('depsInstalled is false when both dep dirs are present but NO marker exists (the un-probed tree)', () => {
  // This is exactly the dev-tree state right after the Step-2 tightening and
  // the post-Node-upgrade state: dirs there, but nothing vouches the binding
  // loads under this ABI. Must read not-ready so the self-heal re-probes.
  const root = makeRoot(['better-sqlite3', 'sqlite-vec'], { marker: 'none' });

  assert.equal(depsInstalled(root), false);
});

test('depsInstalled is false when the marker ABI does not match the running Node (the upgrade case)', () => {
  const root = makeRoot(['better-sqlite3', 'sqlite-vec'], {
    marker: {
      abi: `${process.versions.modules}-stale`,
      deps: { 'better-sqlite3': NM_VERSION, 'sqlite-vec': NM_VERSION },
      node: process.version,
      writtenAt: new Date().toISOString(),
    },
  });

  assert.equal(depsInstalled(root), false);
});

test('depsInstalled is false when a recorded dep version no longer matches the installed one', () => {
  const root = makeRoot(['better-sqlite3', 'sqlite-vec'], {
    marker: {
      abi: process.versions.modules,
      deps: { 'better-sqlite3': '9.9.9', 'sqlite-vec': NM_VERSION }, // disk is NM_VERSION
      node: process.version,
      writtenAt: new Date().toISOString(),
    },
  });

  assert.equal(depsInstalled(root), false);
});

test('depsInstalled is false when one of the two native deps is missing', () => {
  const root = makeRoot(['better-sqlite3']); // sqlite-vec absent

  assert.equal(depsInstalled(root), false);
});

test('depsInstalled is false when node_modules does not exist at all', () => {
  const root = makeRoot([]); // no node_modules created

  assert.equal(depsInstalled(root), false);
});

test('depsInstalled never throws on an unreadable/garbage root — returns false', () => {
  // A path that cannot be a directory: existsSync just returns false, the
  // try/catch is the belt-and-suspenders. Must degrade, not throw.
  assert.equal(depsInstalled('\0not-a-real-path'), false);
});

test('depsInstalled() with the real PLUGIN_ROOT is true UNDER `npm test` (the pretest-established ABI marker is its precondition)', () => {
  // PLUGIN_ROOT-resolution regression guard. Post-Step-2, "ready" means dep
  // dirs present AND a marker valid for the running Node ABI. The npm
  // `pretest` lifecycle script (scripts/ensure-health-marker.js) establishes
  // that marker via the REAL production code path (loadProbe → writeMarker)
  // once, before `node --test` forks any worker — so by the time this runs
  // the precondition holds, exactly as it would for an installed plugin whose
  // setup path ran. This test must NOT write/delete the real marker itself:
  // `node --test` runs each file in a separate parallel child process by
  // default (verified: Node v24 test.html — default isolation 'process'), and
  // the ~100 tests that spawn the real entrypoints resolve PLUGIN_ROOT to
  // this same tree, so a `finally`-unlink here would race their subprocesses.
  // It only READS via depsInstalled(), relying on the pretest-established
  // precondition (the synthetic-root cases above cover the marker logic
  // itself without touching the real tree).
  //
  // A `{ skip: !markerValid() }` guard was deliberately REJECTED: markerValid()
  // here is rooted at the real PLUGIN_ROOT, so it would also be false under the
  // very PLUGIN_ROOT-resolution regression this named test exists to catch —
  // the guard would self-disable on its own target fault. A loud, named
  // failure is the correct signal; the `npm test`-only precondition is instead
  // surfaced in the test NAME so a standalone-run failure is self-explaining
  // ("run via `npm test`") rather than a confusing false depsInstalled bug.
  assert.equal(depsInstalled(), true);
});

test('modelsReady honors the MINDWRIGHT_USE_STUB_MODELS=1 escape hatch', () => {
  withStubModels('1', () => {
    assert.equal(modelsReady(), true);
  });
});

test('modelsReady is false when the bge-m3 cache is absent and stubs disabled', () => {
  // The real not-ready decision the gate exists for — not just "is a boolean".
  // No planted cache in the throwaway model-cache dir → must report false.
  withModelCache(false, () => {
    assert.equal(modelsReady(), false);
  });
});

test('modelsReady is true when the bge-m3 cache is present and stubs disabled', () => {
  // Planted Xenova/bge-m3 in the throwaway model-cache dir, stub mode OFF, so
  // this exercises the real existsSync path rather than the escape hatch.
  withModelCache(true, () => {
    assert.equal(modelsReady(), true);
  });
});

test('isReady is true when deps are present AND models are ready (stub)', () => {
  const root = makeRoot(['better-sqlite3', 'sqlite-vec']);

  withStubModels('1', () => {
    assert.equal(isReady(root), true);
  });
});

test('isReady is false when deps are absent even if models are ready (AND semantics)', () => {
  const root = makeRoot([]); // deps missing

  withStubModels('1', () => {
    assert.equal(isReady(root), false);
  });
});
