// ABI-stamped health marker — the single source of truth for "the native
// deps are not just PRESENT, they actually LOAD under the running Node ABI".
//
// WHY THIS EXISTS (implementation-2 / correctness-2): lib/ready.js#depsInstalled
// previously equated "node_modules/<dep> dir exists" with "ready". That is a
// lie after a Node upgrade: the dirs are still there but better-sqlite3's
// compiled `.node` was built against the old NODE_MODULE_VERSION, so every
// hook's `await import('better-sqlite3')` throws ERR_DLOPEN_FAILED forever and
// the plugin is permanently, silently dormant with no path back. The fix is a
// capability token: a marker file written ONLY after a real in-process
// load-probe succeeds, recording the ABI + dep versions it vouches for.
// depsInstalled becomes "dirs present AND a marker valid for THIS Node ABI".
// A Node bump changes process.versions.modules ⇒ the marker no longer matches
// ⇒ depsInstalled flips false ⇒ the existing self-heal reinstalls ⇒ a fresh
// probe rewrites the marker. Zero user action; auto-reheal.
//
// HARD DEP-FREE RULE (same contract as ready.js, which imports markerValid
// from here): this module's STATIC import graph must contain NO bare-npm
// import — only `node:` builtins + lib/paths.js + lib/constants.js +
// lib/native-require.js, every one of which is itself statically dep-free
// (native-require.js touches a real package ONLY inside loadNative(), via a
// DYNAMIC import(), never at module load). loadProbe() is the only code here
// that loads a native package, and it does so exclusively through that
// dynamic-import seam (default = native-require's loadNative; tests inject
// their own). The dormancy walker's `\bimport\b\s*(?!\()` lookahead excludes
// `import(`, so neither the probe nor native-require taints the static graph.
// Adding any static bare-npm import here re-breaks every entrypoint on a
// deps-less copy.

import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { pluginDataDir } from './paths.js';
import { NATIVE_DEPS } from './constants.js';
import { loadNative } from './native-require.js';

// NATIVE_DEPS is sourced from lib/constants.js (zero-import / dep-free, already
// in this module's dormancy graph via paths.js) — deliberately NOT imported
// from ready.js, which would be circular (ready.js imports markerValid from
// here). constants.js is the single source of truth both readiness predicates
// compose, so this ABI-marker check and ready.js's dir-existence check can
// never vouch for different dep sets.

// Lives next to node_modules in the PERSISTENT plugin data dir, alongside the
// deps it vouches for: both now survive plugin updates (they no longer sit in
// the ephemeral, update-replaced PLUGIN_ROOT). It can still never falsely
// outlive the deps' validity — markerValid() re-derives truth from the running
// Node ABI + the on-disk dep versions on every call, and a `rm -rf` of the
// data dir (or node_modules) takes the marker down with it.
export function markerPath(root = pluginDataDir()) {
  return join(root, 'node_modules', '.mindwright-health.json');
}

// Read the installed version of a native dep from its own package.json.
// Throws on a missing/garbage package.json so callers' try/catch can treat
// "can't determine the installed version" as "not vouchable".
function depVersion(root, dep) {
  const pkg = JSON.parse(readFileSync(join(root, 'node_modules', dep, 'package.json'), 'utf8'));
  return pkg.version;
}

// Parsed marker, or null on absent/garbage/unreadable — never throws.
export function readMarker(root = pluginDataDir()) {
  try {
    return JSON.parse(readFileSync(markerPath(root), 'utf8'));
  } catch {
    return null;
  }
}

// The cheap O(1) predicate ready.js composes on EVERY hook hot path: a JSON
// read + an ABI string compare + one package.json version compare per dep. NO
// probe, NO native import. Valid iff the marker exists, its recorded ABI equals
// the running Node's NODE_MODULE_VERSION, and every native dep's recorded
// version still equals what is installed on disk (a version bump from a
// reinstall must re-probe). ANY error — missing marker, garbage JSON,
// unreadable package.json, a bad `root` — degrades to false, never throws
// (preserves ready.js's "never throw → false" contract; see the garbage-root
// case in test/ready.test.js).
export function markerValid(root = pluginDataDir()) {
  try {
    const marker = readMarker(root);
    if (!marker || typeof marker !== 'object') return false;
    if (marker.abi !== process.versions.modules) return false;
    if (!marker.deps || typeof marker.deps !== 'object') return false;
    for (const dep of NATIVE_DEPS) {
      const installed = depVersion(root, dep);
      if (!installed || marker.deps[dep] !== installed) return false;
    }
    return true;
  } catch {
    return false;
  }
}

// Write the marker. Called ONLY by the install/setup path AFTER loadProbe()
// has actually exercised the native bindings — never on the hot path. Records
// the ABI + the on-disk dep versions + Node version + a timestamp. Returns
// true on success, false on any failure (a dep with no resolvable version is a
// failure — we must not vouch for what we cannot version). Never throws.
export function writeMarker(root = pluginDataDir()) {
  try {
    const deps = {};
    for (const dep of NATIVE_DEPS) {
      const v = depVersion(root, dep);
      if (!v) return false;
      deps[dep] = v;
    }
    const marker = {
      abi: process.versions.modules,
      deps,
      node: process.version,
      writtenAt: new Date().toISOString(),
    };
    writeFileSync(markerPath(root), JSON.stringify(marker, null, 2));
    return true;
  } catch {
    return false;
  }
}

