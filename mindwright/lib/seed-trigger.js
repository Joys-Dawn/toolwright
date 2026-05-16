// Transcript-bootstrap auto-trigger: the gate + the detached spawn.
//
// HOSTED BY SessionStart (hooks/session-start.js#main), NOT Stop. This is
// load-bearing and the whole reason this logic is its own module:
//
//   shouldAutoSeed's empty-memory precondition is only observable BEFORE the
//   session's first live flush. Stop runs flushTranscript (its step 1) AND is
//   preceded within the same turn by UserPromptSubmit + PreToolUse, both of
//   which already flushed transcript chunks into short-term. By the first
//   Stop, countByTier().short is non-zero, so the gate could NEVER fire in the
//   documented fresh-install flow — the marquee "a fresh install learns from
//   your project's history" feature was a silent no-op (behavior-1). A
//   pre-flush snapshot at the top of Stop is also insufficient (UPS/PreToolUse
//   wrote rows earlier in the turn). SessionStart is the only point genuine
//   install-time emptiness is observable: it runs before any hook in the turn
//   touches the transcript.
//
// Shared with the cap-nudge path: isConsolidatorSession is the SAME self-spawn
// guard hooks/stop.js#handleCapCheck uses (imported back there), so the guard
// has one definition, not two.

import { readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { logHookError } from './hook-log.js';
import { transcriptsDir, PLUGIN_ROOT } from './paths.js';

// Self-spawn guard. Two signals — either is sufficient. The env-var sentinel
// is the PRIMARY signal: `consolidator-spawn.js` exports
// CONSOLIDATOR_SPAWN_ENV_OVERRIDES = { MINDWRIGHT_IS_CONSOLIDATOR: '1' } and
// passes it on every detached spawn. Env inherits down the `claude --bg`
// supervisor chain, so a consolidator session sees it on every hook. The
// role-set check is the secondary signal for sessions where assign_role was
// explicitly invoked (e.g. an interactive `/mindwright:assign-role
// consolidator`).
//
// Without this guard, the consolidator the seed loop spawns would itself
// re-enter the auto-seed gate (re-entrancy), and every Stop in a consolidator
// session would spawn another consolidator with a fresh UUID → different
// deriveHandle → meta:consolidator_for dedupe miss → unbounded chain of orphan
// `claude --bg` supervisors that survive parent death. (Observed in production
// 2026-05-13: a single test run spawned a chain of 16+ supervisors over ~10
// minutes.)
export function isConsolidatorSession(store, sessionId) {
  if (process.env.MINDWRIGHT_IS_CONSOLIDATOR === '1') return true;
  try { return store.getRoles(sessionId).includes('consolidator'); } catch { return false; }
}

// Pure gate for the transcript-bootstrap auto-trigger. Exported so the
// regression-prone part — the four AND-ed preconditions — is unit-testable
// without spawning anything. ALL must hold:
//   1) MINDWRIGHT_AUTO_SEED is not the literal 'false' (default ON; the only
//      opt-out is `=false`, per DESIGN.md "Bootstrap").
//   2) This session is NOT itself a consolidator/seed session — the existing
//      verified self-spawn guard (env sentinel OR consolidator role). Without
//      it the consolidator the seed loop spawns would itself re-trigger
//      seeding (re-entrancy). Same guard the cap-spawn path uses.
//   3) Memory is empty: zero active long-term AND zero active short-term
//      rows. This is the self-limiting precondition — the instant the seed
//      loop writes its first short row this is false, so the trigger cannot
//      re-fire mid-bootstrap (no new lock primitive needed; plan's
//      re-entrancy mitigation). Evaluating this at SessionStart (before the
//      turn's first flush) is what makes "empty" observable at all — see the
//      module header for why Stop could never satisfy it (behavior-1).
//   4) At least one `*.jsonl` transcript exists for this project — there is
//      something to bootstrap from.
//
// Deliberately INDEPENDENT of MINDWRIGHT_NUDGE: a user who silenced nudges
// still wants their memory bootstrapped.
export function shouldAutoSeed(store, sessionId, txDir) {
  if (process.env.MINDWRIGHT_AUTO_SEED === 'false') return false;
  if (isConsolidatorSession(store, sessionId)) return false;
  let counts;
  try {
    counts = store.countByTier();
  } catch {
    return false;
  }
  if ((counts.short || 0) !== 0 || (counts.long || 0) !== 0) return false;
  try {
    return readdirSync(txDir).some((n) => n.endsWith('.jsonl'));
  } catch {
    // No transcript dir for this project (the common case on a brand-new
    // machine) — nothing to bootstrap.
    return false;
  }
}

// Fire-and-forget the bootstrap. Detached + unref'd so it never blocks
// SessionStart or dies with the hook process — exactly the consolidator-spawn
// posture. The heavy ingest lives in scripts/seed-loop.js (its own store
// handle); we only decide and launch. Any failure is logged and swallowed —
// auto-seed must never disrupt session start.
export function maybeAutoSeed(store, sessionId) {
  try {
    if (!shouldAutoSeed(store, sessionId, transcriptsDir())) return;
    // Test seam: suppress the actual detached spawn while still exercising
    // the gate (mirrors MINDWRIGHT_SPAWN_DISABLE for the consolidator).
    if (process.env.MINDWRIGHT_SEED_LOOP_DISABLE === '1') return;
    const script = join(PLUGIN_ROOT, 'scripts', 'seed-loop.js');
    const child = spawn(process.execPath, [script, sessionId], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env },
    });
    try { child.unref(); } catch { /* */ }
  } catch (e) {
    logHookError('session-start', 'auto-seed spawn failed', e);
  }
}
