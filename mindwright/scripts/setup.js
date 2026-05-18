#!/usr/bin/env node
// /mindwright:setup — dependency-free shim. The one-stop "make it work"
// command: install native deps SYNCHRONOUSLY (the user invoked setup and
// expects it to take minutes, so blocking is the right UX here — unlike the
// hooks), then hand off to scripts/setup-impl.js.
//
// setup-impl.js statically imports lib/models.js, so it is loaded via dynamic
// import ONLY after deps are present.

import { pathToFileURL } from 'node:url';
import { depsInstalled } from '../lib/ready.js';
import { runInstallSync, installLogPath } from '../lib/auto-setup.js';

// depsCheck/install are a test seam so the three process.exit(1) failure
// paths (background install in progress; install FAILED; npm-ok-but-deps-
// still-unresolvable) are reachable without a real npm install. Defaults are
// the real implementations → production behavior unchanged.
export async function run({ depsCheck = depsInstalled, install = runInstallSync } = {}) {
  if (!depsCheck()) {
    process.stderr.write(
      '[mindwright:setup] native dependencies not installed — installing them now '
        + '(one-time; a few minutes if better-sqlite3 compiles from source)...\n',
    );
    const r = await install();
    if (r.pending) {
      // A background install holds the single-flight lock; a second
      // `npm install` into the same node_modules would corrupt it. Not a
      // failure — in progress; the user re-runs once it finishes.
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

// Only auto-run when invoked directly, not on import — importing must not
// trigger the real install/model-download path.
const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  run().catch((err) => {
    process.stderr.write(`[mindwright:setup] FAILED: ${err && err.stack ? err.stack : err}\n`);
    process.exit(1);
  });
}
