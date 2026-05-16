// Detached `claude --bg` spawner for the consolidator role.
//
// The consolidator is a peer Claude Code session whose only job is to drain
// short-term memory and write distilled long-term facts. It runs in the
// background under Claude Code's supervisor (the `--bg` flag) and dispatches
// the `/mindwright:dream` skill as its prompt.
//
// Identity is keyed by `(project_path_hash, requester_handle)`. The same
// requester+project pair always resolves to the same consolidator UUID,
// persisted under meta:consolidator_for:<requester_handle>. We store ONLY
// the UUID; the wrightward handle is recomputed via deriveHandle on demand.
//
// Why `--bg` and not `claude -p`: per
// https://code.claude.com/docs/en/headless, `--print`/`-p` cannot dispatch
// user-invoked slash commands (the headless docs state: "User-invoked
// skills like /commit and built-in commands are only available in
// interactive mode"). Background sessions ARE full interactive Claude
// Code conversations under a supervisor, so slash-command dispatch works.
//
// Failure mode: any synchronous error from child_process.spawn (ENOENT
// because `claude` isn't on PATH, EPERM, etc.) returns
// { ok: false, error: <message> }. The caller (hooks/stop.js or the
// assign-role handler) falls back to the old nudge path on a false ok so
// there's no regression from the user's POV.

import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { deriveHandle } from './handles.js';
import { ROLE_PROMPTS } from './role-prompts.js';

// Project-path hash. Used as one half of the consolidator identity key so
// the same requester running against two different repos doesn't share a
// consolidator. 12-hex-char prefix of sha256 — same length wrightward uses
// for short identifiers; collision probability negligible.
function projectPathHash() {
  return createHash('sha256').update(process.cwd(), 'utf8').digest('hex').slice(0, 12);
}

// Read the existing record for (project, requester) or mint a fresh one.
// The record is { session_id, first_seen, last_spawn? } JSON-encoded under
// meta:consolidator_for:<requester_handle>. We KEY the record by
// requester_handle alone (not project) because the store helper takes one
// key; cross-project collisions are prevented by deriveHandle's UUID
// dependency (each session has a different UUID, so its handle is different,
// so the meta-key is different). The project hash is therefore a "salt" we
// embed into the requester handle's namespace by way of cwd at lookup time,
// not a literal disambiguator in the meta key.
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

// `MINDWRIGHT_SPAWN_FAKE` env var test injection. When set, replaces the
// `claude` binary path so tests can simulate the spawn without a real CLI
// install. The fake binary is expected to write a synthetic session-id
// line to stdout and exit; the spawner reads that line just like it would
// from real `claude --bg`.
function binaryPath() {
  return process.env.MINDWRIGHT_SPAWN_FAKE || 'claude';
}

// Env overrides injected into every spawned consolidator subprocess.
// MINDWRIGHT_IS_CONSOLIDATOR=1 is the self-spawn sentinel that the Stop
// hook reads to recognize "this session is itself a consolidator — do not
// spawn another, do not stage a self-nudge." Without this, every Stop in
// a consolidator session spawns a fresh consolidator (different
// session_id → different deriveHandle → meta:consolidator_for dedupe
// misses), producing an unbounded chain of orphan `claude --bg`
// supervisors that survive parent death.
//
// Exported as a frozen object so tests can assert the sentinel exists
// without having to introspect the spawned process's env (which Node does
// not expose on ChildProcess after spawn).
export const CONSOLIDATOR_SPAWN_ENV_OVERRIDES = Object.freeze({
  MINDWRIGHT_IS_CONSOLIDATOR: '1',
});

// Main entry point. Synchronous return — the spawn is fire-and-forget; we
// do not block on the consolidator's lifetime. Returns:
//   { ok: true, sessionId, handle, pid, record }   on success
//   { ok: false, error: string }                   on synchronous failure
//
// `reason` is for logging only — included in the error path's response and
// reflected back to the caller so audit log entries can attribute the spawn.
export function spawnConsolidator({ requesterHandle, reason, store }) {
  // Explicit opt-out: users (or tests) who want the legacy nudge-only path
  // set MINDWRIGHT_SPAWN_DISABLE=1. Returning ok:false here makes the caller
  // (hooks/stop.js) fall back to staging the pending nudge message.
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

  // Assign the 'consolidator' role to the spawned session BEFORE launching it.
  // Load-bearing: the dream skill (skills/dream/SKILL.md step 2) and
  // drainBatchHandler's cross-session hint both branch on
  // store.getRoles(sessionId).includes('consolidator'). Without this write the
  // auto-spawned session's role set is empty, so dream defaults to
  // scope:"session" — and the consolidator's OWN session has no short-term
  // rows, so it would drain nothing. The explicit mindwright_assign_role path
  // already sets the role before spawning (mcp/tools.mjs assignRoleHandler);
  // the Stop-hook auto-spawn path must do the same so both routes behave
  // identically. Idempotent: a re-spawn of the same deterministic session-id
  // just re-confirms the existing role (Set dedupes).
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

  // Best-effort: read the first stdout line (the background-session-id
  // confirmation from `claude --bg`) so we can record `last_spawn` with a
  // sense of when the supervisor accepted us. If the line never arrives
  // (timeout), we still consider the spawn successful — the child has been
  // launched; we just couldn't confirm the supervisor's acceptance. Race
  // ordering: we set up the data handler BEFORE recording last_spawn, but
  // we don't await the line — last_spawn carries the spawn timestamp, not
  // the supervisor-ack timestamp.
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
      // Safety: if no data ever arrives, unref after 2s so the parent doesn't
      // keep the stdout stream alive forever.
      const tid = setTimeout(() => {
        try { child.stdout.removeListener('data', onData); } catch { /* */ }
        try { child.stdout.unref(); } catch { /* */ }
      }, 2000);
      // Don't let the timer hold the event loop open.
      if (typeof tid.unref === 'function') tid.unref();
    }
  } catch {
    /* best-effort; we still consider the spawn ok */
  }

  // Persist last_spawn so /mindwright:status shows recency. We re-read the
  // record in case the create path just minted it — the merge preserves
  // first_seen and project_hash from the record we already have.
  const now = new Date().toISOString();
  store.setConsolidatorFor(requesterHandle, {
    ...record,
    last_spawn: now,
  });

  // Unref the parent handle so the daemon doesn't wait on the child.
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
