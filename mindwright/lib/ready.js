// Dependency-free readiness gate.
//
// The plugin's native deps (better-sqlite3, sqlite-vec, the MCP SDK,
// transformers.js) are NOT vendored — `npm install` has to run once into the
// PERSISTENT plugin data dir (${CLAUDE_PLUGIN_DATA}/node_modules, which
// survives plugin updates). Before that has happened (a fresh install), or
// after a plugin update bumps a dependency, or after a Node upgrade staled the
// compiled binding, the deps are absent or unloadable. Every auto-firing
// entrypoint (the 6 hooks, the MCP server, the spawnable scripts) loads its
// native deps through lib/native-require.js; behind the shim each one checks
// this dependency-free predicate FIRST, so a not-yet-ready copy stays dormant
// (and kicks off a background `npm install`) instead of crash-spamming.
//
// HARD RULE: this file and everything it imports must depend on nothing but
// `node:` builtins. It imports lib/paths.js and lib/health-marker.js, both
// dep-free (paths.js: node:url/path/os/fs + lib/constants.js which has zero
// imports; health-marker.js: node:fs/path + paths.js, its only native touch is
// loadProbe's DYNAMIC import which never enters this static graph). Adding any
// import that transitively pulls a native dep defeats the entire gate.

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

// The ABI-locked native packages (better-sqlite3 + sqlite-vec) whose
// node_modules-dir presence is one of the three parts of depsInstalled().
// Single source of truth — with the full necessary-and-cheapest / ABI
// rationale — is lib/constants.js#NATIVE_DEPS; health-marker.js's marker check
// composes the SAME imported list, so the readiness predicates cannot drift.

// True iff the persistent ${CLAUDE_PLUGIN_DATA}/node_modules holds the native
// deps, a health marker valid for the RUNNING Node ABI exists, AND the
// installed dependency set still matches what this plugin version bundles.
// Three parts, all necessary:
//
//   (a) Directory existence (not a probe for the compiled `.node` artifact) —
//       deliberate: sqlite-vec ships per-platform prebuilt sibling packages and
//       better-sqlite3's artifact path varies by prebuild-vs-compile, so an
//       artifact-level check is cross-platform fragile and would false-negative
//       on a perfectly good install.
//   (b) markerValid(root) — the dirs being present does NOT prove the binding
//       loads under THIS Node: after a Node upgrade the .node is ABI-stale and
//       every entrypoint's dynamic import throws ERR_DLOPEN_FAILED forever
//       (implementation-2 / correctness-2). The marker is written by the
//       install/setup path ONLY after an actual load-probe and is stamped with
//       process.versions.modules + dep versions, so a Node bump (or a reinstall
//       that changed a version) auto-invalidates it ⇒ this flips false ⇒ the
//       existing self-heal reinstalls ⇒ a fresh probe rewrites it.
//   (c) manifestUpToDate() — (b) only re-probes the ABI of the deps ALREADY on
//       disk; it cannot see that a plugin update bumped a version, because
//       node_modules (and the marker stamped from it) still hold the OLD set
//       until a reinstall runs. This diffs the bundled vs installed dependency
//       contract so that drift — including the non-ABI deps the marker ignores
//       (MCP SDK, transformers.js) — flips the gate false and triggers the
//       self-heal. See its own comment for the granularity rationale.
//
// The expensive load-probe lives in the install path, NEVER here: this is on
// every hook hot path and stays O(1) (a few existsSync + two small JSON reads
// + string compares). Every sub-check degrades to false and never throws; the
// try/catch is belt-and-suspenders. The `root` seam is passed to (a)+(b);
// manifestUpToDate() resolves the fixed bundled/installed manifest paths.
export function depsInstalled(root = pluginDataDir()) {
  try {
    const nm = join(root, 'node_modules');
    const dirsPresent = NATIVE_DEPS.every((d) => existsSync(join(nm, d)));
    return dirsPresent && markerValid(root) && manifestUpToDate();
  } catch {
    return false;
  }
}

// The bundled-vs-installed dependency-contract diff that closes markerValid()'s
// blind spot (see depsInstalled part (c)). The bundled package.json ships in
// the ephemeral PLUGIN_ROOT and is the source of truth for what SHOULD be
// installed; the install path copies it verbatim into the persistent data dir
// after a successful install. They diverge exactly when a plugin update has
// changed dependencies but the reinstall hasn't run yet — the one window
// markerValid() cannot see (node_modules + marker still describe the OLD set).
// Compared at `dependencies` granularity and order-independent, so a pure
// version-string bump of the plugin itself (no dep change) does NOT force a
// needless reinstall every session. Dep-free (JSON.parse + node:fs). A missing
// installed copy ⇒ false (never successfully installed here yet). The two path
// args are a test seam mirroring the `root` seam on the other predicates;
// production always uses the real bundled/installed manifest locations. Never
// throws — degrades to false, preserving the gate's "never throw" contract.
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

// Whether the embedder model is cached on disk. Models live in
// ~/.cache/huggingface (NOT the plugin dir), so they survive plugin updates
// and only ever download once. Thin pass-through to the single source of truth
// in lib/paths.js so callers have one readiness vocabulary; it also honors the
// MINDWRIGHT_USE_STUB_MODELS=1 test escape hatch.
export function modelsReady() {
  return embedderCached();
}

// Fully operational: deps installed AND models cached. This is the
// human-reporting predicate (status, setup) — NOT the crash gate.
//
// The crash gate the entrypoints use is `depsInstalled()` ALONE. Missing
// models is a pre-existing, designed degradation (hooks still capture
// short-term rows with NULL embeddings; the daemon's sweeper backfills later;
// embedderCached() already gates the self-recall surfaces). Folding models
// into the entrypoint gate would make a deps-present/models-absent install go
// fully dormant and REGRESS that intended progressive behavior.
export function isReady(root = pluginDataDir()) {
  return depsInstalled(root) && modelsReady();
}
