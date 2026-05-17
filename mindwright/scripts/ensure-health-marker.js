#!/usr/bin/env node
// npm `pretest` script: write the ABI health marker via the real production
// contract (loadProbe → writeMarker) so spawned-entrypoint tests don't go
// dormant on a dev tree whose node_modules predates the marker-writing path.
// Reproducing the precondition through the SAME code path (not a test-only
// branch in the gate) keeps test logic out of production.
//
// Always exits 0: a non-zero exit aborts `npm test` entirely, which would
// wrongly block the deps-less dormancy suite on a machine with no native
// deps. Probe can't pass ⇒ marker not written, dependent tests fail visibly.
//
// Statically dep-free (loadProbe's native import is DYNAMIC) so it never
// crashes on a deps-less copy.

import { pathToFileURL } from 'node:url';
import { markerValid, loadProbe, writeMarker } from '../lib/health-marker.js';

function warn(msg) {
  process.stderr.write(`[mindwright:ensure-health-marker] ${msg}\n`);
}

async function main() {
  // Valid current marker ⇒ bindings already loaded under this ABI/dep-set.
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

// Only run when invoked directly (the pretest spawn), not if a test imports it.
const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main()
    .catch((err) => {
      // Never abort `npm test`. Log and exit 0.
      warn(`unexpected error (swallowed): ${err && err.stack ? err.stack : err}`);
    })
    .finally(() => process.exit(0));
}
