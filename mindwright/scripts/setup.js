#!/usr/bin/env node
// /mindwright:setup — dependency-free shim.
//
// The one-stop "make it work" command. If the native deps aren't installed
// yet (fresh marketplace copy, or a plugin update wiped node_modules), install
// them SYNCHRONOUSLY here — the user explicitly invoked setup and expects it
// to take a while (the model download alone is minutes), so blocking is the
// right UX, unlike the hooks which must never block. Then hand off to
// scripts/setup-impl.js for the model download + smoke test.
//
// setup-impl.js statically imports lib/models.js (→ @huggingface/transformers),
// so it is loaded via dynamic import ONLY after deps are present. See
// lib/ready.js for the gate rationale.

import { pathToFileURL } from 'node:url';
import { depsInstalled } from '../lib/ready.js';
import { runInstallSync, installLogPath } from '../lib/auto-setup.js';

// depsCheck/install are a test seam (same shape as runHookShim's, and paired
// with the invokedDirectly guard below — mirroring scripts/status.js). The
// deps-absent sync-install gate and its three process.exit(1) paths (a
// background install already in progress; install FAILED; npm-ok-but-deps-
// still-unresolvable) are the user's primary failure messaging for the
// one-stop setup command; without injection the deps-unresolvable exit is only
// reachable via a real npm install or a flaky filesystem race. Defaults are
// the real implementations → production behavior is unchanged.
export async function run({ depsCheck = depsInstalled, install = runInstallSync } = {}) {
  if (!depsCheck()) {
    process.stderr.write(
      '[mindwright:setup] native dependencies not installed — installing them now '
        + '(one-time; a few minutes if better-sqlite3 compiles from source)...\n',
    );
    const r = await install();
    if (r.pending) {
      // A detached background install holds the single-flight lock — running a
      // second `npm install` into the same node_modules would corrupt it, so
      // this is NOT a failure: it is in progress. Honest message, clean exit;
      // the user re-runs once it has finished.
      process.stderr.write(`[mindwright:setup] ${r.error}\n`);
      process.exit(1);
    }
    if (!r.ok) {
      process.stderr.write(`[mindwright:setup] dependency install FAILED: ${r.error}\n`);
      process.stderr.write(`[mindwright:setup] install log (if any): ${installLogPath()}\n`);
      process.exit(1);
    }
    if (!depsCheck()) {
      process.stderr.write(
        '[mindwright:setup] npm install reported success but the native deps still are not resolvable — '
          + 'check the npm output above.\n',
      );
      process.exit(1);
    }
    process.stderr.write('[mindwright:setup] dependencies installed; continuing to model download...\n');
  }
  const mod = await import(new URL('./setup-impl.js', import.meta.url).href);
  await mod.main();
}

// Only auto-run when invoked directly (e.g. via the /mindwright:setup skill),
// not when imported for unit testing — importing this module must not trigger
// the real install/model-download path.
const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  run().catch((err) => {
    process.stderr.write(`[mindwright:setup] FAILED: ${err && err.stack ? err.stack : err}\n`);
    process.exit(1);
  });
}
