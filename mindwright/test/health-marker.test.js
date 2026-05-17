// Coverage for lib/health-marker.js — the ABI-stamped capability token that
// lib/ready.js#depsInstalled composes so a Node upgrade (deps present but
// ABI-stale) auto-reheals instead of going permanently silently dormant.
//
// markerValid is on every hook hot path and MUST never throw (it backs
// ready.js's "never throw → false" contract — see the garbage-root case in
// test/ready.test.js), so the negative paths here are as load-bearing as the
// positive one. loadProbe is exercised both for real (dev tree has the native
// deps — `npm test` requires them) and through the injected importer seam so a
// broken-binding outcome is testable without a genuinely broken binding.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  markerPath,
  readMarker,
  markerValid,
  writeMarker,
  invalidateMarker,
  isNativeBindingError,
  loadProbe,
  probeAndMarkIfOk,
} from '../lib/health-marker.js';

const ABI = process.versions.modules;
const DEPS = { 'better-sqlite3': '12.10.0', 'sqlite-vec': '0.1.9' };

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

// A temp dir shaped like a plugin root: node_modules/<dep>/package.json with a
// pinned version per `deps`, and optionally a planted marker (object → JSON,
// string → written verbatim so a garbage-JSON case is expressible).
function makeRoot({ deps = DEPS, marker } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mw-hm-'));
  for (const [dep, version] of Object.entries(deps)) {
    mkdirSync(join(root, 'node_modules', dep), { recursive: true });
    writeFileSync(
      join(root, 'node_modules', dep, 'package.json'),
      JSON.stringify({ name: dep, version }),
    );
  }
  if (marker !== undefined) {
    mkdirSync(join(root, 'node_modules'), { recursive: true });
    writeFileSync(
      markerPath(root),
      typeof marker === 'string' ? marker : JSON.stringify(marker),
    );
  }
  createdRoots.push(root);
  return root;
}

function freshMarker(deps = DEPS) {
  return { abi: ABI, deps: { ...deps }, node: process.version, writtenAt: new Date().toISOString() };
}

// ── markerValid ───────────────────────────────────────────────────────────

test('markerValid is true when the marker ABI and every dep version match', () => {
  const root = makeRoot({ marker: freshMarker() });

  assert.equal(markerValid(root), true);
});

test('markerValid is false on an ABI mismatch (the Node-upgrade case)', () => {
  const root = makeRoot({ marker: { ...freshMarker(), abi: `${ABI}-stale` } });

  assert.equal(markerValid(root), false);
});

test('markerValid is false when a recorded dep version no longer matches disk', () => {
  // Installed better-sqlite3 is 12.10.0; the marker vouches for 11.0.0 — a
  // reinstall changed the version, the marker is stale, must re-probe.
  const root = makeRoot({
    marker: { ...freshMarker(), deps: { 'better-sqlite3': '11.0.0', 'sqlite-vec': '0.1.9' } },
  });

  assert.equal(markerValid(root), false);
});

test('markerValid is false when no marker file exists', () => {
  const root = makeRoot(); // deps present, no marker planted

  assert.equal(markerValid(root), false);
});

test('markerValid is false on garbage JSON and never throws', () => {
  const root = makeRoot({ marker: 'not-json {{{ ::: ' });

  assert.equal(markerValid(root), false);
});

test('markerValid never throws on an unreadable/garbage root — returns false', () => {
  // Mirrors test/ready.test.js's garbage-root contract: a NUL byte cannot be
  // a path; markerValid must degrade to false, not throw, because ready.js's
  // depsInstalled composes it on every hot path.
  assert.equal(markerValid('\0not-a-real-path'), false);
});

test('markerValid is false when the marker is valid-shaped but a dep package.json is missing', () => {
  // ABI matches and the marker names both deps, but only one dep dir was
  // planted — depVersion throws for the missing one ⇒ not vouchable ⇒ false.
  const root = makeRoot({
    deps: { 'better-sqlite3': '12.10.0' }, // sqlite-vec absent on disk
    marker: freshMarker(),
  });

  assert.equal(markerValid(root), false);
});

