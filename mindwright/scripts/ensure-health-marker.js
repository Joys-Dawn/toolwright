#!/usr/bin/env node
// Ensure the ABI health marker exists for the LOCAL installed tree, via the
// exact production contract (loadProbe → writeMarker). Wired as the npm
// `pretest` lifecycle script so `npm test` establishes the readiness
// precondition the same way production does, before `node --test` forks any
// worker.
//
// WHY THIS EXISTS: lib/ready.js#depsInstalled now requires a marker valid for
// the running Node ABI (not just the dep dirs). In production that marker is
// written by the install/setup path after a real load-probe. The dev tree's
// node_modules predates that path, so it has no marker — and ~100 tests spawn
// the REAL entrypoints as child processes resolving PLUGIN_ROOT to this tree;
// without a marker every one goes dormant. This script reproduces the
// precondition through the SAME code path production uses (NOT a test-only
// branch in the gate — that would be the "test logic in production" /
// security-backdoor anti-pattern). The marker it writes is the genuine
// artifact: gitignored, ABI/version-stamped, self-invalidating on a Node or
// dep change — correct to leave in place, not test residue. Useful outside
// tests too: it's "attest the installed bindings load under this Node",
// exactly what a dev wants after `npm install`.
//
// Best-effort by contract: it ALWAYS exits 0. A non-zero exit would abort
// `npm test` entirely (npm: "exits with a code other than 0 … will abort the
// process"), which would wrongly block the deps-less dormancy suite on a
// machine with no native deps. If the probe can't pass, the marker is simply
// not written, the dependent tests fail visibly with the dormant notice
// (informative, not silent), and the copied-tree dormancy tests still pass.
//
// Statically dep-free (health-marker.js + paths.js are dep-free; loadProbe's
// native import is DYNAMIC), so it never crashes on a deps-less copy. Not in
// the hook-shim ENTRYPOINTS dormancy list because it is NOT auto-fired by
// Claude Code — it is a manual/npm-lifecycle script (same posture as
// scripts/setup-impl.js, which is likewise not an auto-firing entrypoint).

import { pathToFileURL } from 'node:url';
import { markerValid, loadProbe, writeMarker } from '../lib/health-marker.js';

function warn(msg) {
  process.stderr.write(`[mindwright:ensure-health-marker] ${msg}\n`);
}

async function main() {
  // Idempotent fast path: a valid current marker means the bindings already
  // loaded under this exact ABI/dep-set — nothing to do (skips even the
  // ~12ms probe on every repeat `npm test`).
  if (markerValid()) return;

  const r = await loadProbe();
  if (!r.ok) {
    warn(
      `native binding load-probe failed (${r.error || 'unknown'}); marker NOT written. `
        + 'Deps-present feature tests will show the dormant notice; the deps-less '
        + 'dormancy suite still passes. Run `npm install` / /mindwright:setup if this is unexpected.',
    );
    return;
  }

  if (!writeMarker()) {
    warn('load-probe succeeded but writing the health marker failed; marker NOT written.');
    return;
  }
}

// Only run when invoked directly (the pretest spawn), not if a test imports
// it — mirrors scripts/seed-from-repo.js / scripts/seed-loop.js.
const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main()
    .catch((err) => {
      // Best-effort: never abort `npm test`. Log and exit 0.
      warn(`unexpected error (swallowed): ${err && err.stack ? err.stack : err}`);
    })
    .finally(() => process.exit(0));
}
