#!/usr/bin/env node
// Spawnable entrypoint for the transcript-bootstrap loop.
//
// The SessionStart auto-seed check (hooks/session-start.js#main →
// lib/seed-trigger.js#maybeAutoSeed) launches this DETACHED and fire-and-forget
// on a fresh empty install with local transcripts present (the gate must run
// before the turn's first flush — see lib/seed-trigger.js header / behavior-1).
// It is intentionally a tiny wrapper: all the real work
// (enumerate → bounded chunk → short seed rows → resumable offsets) lives in
// lib/seed-loop.js so it stays unit-testable without a process spawn.
//
// `consolidate` is the real backpressure waiter from lib/seed-consolidate.js:
// it spawns the EXISTING verified `claude --bg` consolidator
// (lib/consolidator-spawn.js, idempotent per (project, requesterHandle) — the
// same deterministic session every call) and then BLOCKS until short-term has
// actually drained back under the byte budget before letting the loop ingest
// more, re-spawning further single-flight dream passes as needed. Without that
// wait the documented "short-term never holds the whole corpus" bound is a lie
// and a detached consolidator is launched per budget boundary
// (implementation-2 / correctness-1). This is the DESIGN.md "auto-seed by
// folding into consolidation, not a separate code path" principle: the seed
// loop only produces short rows; the unchanged dream cycle distills them —
// just with real flow-control between batches.

import { pathToFileURL } from 'node:url';
import { logHookError } from '../lib/hook-log.js';
import { depsInstalled } from '../lib/ready.js';

async function main() {
  // Defensive dependency gate. This script is only spawned by maybeAutoSeed
  // AFTER the SessionStart shim confirmed deps are present, so this branch
  // should not normally fire — but a node_modules wipe racing the detached
  // spawn must degrade to a clean no-op, never an ESM-load crash. (No
  // maybeAutoInstall here: the caller path already owns triggering the
  // install; this is purely a crash guard.)
  if (!depsInstalled()) {
    process.stdout.write(JSON.stringify({ ok: false, error: 'deps_not_installed' }) + '\n');
    return;
  }
  const { openStore } = await import('../lib/store.js');
  const { runSeedLoop } = await import('../lib/seed-loop.js');
  const { makeSeedConsolidate } = await import('../lib/seed-consolidate.js');
  const { deriveHandle } = await import('../lib/handles.js');

  // argv[2] is the triggering session's id (passed by SessionStart) so the
  // consolidator identity matches the one the cap-nudge path would resolve —
  // same (project, requesterHandle) ⇒ one consolidator, not two.
  const sessionId = process.argv[2] || 'seed-loop';
  const store = openStore();
  try {
    const requesterHandle = deriveHandle(sessionId);
    // Real backpressure: spawn the consolidator AND block until short-term has
    // drained back under the budget before the loop ingests more. A failed
    // spawn (no CLI / MINDWRIGHT_SPAWN_DISABLE) degrades to "continue without
    // waiting" inside makeSeedConsolidate — the seeded rows persist and a
    // later cap-nudge / manual dream drains them; it never aborts the loop.
    const consolidate = makeSeedConsolidate({ store, requesterHandle });

    const summary = await runSeedLoop({ store, consolidate });
    process.stdout.write(JSON.stringify({ ok: true, ...summary }) + '\n');
  } finally {
    store.close();
  }
}

// Only run main() when executed directly (the detached spawn), not when a test
// imports nothing from here — mirrors scripts/seed-from-repo.js's guard.
const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((err) => {
    try { logHookError('seed-loop', 'crashed', err); } catch { /* best-effort */ }
    process.stderr.write(`mindwright seed-loop crashed: ${err.message}\n${err.stack || ''}\n`);
    process.exit(1);
  });
}
