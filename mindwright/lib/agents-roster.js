// Read-only consumer of wrightward's `.claude/collab/agents.json` roster.
// A file-shape consumer, not a runtime require(), because plugin
// independence forbids cross-plugin imports. The roster is a stable JSON
// contract: keys are session UUIDs, values `{ handle, registered_at,
// last_active }`; shape-validated on every read. Resolution mirrors
// wrightward: handle → sessionId via roster scan, UUID passthrough,
// structured error on miss. Bare-name disambiguation is NOT supported.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { collabDir } from './paths.js';
import { deriveHandle, HANDLE_PATTERN } from './handles.js';
import { SESSION_ID_PATTERN } from './constants.js';

// Read + parse the roster. Returns `{}` when missing/unparseable (matches
// wrightward's defensive default). Caller decides whether an empty roster is
// an error or a no-op.
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
  // Drop non-conforming rows so a corrupted half-row can't poison resolution.
  const out = {};
  for (const [sid, row] of Object.entries(parsed)) {
    if (!sid || typeof sid !== 'string') continue;
    if (!row || typeof row !== 'object') continue;
    // Missing `handle` ⇒ derive on demand (matches wrightward's handleFor())
    // so a stale row never blocks resolution.
    const handle = typeof row.handle === 'string' && HANDLE_PATTERN.test(row.handle)
      ? row.handle
      : deriveHandle(sid);
    out[sid] = { handle, registered_at: row.registered_at || null, last_active: row.last_active || null };
  }
  return out;
}

// Resolve `input` (UUID passthrough or wrightward handle) to a sessionId.
// Returns `{ ok: true, sessionId }` or `{ ok: false, error, liveHandles }`;
// liveHandles surfaces what's registered so the caller can echo it back.
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