// Best-effort, idempotent removal. Called when a hook's dynamic import throws a
// native-binding error (hook-shim) so the next session re-probes. A
// already-absent marker is not an error — must not throw.
export function invalidateMarker(root = pluginDataDir()) {
  try {
    unlinkSync(markerPath(root));
  } catch {
    /* already gone or unremovable — idempotent, swallow */
  }
}

// Classify a caught error as "the native binding failed to load for this Node
// ABI" vs an ordinary impl bug. Shape-based so it works regardless of WHERE
// the throw originated (the hook's `await import(implUrl)` module load OR a
// lazy `import('better-sqlite3')` inside mod.main()) — the shim does not need
// to know the source. A native-binding match ⇒ invalidate the marker + re-arm
// the bounded reinstall; anything else ⇒ leave the marker alone (no spurious
// reinstall thrash on a logic bug).
//
// Verified contract (WiseLibs/better-sqlite3 #1393, nodejs.org errors docs):
// modern Node sets err.code === 'ERR_DLOPEN_FAILED'; the code attribute name
// has varied across Node versions but the message has not — it always contains
// the NODE_MODULE_VERSION / "compiled against a different Node.js version"
// phrasing, or a bare dlopen failure mentions `dlopen` / `.node ... was
// compiled`. Matching code OR message is robust across Node versions.
const NATIVE_BINDING_MSG =
  /NODE_MODULE_VERSION|was compiled against a different Node\.js version|\bdlopen\b|\.node['"]?\s+was compiled/i;

export function isNativeBindingError(e) {
  if (!e) return false;
  if (e.code === 'ERR_DLOPEN_FAILED') return true;
  const msg = String((e && e.message) || e);
  return NATIVE_BINDING_MSG.test(msg);
}

// The expensive truth the marker stands in for: actually load better-sqlite3 +
// sqlite-vec and exercise the compiled binding (open an in-memory DB, load the
// vec extension, call a vec function). Run ONLY by the install/setup/worker
// path, never the hot path, and ONLY through a DYNAMIC import via the
// `importer` seam so the static dormancy graph stays clean and a unit test can
// inject a thrower without a genuinely broken binding. The seam default is
// native-require's loadNative — NOT a bare `import(spec)`, which would resolve
// against the ephemeral PLUGIN_ROOT (no node_modules in a marketplace install)
// and fail even after a successful `npm install` into the persistent data dir,
// leaving the marker forever unwritten and the plugin permanently dormant.
// loadNative resolves from ${CLAUDE_PLUGIN_DATA}/node_modules (see
// native-require.js), so this mirrors lib/store.js's native-load sequence
// exactly: loadNative('better-sqlite3') → `.default` is the Database
// constructor (same as loadNativeDefault), loadNative('sqlite-vec') → the
// namespace whose `.load` loads the extension. Never throws — returns
// {ok:true} | {ok:false, error}.
export async function loadProbe({ importer = loadNative } = {}) {
  let db;
  try {
    const betterSqlite3 = await importer('better-sqlite3');
    const Database = betterSqlite3.default || betterSqlite3;
    const sqliteVec = await importer('sqlite-vec');
    db = new Database(':memory:');
    sqliteVec.load(db);
    db.prepare('select vec_version()').get();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  } finally {
    try { if (db) db.close(); } catch { /* close failure is irrelevant to probe result */ }
  }
}

// THE convergent success-tail both install entrypoints share — the detached
// worker (scripts/install-worker.js#main) and the synchronous /mindwright:setup
// path (lib/auto-setup.js#runInstallSync). They reach "the install is done" by
// different runners (async vs sync npm, different result shapes) and keep their
// own probe schedule + lock lifecycle, but the FINAL decision is identical and
// is EXACTLY what drifted once and caused the implementation-2/correctness-1
// silent-dormancy bug (the worker wrote the marker on a partial install the
// sync path would have rejected): write the ABI marker IFF a real load-probe
// passes, and NEVER throw doing it. A failed probe OR a failed marker write
// must leave depsInstalled() false so a later session retries — the marker
// must never vouch for a binding that did not load. One source of truth so the
// two paths cannot diverge again.
//
// `probeResult` lets install-worker pass the probe it ALREADY ran (it probes
// on its own schedule for the manifest-drift decision and a test asserts its
// exact probe count, so it must NOT be re-probed here); omit it (undefined) and
// the probe runs here — the runInstallSync shape. loadProbe never returns
// undefined, so the `undefined` sentinel cannot collide with a real result.
// probe/writeHealthMarker stay injectable seams (both call sites already expose
// them for hermetic tests). Returns whether the marker was written.
export async function probeAndMarkIfOk(
  probeResult,
  { probe = loadProbe, writeHealthMarker = writeMarker } = {},
) {
  try {
    const p = probeResult === undefined ? await probe() : probeResult;
    if (p && p.ok) {
      writeHealthMarker();
      return true;
    }
  } catch {
    /* best-effort: a failed probe or marker write leaves depsInstalled()
       false so a later session retries — never vouch for a binding that
       did not load */
  }
  return false;
}
