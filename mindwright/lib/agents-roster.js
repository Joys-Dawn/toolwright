// Read-only consumer of wrightward's `.claude/collab/agents.json` roster.
//
// Why a file-shape consumer and not a runtime require(): plugin
// independence (memory rule `feedback_plugins_independent.md` and
// wrightward/package.json being `"private": true` with no `exports` map)
// forbids cross-plugin imports. The roster file shape, however, is a stable
// JSON contract owned by wrightward — keys are session UUIDs, values carry
// `{ handle, registered_at, last_active }`. We read the file directly via
// `node:fs` and validate the shape on every read.
//
// Source-of-truth pointer: wrightward/lib/agents.js#readAgents (lines
// 104-110). Resolution semantics mirror wrightward/lib/handles.js#resolveAudience
// (lines 64-102) — handle → sessionId via roster scan; UUID passthrough;
// structured error on miss. Bare-name disambiguation is NOT supported here
// (a delivery audience needs full handles; mindwright's assign-role API
// requires full handles too).

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { collabDir } from './paths.js';
import { deriveHandle, HANDLE_PATTERN } from './handles.js';
import { SESSION_ID_PATTERN } from './constants.js';

// Read + parse `.claude/collab/agents.json`. Returns `{}` when the file is
// missing or unparseable — wrightward applies the same defensive default
// (see wrightward/lib/agents.js#readAgents) so mindwright matches that
// behavior for symmetry. Caller decides whether the empty roster is an
// error (assign_role with an unknown handle) or a no-op (lookup that's
// optional).
export function readRoster() {
  const path = join(collabDir(), 'agents.json');
  if (!existsSync(path)) return {};
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return {};
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  // Validate each row's shape. A row that doesn't conform (missing handle,
  // wrong type) is silently dropped so a corrupted half-row can't poison the
  // whole resolution path.
  const out = {};
  for (const [sid, row] of Object.entries(parsed)) {
    if (!sid || typeof sid !== 'string') continue;
    if (!row || typeof row !== 'object') continue;
    // wrightward writes `handle` directly; older rows might be missing it
    // (handle-field rollout happened mid-project). Treat a missing `handle`
    // as "derive on demand from sessionId" — same as wrightward's own
    // handleFor() does — so this never blocks resolution on a stale row.
    const handle = typeof row.handle === 'string' && HANDLE_PATTERN.test(row.handle)
      ? row.handle
      : deriveHandle(sid);
    out[sid] = { handle, registered_at: row.registered_at || null, last_active: row.last_active || null };
  }
  return out;
}

// Resolve `input` to a sessionId. Accepts:
//   - A UUID-shaped sessionId (path-safe identifier) — passthrough.
//   - A wrightward handle (e.g. "bob-42") — resolved via the roster.
// Returns `{ ok: true, sessionId }` on success or `{ ok: false, error,
// liveHandles }` on failure. The `liveHandles` array surfaces what's
// currently registered so the caller can echo it back to the LLM — same UX
// as wrightward's `audienceError`.
export function resolveTargetToSessionId(input) {
  if (typeof input !== 'string' || !input) {
    return { ok: false, error: 'target must be a non-empty string', liveHandles: [] };
  }

  // UUID/session-id passthrough. A path-safe identifier of any reasonable
  // length is accepted; the calling handler still re-validates via
  // SESSION_ID_PATTERN before any DB / filesystem touch.
  if (SESSION_ID_PATTERN.test(input) && !HANDLE_PATTERN.test(input)) {
    return { ok: true, sessionId: input };
  }

  // Handle lookup. Scan the roster — small N (≤ active sessions count), so a
  // linear scan is fine; building a Map per call is the same cost.
  if (HANDLE_PATTERN.test(input)) {
    const roster = readRoster();
    for (const [sid, row] of Object.entries(roster)) {
      if (row.handle === input) {
        return { ok: true, sessionId: sid };
      }
    }
    const liveHandles = Object.values(roster).map((r) => r.handle).sort();
    return {
      ok: false,
      error: `target '${input}' is not a live wrightward handle`,
      liveHandles,
    };
  }

  // Neither a UUID nor a handle. Surface the live roster so the caller can
  // see what's available.
  const liveHandles = Object.values(readRoster()).map((r) => r.handle).sort();
  return {
    ok: false,
    error: `target '${input}' is neither a UUID session_id nor a wrightward handle`,
    liveHandles,
  };
}
