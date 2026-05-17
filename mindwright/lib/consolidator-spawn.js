// Detached `claude --bg` spawner for the consolidator role (a peer session
// that drains short-term and writes distilled long-term facts).
//
// `--bg` not `claude -p`: `--print`/`-p` cannot dispatch user-invoked slash
// commands; background sessions are full interactive conversations so
// /mindwright:dream dispatch works.
//
// Any synchronous spawn error (ENOENT, EPERM) returns { ok:false, error };
// callers fall back to the nudge path so there's no user-visible regression.

import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { deriveHandle } from './handles.js';
import { ROLE_PROMPTS } from './role-prompts.js';

// Half the consolidator identity key so the same requester against two repos
// doesn't share a consolidator.
function projectPathHash() {
  return createHash('sha256').update(process.cwd(), 'utf8').digest('hex').slice(0, 12);
}

// Record keyed by requester_handle alone (not project): cross-project
// collisions are prevented by deriveHandle's UUID dependency (different
// session UUID → different handle → different meta-key), so the project hash
// is a salt, not a literal disambiguator in the key.
function readOrCreateRecord(store, requesterHandle) {
  const existing = store.getConsolidatorFor(requesterHandle);
  if (existing && existing.session_id) return existing;
  const fresh = {
    session_id: randomUUID(),
    first_seen: new Date().toISOString(),
    project_hash: projectPathHash(),
  };
  store.setConsolidatorFor(requesterHandle, fresh);
  return fresh;
}

// MINDWRIGHT_SPAWN_FAKE replaces the `claude` binary path so tests can
// simulate the spawn without a real CLI install.
function binaryPath() {
  return process.env.MINDWRIGHT_SPAWN_FAKE || 'claude';
}

// MINDWRIGHT_IS_CONSOLIDATOR=1 is the self-spawn sentinel (read via
// isConsolidatorSession): a consolidator session must not spawn another.
// Without it, each spawn gets a fresh session_id → different handle →
// meta:consolidator_for dedupe misses → unbounded chain of orphan `claude
// --bg` supervisors that survive parent death.
export const CONSOLIDATOR_SPAWN_ENV_OVERRIDES = Object.freeze({
  MINDWRIGHT_IS_CONSOLIDATOR: '1',
});

// Synchronous fire-and-forget — does not block on the consolidator's
// lifetime. `reason` is logging only.
export function spawnConsolidator({ requesterHandle, reason, store }) {
  // MINDWRIGHT_SPAWN_DISABLE=1 opts out; ok:false makes the caller fall back
  // to the nudge path.
  if (process.env.MINDWRIGHT_SPAWN_DISABLE === '1') {
    return { ok: false, error: 'spawn disabled via MINDWRIGHT_SPAWN_DISABLE', reason };
  }
  if (typeof requesterHandle !== 'string' || !requesterHandle) {
    return { ok: false, error: 'spawnConsolidator: requesterHandle required' };
  }
  if (!store || typeof store.getConsolidatorFor !== 'function') {
    return { ok: false, error: 'spawnConsolidator: store with getConsolidatorFor/setConsolidatorFor required' };
  }

  const record = readOrCreateRecord(store, requesterHandle);
  const sessionId = record.session_id;
  const handle = deriveHandle(sessionId);

  // Assign 'consolidator' BEFORE launching: dream branches on
  // getRoles(sessionId).includes('consolidator'); without it dream defaults to
  // scope:"session" and the consolidator's own session has no rows, so it
  // drains nothing. Idempotent (Set dedupes on re-spawn).
  const existingRoles = store.getRoles(sessionId);
  if (!existingRoles.includes('consolidator')) {
    store.setRoles(sessionId, [...new Set([...existingRoles, 'consolidator'])]);
  }

  const args = [
    '--bg',
    '--session-id', sessionId,
    '--permission-mode', 'acceptEdits',
    '--append-system-prompt', ROLE_PROMPTS.consolidator,
    '/mindwright:dream',
  ];

  let child;
  try {
    child = spawn(binaryPath(), args, {
      detached: true,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      env: { ...process.env, ...CONSOLIDATOR_SPAWN_ENV_OVERRIDES },
    });
  } catch (err) {
    return {
      ok: false,
      error: `spawn failed: ${(err && err.message) || String(err)}`,
      reason,
    };
  }

  // Best-effort drain of the first stdout line; not awaited. Spawn is
  // considered successful even if the line never arrives (last_spawn carries
  // the spawn timestamp, not the supervisor-ack timestamp).
  try {
    if (child.stdout) {
      child.stdout.setEncoding('utf8');
      let captured = '';
      const onData = (chunk) => {
        captured += chunk;
        if (captured.includes('\n')) {
          try { child.stdout.removeListener('data', onData); } catch { /* */ }
          try { child.stdout.unref(); } catch { /* */ }
        }
      };
      child.stdout.on('data', onData);
      // If no data ever arrives, unref after 2s so the parent doesn't keep the
      // stdout stream alive forever.
      const tid = setTimeout(() => {
        try { child.stdout.removeListener('data', onData); } catch { /* */ }
        try { child.stdout.unref(); } catch { /* */ }
      }, 2000);
      if (typeof tid.unref === 'function') tid.unref();
    }
  } catch {
    /* best-effort; we still consider the spawn ok */
  }

  // Persist last_spawn; the spread preserves first_seen/project_hash.
  const now = new Date().toISOString();
  store.setConsolidatorFor(requesterHandle, {
    ...record,
    last_spawn: now,
  });

  // Unref so the parent doesn't wait on the detached child.
  try { child.unref(); } catch { /* */ }

  return {
    ok: true,
    sessionId,
    handle,
    pid: child.pid,
    reason,
    record: { ...record, last_spawn: now },
  };
}
