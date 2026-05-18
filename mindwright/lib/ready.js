// Dependency-free readiness gate.
//
// Native deps (better-sqlite3, sqlite-vec, transformers.js) are NOT vendored —
// `npm ci` runs once into the persistent data dir. Until then (fresh
// install, dep bump, or Node upgrade staling the binding) they're absent or
// unloadable. Every auto-firing entrypoint checks this dep-free predicate
// FIRST so a not-yet-ready copy stays dormant (and kicks off a background
// install) instead of crash-spamming.
//
// HARD RULE: this file and everything it imports depend on nothing but `node:`
// builtins (its lib/paths.js + lib/health-marker.js imports are dep-free).
// Any import that transitively pulls a native dep defeats the gate.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  pluginDataDir,
  embedderCached,
  bundledManifestPath,
  installedManifestPath,
} from './paths.js';
import { markerValid } from './health-marker.js';
import { NATIVE_DEPS } from './constants.js';

// True iff the persistent node_modules holds the native deps, a health marker
// valid for the RUNNING Node ABI exists, AND the installed dependency set
// still matches what this plugin version bundles. Three parts, all necessary:
//
//   (a) Directory existence (not a `.node` artifact probe) — sqlite-vec ships
//       per-platform prebuilt sibling packages and better-sqlite3's artifact
//       path varies by prebuild-vs-compile, so an artifact check is
//       cross-platform fragile and false-negatives on a good install.
//   (b) markerValid(root) — dirs present does NOT prove the binding loads
//       under THIS Node: after a Node upgrade the .node is ABI-stale and every
//       dynamic import throws ERR_DLOPEN_FAILED forever. The marker is stamped
//       with process.versions.modules + dep versions, so a Node bump (or a
//       version change) auto-invalidates it ⇒ this flips false ⇒ self-heal.
//   (c) manifestUpToDate() — (b) only re-probes the ABI of deps ALREADY on
//       disk; it can't see a plugin update bumping a version (node_modules +
//       marker still hold the OLD set until reinstall). This diffs the
//       bundled vs installed dependency contract to catch that drift.
//
// The expensive load-probe lives in the install path, NEVER here: this is on
// every hook hot path and stays O(1). Every sub-check degrades to false and
// never throws; the try/catch is belt-and-suspenders.
export function depsInstalled(root = pluginDataDir()) {
  try {
    const nm = join(root, 'node_modules');
    const dirsPresent = NATIVE_DEPS.every((d) => existsSync(join(nm, d)));
    return dirsPresent && markerValid(root) && manifestUpToDate();
  } catch {
    return false;
  }
}

// Bundled-vs-installed dependency-contract diff closing markerValid()'s blind
// spot (depsInstalled part (c)). Compared at `dependencies` granularity and
// order-independent, so a pure plugin version bump (no dep change) does NOT
// force a needless reinstall. A missing installed copy ⇒ false (never
// installed here yet). Never throws — degrades to false.
export function manifestUpToDate(
  bundledPath = bundledManifestPath(),
  installedPath = installedManifestPath(),
) {
  try {
    const fingerprint = (p) => {
      const deps = JSON.parse(readFileSync(p, 'utf8')).dependencies || {};
      return Object.keys(deps)
        .sort()
        .map((k) => `${k}@${deps[k]}`)
        .join('\n');
    };
    return fingerprint(bundledPath) === fingerprint(installedPath);
  } catch {
    return false;
  }
}

// Pass-through to the single source of truth in lib/paths.js (also honors the
// MINDWRIGHT_USE_STUB_MODELS=1 test escape hatch).
export function modelsReady() {
  return embedderCached();
}

// Human-reporting predicate (status, setup) — NOT the crash gate. The
// entrypoint crash gate is depsInstalled() ALONE: missing models is a designed
// degradation (hooks still capture NULL-embedding rows; the sweeper backfills;
// embedderCached() gates the self-recall surfaces). Folding models in here
// would regress that progressive behavior.
export function isReady(root = pluginDataDir()) {
  return depsInstalled(root) && modelsReady();
}