// ── writeMarker ───────────────────────────────────────────────────────────

test('writeMarker records the running ABI + on-disk dep versions and round-trips', () => {
  const root = makeRoot(); // deps present, no marker yet

  const ok = writeMarker(root);

  assert.equal(ok, true);
  const m = readMarker(root);
  assert.equal(m.abi, ABI);
  assert.equal(m.node, process.version);
  assert.deepEqual(m.deps, DEPS);
  assert.equal(typeof m.writtenAt, 'string');
  assert.equal(Number.isNaN(Date.parse(m.writtenAt)), false);
  // The marker it just wrote must validate (self-consistent round-trip).
  assert.equal(markerValid(root), true);
});

test('writeMarker returns false and writes nothing when a dep version is unresolvable', () => {
  const root = makeRoot({ deps: {} }); // no deps planted at all

  const ok = writeMarker(root);

  assert.equal(ok, false);
  assert.equal(readMarker(root), null);
});

// ── invalidateMarker ──────────────────────────────────────────────────────

test('invalidateMarker removes the marker and is idempotent (no throw when absent)', () => {
  const root = makeRoot({ marker: freshMarker() });

  invalidateMarker(root);
  assert.equal(readMarker(root), null);

  // Second call on an already-absent marker must not throw.
  assert.doesNotThrow(() => invalidateMarker(root));
  assert.equal(readMarker(root), null);
});

test('invalidateMarker does not throw when called on a root that never had one', () => {
  const root = makeRoot(); // no marker

  assert.doesNotThrow(() => invalidateMarker(root));
});

// ── isNativeBindingError ──────────────────────────────────────────────────

test('isNativeBindingError is true for err.code === ERR_DLOPEN_FAILED', () => {
  const e = new Error('dlopen failed');
  e.code = 'ERR_DLOPEN_FAILED';

  assert.equal(isNativeBindingError(e), true);
});

test('isNativeBindingError is true for the verbatim NODE_MODULE_VERSION message', () => {
  // The exact stable better-sqlite3 ABI-mismatch message (WiseLibs #1393).
  const e = new Error(
    "The module '/x/better_sqlite3.node' was compiled against a different "
      + 'Node.js version using NODE_MODULE_VERSION 127. This version of Node.js '
      + 'requires NODE_MODULE_VERSION 137. Please try re-compiling or '
      + 're-installing the module.',
  );

  assert.equal(isNativeBindingError(e), true);
});

test('isNativeBindingError matches a bare dlopen failure string (no Error object)', () => {
  assert.equal(isNativeBindingError('Error: dlopen(/x.node): symbol not found'), true);
});

test('isNativeBindingError is false for an ordinary impl error (no spurious reinstall)', () => {
  // The guard that keeps a logic bug from triggering a reinstall thrash.
  assert.equal(isNativeBindingError(new Error('database is locked')), false);
});

test('isNativeBindingError is false for null/undefined (defensive)', () => {
  assert.equal(isNativeBindingError(null), false);
  assert.equal(isNativeBindingError(undefined), false);
});

// ── loadProbe ─────────────────────────────────────────────────────────────

test('loadProbe returns {ok:true} in the dev tree (real native bindings load)', async () => {
  // `npm test` requires the native deps installed in the plugin dir, so the
  // real dynamic import + sqlite-vec extension load + vec_version() call here
  // is a meaningful capability assertion, not an environment flake.
  const r = await loadProbe();

  assert.equal(r.ok, true);
});

test('loadProbe returns {ok:false,error} via a seam-injected throwing importer — never throws', async () => {
  let result;
  await assert.doesNotReject(async () => {
    result = await loadProbe({
      importer: () => { throw new Error('simulated broken binding'); },
    });
  });

  assert.equal(result.ok, false);
  assert.equal(typeof result.error, 'string');
  assert.match(result.error, /simulated broken binding/);
});

