// Consolidator self-spawn guard.
//
// This module historically also hosted the SessionStart transcript-bootstrap
// auto-trigger (shouldAutoSeed / maybeAutoSeed). That automatic path has been
// removed: seeding is now manual only (the `/mindwright:seed-from-repo` skill).
// What remains is the one piece the Stop hook still needs — the guard that
// recognizes "this session is itself a consolidator" so the cap-nudge path in
// hooks/stop.js#handleCapCheck does not spawn a consolidator from inside a
// consolidator.
//
// Two signals — either is sufficient. The env-var sentinel is the PRIMARY
// signal: lib/consolidator-spawn.js exports
// CONSOLIDATOR_SPAWN_ENV_OVERRIDES = { MINDWRIGHT_IS_CONSOLIDATOR: '1' } and
// passes it on every detached spawn. Env inherits down the `claude --bg`
// supervisor chain, so a consolidator session sees it on every hook. The
// role-set check is the secondary signal for sessions where assign_role was
// explicitly invoked (e.g. an interactive `/mindwright:assign-role
// consolidator`).
//
// Without this guard, every Stop in a consolidator session would spawn a fresh
// consolidator (different session_id → different deriveHandle →
// meta:consolidator_for dedupe miss), producing an unbounded chain of orphan
// `claude --bg` supervisors that survive parent death. (Observed in production
// 2026-05-13: a single test run spawned a chain of 16+ supervisors over ~10
// minutes.)
export function isConsolidatorSession(store, sessionId) {
  if (process.env.MINDWRIGHT_IS_CONSOLIDATOR === '1') return true;
  try { return store.getRoles(sessionId).includes('consolidator'); } catch { return false; }
}
