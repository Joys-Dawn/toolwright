// Consolidator self-spawn guard for the Stop hook: recognizes "this session is
// itself a consolidator" so handleCapCheck does not spawn a consolidator from
// inside a consolidator (which would produce an unbounded chain of orphan
// `claude --bg` supervisors).
//
// Two signals, either sufficient. PRIMARY: the MINDWRIGHT_IS_CONSOLIDATOR='1'
// env sentinel set on every detached consolidator spawn — env inherits down
// the supervisor chain so the session sees it on every hook. SECONDARY: the
// role set, for sessions where assign_role consolidator was explicitly invoked.
export function isConsolidatorSession(store, sessionId) {
  if (process.env.MINDWRIGHT_IS_CONSOLIDATOR === '1') return true;
  try { return store.getRoles(sessionId).includes('consolidator'); } catch { return false; }
}