test('loadProbe with a seam importer throwing a native-binding-shaped error still resolves cleanly', async () => {
  const e = new Error('NODE_MODULE_VERSION mismatch');
  e.code = 'ERR_DLOPEN_FAILED';

  const r = await loadProbe({ importer: () => { throw e; } });

  assert.equal(r.ok, false);
  assert.equal(typeof r.error, 'string');
});

// ── probeAndMarkIfOk ──────────────────────────────────────────────────────
// THE convergent never-throw success-tail both install entrypoints share so
// the "write the marker IFF the binding loads" decision cannot drift apart
// again (the drift that caused the implementation-2/correctness-1 silent-
// dormancy bug). Both collaborators are seam-injected — no real binding,
// no real marker file needed; the two shapes (a supplied probe result vs the
// tail running the probe) and the two never-throw guarantees are pinned.

test('probeAndMarkIfOk with a supplied OK result marks and does NOT re-probe (the install-worker shape)', async () => {
  let probeCalls = 0;
  let marked = 0;

  const wrote = await probeAndMarkIfOk(
    { ok: true },
    {
      probe: () => { probeCalls += 1; return { ok: true }; },
      writeHealthMarker: () => { marked += 1; return true; },
    },
  );

  assert.equal(wrote, true, 'an ok probe result must write the marker and report it');
  assert.equal(marked, 1, 'writeHealthMarker called exactly once');
  assert.equal(
    probeCalls,
    0,
    'a supplied result must NOT trigger a re-probe — install-worker asserts its exact probe count',
  );
});

test('probeAndMarkIfOk with a supplied NOT-OK result writes no marker and returns false', async () => {
  let marked = 0;

  const wrote = await probeAndMarkIfOk(
    { ok: false, error: 'binding will not load' },
    { writeHealthMarker: () => { marked += 1; } },
  );

  assert.equal(wrote, false);
  assert.equal(marked, 0, 'a non-loading binding must never be vouched for');
});

test('probeAndMarkIfOk with NO supplied result runs the probe itself, then marks on ok (the runInstallSync shape)', async () => {
  let probeCalls = 0;
  let marked = 0;

  const wrote = await probeAndMarkIfOk(undefined, {
    probe: async () => { probeCalls += 1; return { ok: true }; },
    writeHealthMarker: () => { marked += 1; return true; },
  });

  assert.equal(probeCalls, 1, 'no supplied result ⇒ the tail runs the probe');
  assert.equal(marked, 1);
  assert.equal(wrote, true);
});

test('probeAndMarkIfOk with NO supplied result and a failing probe writes no marker, returns false', async () => {
  let marked = 0;

  const wrote = await probeAndMarkIfOk(undefined, {
    probe: async () => ({ ok: false, error: 'wrong ABI' }),
    writeHealthMarker: () => { marked += 1; },
  });

  assert.equal(wrote, false);
  assert.equal(marked, 0);
});

test('probeAndMarkIfOk never throws when the probe seam throws (runInstallSync never-throw contract)', async () => {
  let result;

  await assert.doesNotReject(async () => {
    result = await probeAndMarkIfOk(undefined, {
      probe: () => { throw new Error('probe seam blew up'); },
      writeHealthMarker: () => assert.fail('must not write the marker when the probe threw'),
    });
  });

  assert.equal(result, false, 'a thrown probe ⇒ not-ready ⇒ false ⇒ a later session retries');
});

test('probeAndMarkIfOk never throws when writeHealthMarker itself throws (best-effort marker write)', async () => {
  let result;

  await assert.doesNotReject(async () => {
    result = await probeAndMarkIfOk(
      { ok: true },
      { writeHealthMarker: () => { throw new Error('disk full'); } },
    );
  });

  assert.equal(
    result,
    false,
    'a failed marker write must leave depsInstalled() false, not crash the install path',
  );
});
