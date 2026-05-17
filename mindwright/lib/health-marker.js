// ABI-stamped health marker — single source of truth for "the native deps not
// just PRESENT but actually LOAD under the running Node ABI". A "dir exists"
// check lies after a Node upgrade: better-sqlite3's `.node` was built against
// the old NODE_MODULE_VERSION, so every `import('better-sqlite3')` throws
// ERR_DLOPEN_FAILED and the plugin is permanently, silently dormant. The
// marker is a capability token written ONLY after a real load-probe succeeds;
// a Node bump changes process.versions.modules so it stops matching and the
// existing self-heal reinstalls. Zero user action.
//
// HARD DEP-FREE RULE (same contract as ready.js, which imports markerValid
// from here): this module's STATIC import graph must contain NO bare-npm
// import. loadProbe() is the only code that loads a native package, and only
// through the dynamic-import seam (default = native-require's loadNative).
// Adding any static bare-npm import here re-breaks every entrypoint on a
// deps-less copy.

import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { pluginDataDir } from './paths.js';
import { NATIVE_DEPS } from './constants.js';
import { loadNative } from './native-require.js';

// NATIVE_DEPS comes from constants.js (the single dep-free source both
// readiness predicates compose) — NOT from ready.js, which would be circular.

// Lives next to node_modules in the persistent data dir, alongside the deps it
// vouches for.
export function markerPath(root = pluginDataDir()) {
  return join(root, 'node_modules', '.mindwright-health.json');
}

// Throws on a missing/garbage package.json so callers' try/catch treats
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

// The cheap O(1) predicate ready.js composes on EVERY hook hot path — no
// probe, no native import. Valid iff the marker exists, its recorded ABI
// equals the running Node's NODE_MODULE_VERSION, and every dep's recorded
// version still equals what is installed on disk. Any error degrades to false,
// never throws (preserves ready.js's "never throw → false" contract).
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

// Called ONLY by the install/setup path AFTER loadProbe() exercised the
// bindings — never on the hot path. False (never throws) on any failure; a dep
// with no resolvable version is a failure — must not vouch for what we cannot
// version.
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

// Idempotent removal. Called when a hook's dynamic import throws a
// native-binding error so the next session re-probes. Must not throw.
export function invalidateMarker(root = pluginDataDir()) {
  try {
    unlinkSync(markerPath(root));
  } catch {
    /* already gone or unremovable — idempotent, swallow */
  }
}

// Classify a caught error as "native binding failed to load for this Node ABI"
// vs an ordinary impl bug. Shape-based so it works regardless of WHERE the
// throw originated. A match ⇒ invalidate the marker + re-arm the reinstall;
// anything else ⇒ leave the marker alone (no reinstall thrash on a logic bug).
// err.code varies across Node versions but the message does not, so match code
// OR message.
const NATIVE_BINDING_MSG =
  /NODE_MODULE_VERSION|was compiled against a different Node\.js version|\bdlopen\b|\.node['"]?\s+was compiled/i;

export function isNativeBindingError(e) {
  if (!e) return false;
  if (e.code === 'ERR_DLOPEN_FAILED') return true;
  const msg = String((e && e.message) || e);
  return NATIVE_BINDING_MSG.test(msg);
}

// The expensive truth the marker stands in for: actually load better-sqlite3 +
// sqlite-vec and exercise the compiled binding. Run ONLY by the
// install/setup/worker path, and ONLY through the DYNAMIC `importer` seam so
// the static dormancy graph stays clean and tests can inject a thrower. The
// default is native-require's loadNative — NOT a bare `import(spec)`, which
// would resolve against the ephemeral PLUGIN_ROOT (no node_modules in a
// marketplace install) and fail even after a successful install into the
// persistent data dir, leaving the marker forever unwritten. Never throws.
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

// THE convergent success-tail both install entrypoints share (the detached
// worker and the synchronous /mindwright:setup path). They reach "install
// done" by different runners but the FINAL decision must be identical: write
// the ABI marker IFF a real load-probe passes, and NEVER throw doing it. A
// failed probe OR marker write must leave depsInstalled() false so a later
// session retries — the marker must never vouch for a binding that did not
// load. One source of truth so the two paths cannot diverge.
//
// `probeResult` lets install-worker pass a probe it ALREADY ran (must NOT be
// re-probed here); omit it (undefined) and the probe runs here. loadProbe
// never returns undefined so the sentinel cannot collide with a real result.
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
