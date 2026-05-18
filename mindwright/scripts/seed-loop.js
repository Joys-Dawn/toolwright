#!/usr/bin/env node
// Spawnable entrypoint for the transcript-bootstrap loop, invoked via the
// seed-from-repo path. A tiny wrapper: the real work (enumerate → bounded
// chunk → short seed rows → resumable offsets) lives in lib/seed-loop.js so
// it stays unit-testable without a process spawn.
//
// `consolidate` is the backpressure waiter from lib/seed-consolidate.js: it
// spawns the idempotent `claude --bg` consolidator and BLOCKS until
// short-term has drained back under the byte budget before the loop ingests
// more, so the "short-term never holds the whole corpus" bound holds and a
// consolidator is not launched per budget boundary.

import { pathToFileURL } from 'node:url';
import { logHookError } from '../lib/hook-log.js';
import { depsInstalled } from '../lib/ready.js';

async function main() {
  // Defensive dependency gate: the caller already confirmed deps, but a
  // node_modules wipe racing this must degrade to a clean no-op, never an
  // ESM-load crash. (No maybeAutoInstall: the caller owns triggering it;
  // this is purely a crash guard.)
  if (!depsInstalled()) {
    process.stdout.write(JSON.stringify({ ok: false, error: 'deps_not_installed' }) + '\n');
    return;
  }
  const { openStore } = await import('../lib/store.js');
  const { runSeedLoop } = await import('../lib/seed-loop.js');
  const { makeSeedConsolidate } = await import('../lib/seed-consolidate.js');
  const { deriveHandle } = await import('../lib/handles.js');

  // argv[2] is the triggering session's id so the consolidator identity
  // matches what the cap-nudge path resolves — same (project,
  // requesterHandle) ⇒ one consolidator, not two.
  const sessionId = process.argv[2] || 'seed-loop';
  const store = openStore();
  try {
    const requesterHandle = deriveHandle(sessionId);
    // A failed consolidator spawn degrades to "continue without waiting"
    // inside makeSeedConsolidate — the seeded rows persist for a later
    // cap-nudge / manual dream; it never aborts the loop.
    const consolidate = makeSeedConsolidate({ store, requesterHandle });

    const summary = await runSeedLoop({ store, consolidate });
    process.stdout.write(JSON.stringify({ ok: true, ...summary }) + '\n');
  } finally {
    store.close();
  }
}

// Only run main() when executed directly (the detached spawn), not on import.
const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((err) => {
    try { logHookError('seed-loop', 'crashed', err); } catch { /* best-effort */ }
    process.stderr.write(`mindwright seed-loop crashed: ${err.message}\n${err.stack || ''}\n`);
    process.exit(1);
  });
}
